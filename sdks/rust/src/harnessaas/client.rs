//! `HarnessaaSClient` (ADR-0027a, ADR-0019 §D2). Issue #67/#68 / M5 start.
//!
//! **Scope (2026-07-19 reconciliation audit, issue #67):** this pass covers
//! ONLY the real, deployed, SYNCHRONOUS surface of `cognitum-one/harnessaas`
//! — construction (zero I/O), `health()`, `solve()`, and `lineage()`. It
//! deliberately does NOT build against ADR-0027a's "Decision" section (an
//! async `SolveHandle`/job/poll/SSE/approval/cancel/artifact contract under
//! `/v1/solves/*`) — that is an explicit PROPOSAL for something that does
//! not exist in the running service yet (`docs/adr/0027a-*.md`'s
//! reconciliation note; `src/server.ts:367-501` at `908e4a99` is one HTTP
//! request in, one `SolveResponse` out, full stop). Also explicitly out of
//! scope this pass: the webhook admin routes, the MicroLoRA flywheel API
//! (`/microlora/*` — confirmed a SEPARATE future decision by the same
//! reconciliation audit), and the authenticated `/api/v1/*` IBO-console relay.
//!
//! **Auth:** a `cog_`-prefixed API key, sent as `X-API-Key` (preferred) or
//! `Authorization: Bearer` (verified at `src/auth.ts:1-24,256-264`) — the
//! SAME shape Meta LLM uses, so `StaticApiKeyCredentialProvider` works as-is.
//!
//! **Retry safety (ADR-0023, the Meta Proxy PR #93 lesson):** `solve()` is
//! genuinely non-idempotent from this client's point of view — no
//! `Idempotency-Key` handling of any kind exists anywhere in the upstream
//! service and there is no in-app rate limiter, so a lost response after a
//! 429/502/503/5xx/transport failure cannot be distinguished from "the
//! sandbox clone/model call/test run already started spending."
//! Automatically retrying would risk exactly the duplicate-spend/duplicate-
//! execution failure mode independent review found in Meta Proxy's
//! non-streaming forwarding (ADR-0025a, PR #93, commit `eb553f7`).
//! `solve()` therefore makes exactly ONE HTTP attempt for every outcome
//! except a verified 401 challenge (auth happens server-side BEFORE any
//! spend, so a single credential-refresh-and-retry there is provably
//! zero-spend-safe). `lineage()` is a plain `GET` (a safe read per
//! ADR-0023 §D3) and gets a bounded 429/502/503 retry; `health()` is a
//! single unauthenticated `GET` with no retry loop, matching
//! `MetaLlmClient::health()`'s pattern.

use std::collections::HashMap;
use std::time::Duration;

use crate::agentic::{
    AgenticError, AgenticErrorKind, CapabilitySet, RetryPolicy, UnsupportedCapabilityError,
    equal_jitter_delay_ms,
};

use super::config::{resolve_config, HarnessaaSClientConfig};
use super::discovery::{parse_harnessaas_health, HarnessaaSHealth};
use super::envelope::HarnessaaSResult;
use super::types::{
    parse_lineage_result, parse_solve_response, HarnessaaSLineageResult, HarnessaaSSolveRequest,
    HarnessaaSSolveResponse, HarnessaaSVertical,
};

pub(super) const PRODUCT: &str = "harnessaas";
const DEFAULT_CAPABILITY_VERSION: &str = "0.0.0";
const DEFAULT_VERTICAL: HarnessaaSVertical = HarnessaaSVertical::CodeRepair;

/// Feature key for the base `solve` operation (ADR-0019 §D6). A
/// caller-supplied `capabilities_snapshot` for an unrecognized/future
/// HarnessaaS version that omits this key is treated as unknown/unsupported,
/// never as "assume supported" — see [`HarnessaaSClient::solve`].
const SOLVE_FEATURE: &str = "solve";

/// Feature key for the `lineage` read. Defense in depth only: `lineage()` is
/// a safe read and is not one of ADR-0019 §D6's five gated categories
/// (mutation, spend, consent, installation, code execution), so this flag
/// being false/absent is a soft signal, not itself mandated by the ADR.
const LINEAGE_FEATURE: &str = "lineage";

