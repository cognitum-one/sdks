//! `MetaHarnessClient` (ADR-0026a). Issue #64 / M4 start.
//!
//! This pass implements exactly §D1 (construction — zero I/O) and the §D2
//! public method SIGNATURES, every one of which is a fail-closed stub that
//! returns `Err(UnsupportedCapabilityError.into())` BEFORE any process,
//! network, or filesystem access.
//!
//! §D7 states the reason directly: the OSS `metaharness` package has no
//! published `bridge --stdio` protocol (or any versioned machine contract)
//! this client could talk to yet. Seven concrete blockers are listed:
//!
//! 1. reviewed 0.4.1 is not published at the registry state;
//! 2. no versioned JSONL bridge covers the SDK operations;
//! 3. package/generator/template versions disagree and output/cancel is
//!    nonuniform;
//! 4. `from-repo` is mutable and unresolved variables do not fail by
//!    default;
//! 5. witness docs, runtime shape, verification, and publish claims
//!    disagree;
//! 6. wrapper result/dependency is stale and private CLI collides/
//!    process-exits;
//! 7. external-template and full-eject flags overstate implemented
//!    behavior.
//!
//! Until these close, "a released SDK may offer only a feature-flagged,
//! read-only development preview" (§D7) — which is not yet the case here:
//! every operational method fails closed, full stop. This mirrors how
//! `crate::meta_proxy::client::MetaProxyClient`'s M3-start pass declared
//! ONLY `status`/`capabilities` as real methods and omitted everything else
//! — except here essentially the ENTIRE §D2 surface is blocked (even
//! `capabilities()` itself: there is no bridge `hello` handshake to answer
//! it), so every method is declared as a stub rather than omitted, per this
//! ADR's explicit instruction that the shape be visible while blocked.
//!
//! Construction mirrors `MetaProxyClient`'s conventions exactly (`crate::
//! meta_proxy::client`): a resolved config struct and the same
//! telemetry-hook shape. §D1's browser-runtime rejection is N/A for this
//! crate: Rust has no wasm32/browser target for the `metaharness` feature
//! (see `Cargo.toml`'s `[features]`), so there is nothing to guard.
//!
//! Explicitly out of scope this pass (do not attempt): any real npm package
//! acquisition/version checking (ADR-0026b), any actual child-process spawn
//! or JSON-Lines bridge communication, any real scaffold/analyze/score/
//! witness-verify logic, and the optional `MetaHarnessProxyLifecycleProvider`
//! adapter (needs ADR-0025b, not started).

use crate::agentic::{AgenticError, AgenticErrorKind, CapabilitySet};

use super::config::{resolve_config, MetaHarnessConfig};
use super::types::{
    ApplyApproval, HarnessComparisonResult, HarnessManifest, HarnessValidationResult,
    HostDescriptor, RepositoryAnalysis, RepositoryScore, RepositorySource, ScaffoldPlan,
    ScaffoldRequestV1, ScaffoldResult, TemplateDescriptor, WitnessVerification,
    WorkspaceOrWitness,
};

const PRODUCT: &str = "metaharness";

/// One row of the ADR-0026a §D7 capability table, cited verbatim in every
/// stub's returned error so a caller sees exactly which upstream
/// capability is missing and why, rather than a generic "not implemented".
struct BlockedOperation {
    capability: &'static str,
    blockers: &'static str,
}

fn blocked(operation: &str) -> BlockedOperation {
    match operation {
        "capabilities" => BlockedOperation {
            capability: "metaharness.bridge.hello",
            blockers: "blockers #1 (\"reviewed 0.4.1 is not published at the registry state\") \
                and #2 (\"no versioned JSONL bridge covers the SDK operations\") — there is no \
                `hello` handshake to answer this call, so even capability discovery itself is \
                blocked",
        },
        "list_templates" => BlockedOperation {
            capability: "metaharness.catalog.templates",
            blockers: "blocker #2 (\"no versioned JSONL bridge covers the SDK operations\")",
        },
        "list_hosts" => BlockedOperation {
            capability: "metaharness.catalog.hosts",
            blockers: "blocker #2 (\"no versioned JSONL bridge covers the SDK operations\")",
        },
        "analyze_repository" => BlockedOperation {
            capability: "metaharness.repository.analyze",
            blockers: "blockers #1 (\"reviewed 0.4.1 is not published at the registry state\") \
                and #2 (\"no versioned JSONL bridge covers the SDK operations\")",
        },
        "score_repository" => BlockedOperation {
            capability: "metaharness.repository.score",
            blockers: "blockers #1 (\"reviewed 0.4.1 is not published at the registry state\") \
                and #2 (\"no versioned JSONL bridge covers the SDK operations\")",
        },
        "plan_scaffold" => BlockedOperation {
            capability: "metaharness.scaffold.plan",
            blockers: "blocker #2 (\"no versioned JSONL bridge covers the SDK operations\") and \
                #3 (\"package/generator/template versions disagree and output/cancel is \
                nonuniform\")",
        },
        "scaffold" => BlockedOperation {
            capability: "metaharness.scaffold.render",
            blockers: "blocker #2 (\"no versioned JSONL bridge covers the SDK operations\") and \
                #4 (\"`from-repo` is mutable and unresolved variables do not fail by default\") \
                — plus ADR-0026b's integrity/commit-mode/recovery gates, none of which exist yet",
        },
        "inspect_manifest" => BlockedOperation {
            capability: "metaharness.manifest.inspect",
            blockers: "blockers #2 (\"no versioned JSONL bridge covers the SDK operations\") and \
                #3 (\"package/generator/template versions disagree\")",
        },
        "validate_harness" => BlockedOperation {
            capability: "metaharness.harness.validate",
            blockers: "blocker #2 (\"no versioned JSONL bridge covers the SDK operations\")",
        },
        "compare_harnesses" => BlockedOperation {
            capability: "metaharness.harness.compare",
            blockers: "blocker #2 (\"no versioned JSONL bridge covers the SDK operations\")",
        },
        "verify_witness" => BlockedOperation {
            capability: "metaharness.witness.shape",
            blockers: "blocker #5 (\"witness docs, runtime shape, verification, and publish \
                claims disagree\") — no requested verification level (shape, digest, \
                cryptographic, or anchored) can be honored yet",
        },
        other => unreachable!("unknown MetaHarnessClient operation: {other}"),
    }
}