/// Per-vertical feature key for `solve()` (ADR-0011's `vertical` field, this
/// module's own `HarnessaaSVertical` type). Only `code-repair` is modeled by
/// this SDK pass — `super::types`'s doc comment explains that the other
/// three verticals each require a compound request field
/// (`finding`/`scanner_command`, `migration`/`build_command`,
/// `test_generation`/`coverage_command`) this client does not build or
/// serialize. Sending one of those verticals without its compound field is
/// real, currently-reachable misuse (a caller can set
/// `vertical: Some(HarnessaaSVertical::SecurityRemediation)` today and this
/// client would happily POST an incomplete request), so this is the genuine
/// capability dimension `solve()` gates on locally — not a vacuous
/// always-true check.
fn solve_vertical_feature(vertical: HarnessaaSVertical) -> String {
    let name = match vertical {
        HarnessaaSVertical::CodeRepair => "code-repair",
        HarnessaaSVertical::SecurityRemediation => "security-remediation",
        HarnessaaSVertical::DependencyMigration => "dependency-migration",
        HarnessaaSVertical::TestGeneration => "test-generation",
    };
    format!("solve.vertical.{name}")
}

/// The only capability snapshot this SDK can vouch for without a published
/// runtime capabilities endpoint (ADR-0019 §D6: "the SDK may use a
/// checked-in compatibility table keyed by exact tested version"). Verified
/// against `cognitum-one/harnessaas@908e4a99`: `solve` (code-repair vertical
/// only) and `lineage` are the two confirmed-working synchronous
/// operations; the other three verticals are explicitly NOT modeled this
/// pass and MUST NOT be treated as supported.
fn default_capability_snapshot() -> CapabilitySet {
    let mut features = HashMap::new();
    features.insert(SOLVE_FEATURE.to_owned(), true);
    features.insert(LINEAGE_FEATURE.to_owned(), true);
    features.insert(solve_vertical_feature(HarnessaaSVertical::CodeRepair), true);
    features.insert(solve_vertical_feature(HarnessaaSVertical::SecurityRemediation), false);
    features.insert(solve_vertical_feature(HarnessaaSVertical::DependencyMigration), false);
    features.insert(solve_vertical_feature(HarnessaaSVertical::TestGeneration), false);
    CapabilitySet {
        product: PRODUCT.to_owned(),
        product_version: DEFAULT_CAPABILITY_VERSION.to_owned(),
        protocol: "cognitum.harnessaas.http".to_owned(),
        protocol_version: "1.0".to_owned(),
        features,
        limitations: vec![
            "solve() is verified only for the code-repair vertical; security-remediation, \
             dependency-migration, and test-generation each require a compound request field \
             (finding/scanner_command, migration/build_command, test_generation/coverage_command \
             respectively) this SDK pass does not model, so those verticals are not locally \
             supported even though the server may accept them"
                .to_owned(),
        ],
        auth_methods: vec!["X-API-Key".to_owned(), "Authorization: Bearer".to_owned()],
        source: crate::agentic::CapabilitySource::StaticCompatibilityTable,
    }
}

/// Client for the real, deployed, synchronous HarnessaaS surface
/// (ADR-0027a). Construction performs no I/O (ADR-0019 §D3). Never
/// composes Meta LLM, Meta Proxy, or MetaHarness (ADR-0019 §D4).
#[derive(Debug)]
pub struct HarnessaaSClient {
    pub(super) config: HarnessaaSClientConfig,
    pub(super) http: reqwest::Client,
}

impl HarnessaaSClient {
    /// Construct a client. Validates configuration only — no I/O.
    #[allow(clippy::result_large_err)]
    pub fn new(config: HarnessaaSClientConfig) -> Result<Self, AgenticError> {
        let resolved = resolve_config(config)?;
        let http = resolved.transport.clone().unwrap_or_default();
        Ok(Self { config: resolved, http })
    }

    /// Read-only view of the effective configuration.
    pub fn config(&self) -> &HarnessaaSClientConfig {
        &self.config
    }

    /// Versioned behavior safe for this caller, from the static
    /// compatibility snapshot (no I/O). Unknown server versions receive
    /// the intersection of proven-safe capabilities, never the union
    /// (ADR-0019 §D6).
    pub fn capabilities(&self) -> CapabilitySet {
        self.config
            .capabilities_snapshot
            .clone()
            .unwrap_or_else(default_capability_snapshot)
    }