/// Construct the fail-closed error every blocked §D2 method returns.
///
/// This crate's `UnsupportedCapabilityError` (`crate::agentic::errors`) has
/// a fixed, thiserror-derived message template with no room for a
/// per-operation §D7 blocker citation, so this builds `AgenticError`
/// directly with `kind: UnsupportedCapability` instead of routing through
/// that wrapper — the same `kind`, `product`, `operation`, and
/// `retryable: false` shape `UnsupportedCapabilityError`'s own
/// `From<UnsupportedCapabilityError> for AgenticError` impl produces
/// (`crate::agentic::errors`), plus the exact missing capability name
/// carried in `code` for programmatic matching and the full §D7 blocker
/// citation in `message` for humans.
#[allow(clippy::result_large_err)]
fn not_yet_available<T>(operation: &str) -> Result<T, AgenticError> {
    let b = blocked(operation);
    let message = format!(
        "MetaHarnessClient.{operation} is not yet available: the OSS MetaHarness bridge \
         protocol this method requires (\"{cap}\") does not exist upstream yet (ADR-0026a §D7 \
         — {blockers}). This method fails closed before any process, network, or filesystem \
         access; until all seven §D7 blockers close, a released SDK may offer at most a \
         feature-flagged, read-only development preview, which this pass does not yet ship.",
        cap = b.capability,
        blockers = b.blockers,
    );
    Err(AgenticError {
        kind: AgenticErrorKind::UnsupportedCapability,
        message,
        product: Some(PRODUCT.to_owned()),
        operation: Some(operation.to_owned()),
        status: None,
        code: Some(b.capability.to_owned()),
        request_id: None,
        correlation_id: None,
        protocol_version: None,
        retryable: false,
        retry_after_ms: None,
        attempt_count: None,
        details: None,
        cause: None,
    })
}

/// Client for the OSS MetaHarness local generator/verifier, backed by a
/// versioned JSON Lines process bridge that does not exist upstream yet
/// (ADR-0026a). `MetaHarnessClient` never composes Meta LLM, Meta Proxy,
/// HarnessaaS, or the private commercial `@cognitum-one/metaharness` CLI
/// (§D1) — it is the OSS generator's bounded-context client, full stop.
///
/// Every method is `blocked` maturity this pass (ADR-0026a §D7: "Until
/// blockers 1 through 7 close, a released SDK may offer only a
/// feature-flagged, read-only development preview"). Construction never
/// starts, installs, authenticates, probes, or reconfigures a process (§D1).
#[derive(Debug)]
pub struct MetaHarnessClient {
    config: MetaHarnessConfig,
}

impl MetaHarnessClient {
    /// Construct a client. Validates configuration only — no I/O.
    #[allow(clippy::result_large_err)]
    pub fn new(config: MetaHarnessConfig) -> Result<Self, AgenticError> {
        let resolved = resolve_config(config)?;
        Ok(Self { config: resolved })
    }

    /// Read-only view of the effective configuration.
    pub fn config(&self) -> &MetaHarnessConfig {
        &self.config
    }

    /// Versioned behavior safe for this caller (ADR-0026a §D2). Blocked
    /// this pass: there is no bridge `hello` handshake (§D4) to answer it,
    /// so even capability discovery fails closed rather than guessing.
    #[allow(clippy::result_large_err)]
    pub async fn capabilities(&self) -> Result<CapabilitySet, AgenticError> {
        not_yet_available("capabilities")
    }