    /// Fail closed BEFORE any HTTP call if the resolved capability set (an
    /// operator-supplied `capabilities_snapshot`, or this SDK's own
    /// known-tested default) does not affirmatively mark `solve` and the
    /// requested `vertical` as supported (ADR-0019 §D6). `solve()` is
    /// simultaneously a mutation, a spend trigger, and — given HarnessaaS's
    /// untrusted-repository/command-execution trust boundary — a
    /// code-execution trigger, so an unknown or unsupported capability MUST
    /// be rejected locally rather than reaching the network.
    #[allow(clippy::result_large_err)]
    fn assert_solve_capability(&self, vertical: HarnessaaSVertical) -> Result<(), AgenticError> {
        let caps = self.capabilities();
        if caps.features.get(SOLVE_FEATURE) != Some(&true) {
            return Err(UnsupportedCapabilityError::new(PRODUCT, "solve", SOLVE_FEATURE).into());
        }
        let vertical_feature = solve_vertical_feature(vertical);
        if caps.features.get(&vertical_feature) != Some(&true) {
            return Err(
                UnsupportedCapabilityError::new(PRODUCT, "solve", vertical_feature).into()
            );
        }
        Ok(())
    }

    /// `GET /health` — process health only, no identity/readiness
    /// semantics. Unauthenticated on the real service — never acquires a
    /// credential, even when one is configured. Single HTTP attempt, no
    /// retry loop, matching `MetaLlmClient::health()`.
    ///
    /// Calls `GET /health`, NOT `/healthz` — see `super::discovery`'s
    /// module doc comment for why `/healthz` is unreliable from outside
    /// the container on Cloud Run.
    #[allow(clippy::result_large_err)]
    pub async fn health(&self) -> Result<HarnessaaSResult<HarnessaaSHealth>, AgenticError> {
        let (data, meta) = self.send_get_once("/health", "health", None).await?;
        Ok(HarnessaaSResult { data: parse_harnessaas_health(&data), meta })
    }

    /// `POST /solve` — genuinely synchronous: one HTTP request, one full
    /// `SolveResponse` back inline. See this module's doc comment for why
    /// this makes exactly one HTTP attempt for every outcome except a
    /// verified 401 — 429/502/503/5xx/transport failures are NEVER
    /// retried automatically.
    ///
    /// This pass does not perform local ADR-0022 §D5 scope preflight:
    /// unlike Meta LLM/Meta Proxy's single required-scope-string
    /// convention, the real server-side authorization is a tier-ladder
    /// CAP over multiple alternative scopes (any of
    /// `completions:low`/`mid`/`high` lets a solve proceed, just at a
    /// capped tier — `src/auth.ts`'s `authorizeGenome`), which this client
    /// does not replicate client-side. The server remains authoritative;
    /// a 403 surfaces as `PermissionDenied`.
    #[allow(clippy::result_large_err)]
    pub async fn solve(
        &self,
        request: &HarnessaaSSolveRequest,
    ) -> Result<HarnessaaSResult<HarnessaaSSolveResponse>, AgenticError> {
        self.assert_solve_capability(request.vertical.unwrap_or(DEFAULT_VERTICAL))?;
        let body = serde_json::to_value(request).map_err(|cause| {
            AgenticError::new(AgenticErrorKind::Validation, format!("solve request failed to serialize: {cause}"))
                .with_product_operation_solve()
        })?;

        let mut credential = self.require_credential("solve").await?;
        let mut refreshed_once = false;

        loop {
            match self.send_post_once("/solve", "solve", &body, &credential).await {
                Ok((data, meta)) => {
                    return Ok(HarnessaaSResult { data: parse_solve_response(&data), meta });
                }
                Err(err) => {
                    if err.status == Some(401) && !refreshed_once {
                        refreshed_once = true;
                        if let Some(provider) = self.config.credential_provider.as_ref() {
                            provider.invalidate("401 challenge from harnessaas").await;
                        }
                        credential = self.require_credential("solve").await?;
                        continue;
                    }
                    // Every other outcome — 429/502/503/5xx/transport
                    // included — is a single terminal error. No
                    // idempotency-key contract exists server-side, so a
                    // retry here risks duplicate untrusted-repository
                    // execution and duplicate model spend (the exact Meta
                    // Proxy PR #93 failure mode).
                    return Err(err);
                }
            }
        }
    }