    /// Catalog of source-defined templates (ADR-0026a §D2, Context: "20
    /// source-defined templates").
    #[allow(clippy::result_large_err)]
    pub async fn list_templates(&self) -> Result<Vec<TemplateDescriptor>, AgenticError> {
        not_yet_available("list_templates")
    }

    /// Catalog of source-defined hosts (ADR-0026a §D2, Context: "nine
    /// source-defined hosts").
    #[allow(clippy::result_large_err)]
    pub async fn list_hosts(&self) -> Result<Vec<HostDescriptor>, AgenticError> {
        not_yet_available("list_hosts")
    }

    /// Immutable analysis of a repository (ADR-0026a §D2, §D7).
    #[allow(clippy::result_large_err)]
    pub async fn analyze_repository(
        &self,
        source: &RepositorySource,
    ) -> Result<RepositoryAnalysis, AgenticError> {
        let _ = source;
        not_yet_available("analyze_repository")
    }

    /// Immutable scoring of a repository (ADR-0026a §D2, §D7).
    #[allow(clippy::result_large_err)]
    pub async fn score_repository(
        &self,
        source: &RepositorySource,
    ) -> Result<RepositoryScore, AgenticError> {
        let _ = source;
        not_yet_available("score_repository")
    }

    /// Non-mutating scaffold planning (ADR-0026a §D2: "`plan_scaffold` is
    /// non-mutating"). Still blocked — planning requires the same
    /// unpublished bridge as every other operation.
    #[allow(clippy::result_large_err)]
    pub async fn plan_scaffold(
        &self,
        request: &ScaffoldRequestV1,
    ) -> Result<ScaffoldPlan, AgenticError> {
        let _ = request;
        not_yet_available("plan_scaffold")
    }

    /// Apply a still-valid `ScaffoldPlan` with matching `ApplyApproval`
    /// (ADR-0026a §D2). No `force`, no plan-and-apply convenience — the ADR
    /// explicitly forbids eroding the plan/apply review boundary. Blocked
    /// pending ADR-0026b's commit/cancel/recovery gates in addition to the
    /// bridge itself.
    #[allow(clippy::result_large_err)]
    pub async fn scaffold(
        &self,
        plan: &ScaffoldPlan,
        approval: &ApplyApproval,
    ) -> Result<ScaffoldResult, AgenticError> {
        let _ = (plan, approval);
        not_yet_available("scaffold")
    }

    /// Inspect an existing harness manifest (ADR-0026a §D2, §D3).
    #[allow(clippy::result_large_err)]
    pub async fn inspect_manifest(
        &self,
        target: &RepositorySource,
    ) -> Result<HarnessManifest, AgenticError> {
        let _ = target;
        not_yet_available("inspect_manifest")
    }

    /// Validate an existing harness against its manifest (ADR-0026a §D2).
    #[allow(clippy::result_large_err)]
    pub async fn validate_harness(
        &self,
        target: &RepositorySource,
    ) -> Result<HarnessValidationResult, AgenticError> {
        let _ = target;
        not_yet_available("validate_harness")
    }

    /// Compare two harnesses (ADR-0026a §D2).
    #[allow(clippy::result_large_err)]
    pub async fn compare_harnesses(
        &self,
        a: &RepositorySource,
        b: &RepositorySource,
    ) -> Result<HarnessComparisonResult, AgenticError> {
        let _ = (a, b);
        not_yet_available("compare_harnesses")
    }

    /// Verify a witness at the requested level (ADR-0026a §D2, §D6).
    /// Accepts either a fresh `RepositorySource` to verify from scratch, or
    /// an existing `WitnessVerification` to re-verify/escalate — matching
    /// Node/Python's `workspaceOrWitness: RepositorySource |
    /// WitnessVerification` union (issue #102). Blocked for every level —
    /// even `shape`, the weakest, requires the bridge/kernel this pass does
    /// not have (§D7 blocker #5).
    #[allow(clippy::result_large_err)]
    pub async fn verify_witness(
        &self,
        workspace_or_witness: &WorkspaceOrWitness,
    ) -> Result<WitnessVerification, AgenticError> {
        let _ = workspace_or_witness;
        not_yet_available("verify_witness")
    }

    /// Cancel only processes owned by this client (ADR-0026a §D2: "Closing
    /// a client cancels only processes owned by that client. It does not
    /// cancel a HarnessaaS job, stop Meta Proxy, or kill a separately
    /// launched MetaHarness CLI."). A real no-op this pass: no bridge
    /// process is ever spawned by any method above, so there is nothing to
    /// release.
    pub async fn close(&self) {
        // No process is ever started by this pass's stubs — nothing to
        // cancel or release. Reserved for the real bridge-process lifecycle
        // once one exists (ADR-0026a §D4, ADR-0026b).
    }
}