    /// `GET /lineage/:id` — a safe read (ADR-0023 §D3), so bounded
    /// 429/502/503 retry is appropriate here, unlike `solve()`. A
    /// `request_id` from another tenant collapses to the same 404 as an
    /// absent one (anti-enumeration).
    #[allow(clippy::result_large_err)]
    pub async fn lineage(&self, request_id: &str) -> Result<HarnessaaSResult<HarnessaaSLineageResult>, AgenticError> {
        if request_id.is_empty() {
            return Err(AgenticError::new(AgenticErrorKind::Validation, "lineage request_id is required")
                .with_product_operation_lineage());
        }
        // Defense in depth only (see `LINEAGE_FEATURE`'s doc comment above):
        // `lineage()` is a safe read, not one of ADR-0019 §D6's five gated
        // categories, but gating it too keeps "unknown version" handling
        // uniform if a future capabilities_snapshot narrows what a given
        // HarnessaaS version's response shape supports.
        if self.capabilities().features.get(LINEAGE_FEATURE) != Some(&true) {
            return Err(UnsupportedCapabilityError::new(PRODUCT, "lineage", LINEAGE_FEATURE).into());
        }
        let path = format!("/lineage/{}", urlencode(request_id));
        let mut credential = self.require_credential("lineage").await?;
        let mut refreshed_once = false;
        let retry_policy = RetryPolicy::default();
        let mut attempt: u32 = 0;
        let mut sleep_budget_used_ms: u64 = 0;

        loop {
            match self.send_get_once(&path, "lineage", Some(&credential)).await {
                Ok((data, meta)) => {
                    return Ok(HarnessaaSResult { data: parse_lineage_result(&data), meta });
                }
                Err(err) => {
                    if err.status == Some(401) && !refreshed_once {
                        refreshed_once = true;
                        if let Some(provider) = self.config.credential_provider.as_ref() {
                            provider.invalidate("401 challenge from harnessaas").await;
                        }
                        credential = self.require_credential("lineage").await?;
                        continue;
                    }
                    let is_bounded_retryable = matches!(err.status, Some(429) | Some(502) | Some(503));
                    if is_bounded_retryable && attempt + 1 < retry_policy.max_attempts {
                        let server_hint_ms = err.retry_after_ms.unwrap_or(0);
                        let jitter_ms = (rand_jitter() * retry_policy.base_ms as f64) as u64;
                        let delay_ms = equal_jitter_delay_ms(attempt, &retry_policy, server_hint_ms, jitter_ms);
                        if sleep_budget_used_ms + delay_ms > retry_policy.retry_sleep_budget_ms {
                            return Err(err);
                        }
                        sleep_budget_used_ms += delay_ms;
                        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                        attempt += 1;
                        continue;
                    }
                    return Err(err);
                }
            }
        }
    }

    /// Close local connections and wait only. Never cancels a remote
    /// solve — there is no remote job to cancel (`POST /solve` has
    /// already returned by the time this client hands back a result).
    /// `reqwest::Client` has no explicit close/drain step, so this is a
    /// no-op reserved for a future transport that needs one.
    pub async fn close(&self) {}
}

/// Minimal percent-encoding for a `lineage` path segment. The `url` crate
/// is only an optional dependency of the `seed`/`mdns` features, not
/// `harnessaas` alone, so this stays a small self-contained encoder.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Simple `[0, 1)` PRNG for jitter — avoids pulling in the `rand` crate for
/// one non-cryptographic backoff jitter value, matching the style already
/// used elsewhere in this crate for non-security-sensitive randomness.
fn rand_jitter() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    (nanos % 1_000_000) as f64 / 1_000_000.0
}

// Small local helpers so error construction below can attach
// product/operation without repeating struct-update syntax at each call site.
trait WithProductOperationSolve {
    fn with_product_operation_solve(self) -> Self;
}
impl WithProductOperationSolve for AgenticError {
    fn with_product_operation_solve(mut self) -> Self {
        self.product = Some(PRODUCT.to_owned());
        self.operation = Some("solve".to_owned());
        self
    }
}
trait WithProductOperationLineage {
    fn with_product_operation_lineage(self) -> Self;
}
impl WithProductOperationLineage for AgenticError {
    fn with_product_operation_lineage(mut self) -> Self {
        self.product = Some(PRODUCT.to_owned());
        self.operation = Some("lineage".to_owned());
        self
    }
}
