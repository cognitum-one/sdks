# ADR 0014b: Rust SDK Implementation — Retry & Auth

<!-- swarm-seed-validation 2026-04-22 (rust agent): Phase 1 ✅ partial.
     Cloud `src/client.rs` now sends X-API-Key (pre-fix agent). Seed half
     `src/seed/retry.rs` implements equal-jitter + Retry-After (header +
     `retry_after_us` + english fallback) per §6; `src/seed/client.rs`
     owns the retry loop. OQ-1 CLOSED. Full `RetryPolicy` struct per §6.1
     is still Phase 1.5 — seed client exposes `.max_retries(n)` instead. -->

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** SDK WG (Rust lead + cross-cutting)
- **Scope:** sdks/rust

> Continuation of 0014d (wire types, errors, transport). Covers §§6–7 of
> the implementation ADR: retry/backoff (ADR-0005) and auth + credential
> redaction (ADR-0003 + ADR-0007). Successor: 0014e (streaming, tests,
> packaging).

## Context

Existing retry code lives at
`/home/ruvultra/projects/sdks/sdks/rust/src/client.rs:146-215`, uses pure exponential
backoff (`500 * 2^(attempt-1)`) with no jitter, only honors `Retry-After`
in seconds, and retries only `{429, 500, 503}`. Existing auth lives at
`/home/ruvultra/projects/sdks/sdks/rust/src/client.rs:161` and sends
`Authorization: Bearer` — the bug ADR-0003 §Decision mandates fixing.

## Decision

Implement retry and auth exactly as specified below. Cross-cutting ADRs
are the normative source; this file is the Rust-specific realisation.

---

## 6. Retry + rate-limit implementation

### 6.1 `RetryPolicy` struct
<!-- ✅ cloud path compliant 2026-04-23 (closes cognitum-one/sdks#11):
     src/client.rs now parses Retry-After (seconds + HTTP-date), JSON body
     `retry_after_us` (micros), and english "retry after Ns" on the `error`
     field. Body wins over header (seed convention). Error::RateLimit
     { retry_after_ms } is populated with the actual parsed delay — the
     hardcoded 1000 at client.rs:228 is gone. Fallback when no hint is
     present is ADR-0005 equal-jitter backoff, not a literal 1s. Test suite
     tests/client_test.rs gains 7 regression tests covering header seconds,
     HTTP-date, retry_after_us body, english body, header+body precedence,
     no-hint jitter fallback, and end-to-end retry sleep.
     The full `RetryPolicy` struct + 30s cap + max_elapsed budget is still
     inline in client.rs::request (no dedicated `src/retry.rs` yet —
     deferred to the 0.2.0 restructure per §14). -->


`src/retry.rs`:

```rust
use std::time::{Duration, Instant};
use reqwest::{Method, Response, StatusCode};
use crate::error::{Error, RateLimitTier};

/// Per-client retry policy per ADR-0005.
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub struct RetryPolicy {
    pub max_retries: u32,
    pub base: Duration,
    pub cap: Duration,
    pub max_elapsed: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 3,
            base: Duration::from_millis(500),
            cap: Duration::from_secs(30),
            max_elapsed: Duration::from_secs(60),
        }
    }
}
```

### 6.2 Backoff loop

`RetryPolicy::run` wraps `reqwest::RequestBuilder::send` and owns the
budget + retry decision. Concrete code below — compilable modulo imports.

```rust
impl RetryPolicy {
    pub(crate) async fn run<F, Fut>(
        &self,
        method: Method,
        endpoint: &str,
        mut attempt_fn: F,
    ) -> Result<Response, Error>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = Result<Response, reqwest::Error>>,
    {
        let start = Instant::now();
        let mut attempt: u32 = 0;

        loop {
            attempt += 1;

            let result = attempt_fn().await;

            // ── transport error ──────────────────────────────────────
            let response = match result {
                Ok(r) => r,
                Err(e) => {
                    let err: Error = e.into();
                    if !is_retriable_error(&err, &method) {
                        return Err(err);
                    }
                    if attempt > self.max_retries
                        || start.elapsed() > self.max_elapsed
                    {
                        return Err(err);
                    }
                    let delay = self.compute_delay(attempt, None);
                    tracing::debug!(
                        attempt,
                        next_delay_ms = delay.as_millis() as u64,
                        reason = "network", endpoint, "retrying"
                    );
                    tokio::time::sleep(delay).await;
                    continue;
                }
            };

            // ── HTTP error ───────────────────────────────────────────
            let status = response.status();
            if status.is_success() {
                return Ok(response);
            }

            if !is_retriable_status(status, &method) {
                return Ok(response);   // caller maps to Error via from_http
            }

            if attempt > self.max_retries || start.elapsed() > self.max_elapsed {
                return Ok(response);   // let caller surface final error
            }

            let server_hint_ms = extract_server_hint_ms(&response).await;
            let delay = self.compute_delay(attempt, server_hint_ms);

            tracing::debug!(
                attempt,
                status = status.as_u16(),
                next_delay_ms = delay.as_millis() as u64,
                endpoint,
                "retrying"
            );
            tokio::time::sleep(delay).await;
        }
    }

    fn compute_delay(&self, attempt: u32, server_hint_ms: Option<u64>) -> Duration {
        // Equal jitter per ADR-0005 §Backoff formula:
        //   raw = base * 2^attempt
        //   jitter = uniform(0, base_ms)
        //   delay = min(cap, max(server_hint, raw + jitter))
        let base_ms = self.base.as_millis() as u64;
        let cap_ms = self.cap.as_millis() as u64;

        // Saturating shift: 500ms * 2^attempt, capped.
        let raw_ms = base_ms.saturating_mul(1u64 << attempt.min(20));

        let jitter_ms = {
            use rand::Rng;
            rand::thread_rng().gen_range(0..base_ms)
        };

        let combined = raw_ms.saturating_add(jitter_ms);
        let chosen = std::cmp::max(server_hint_ms.unwrap_or(0), combined);
        Duration::from_millis(std::cmp::min(cap_ms, chosen))
    }
}

fn is_retriable_status(status: StatusCode, method: &Method) -> bool {
    let code = status.as_u16();
    let transient = matches!(code, 429 | 500 | 502 | 503 | 504);
    if !transient { return false; }
    // Idempotency rule per ADR-0005: POST retries only for 429/503.
    if method == Method::POST { return matches!(code, 429 | 503); }
    true
}

fn is_retriable_error(err: &Error, method: &Method) -> bool {
    match err {
        Error::Network(_) => true,
        Error::Timeout { phase: crate::error::TimeoutPhase::Connect } => true,
        Error::Timeout { phase: crate::error::TimeoutPhase::Read } => {
            // Read timeout on non-idempotent method is NOT retriable
            // (ADR-0005 §Idempotency rule).
            method != Method::POST
        }
        _ => false,
    }
}
```

### 6.3 Parsing `Retry-After` and the seed `retry_after_us` body

Implements ADR-0005 §"429 handling (seed specific)". The resolution order
is normative — header (seconds or HTTP-date) → `retry_after_us` body field
→ regex on `error` string → None. Do not reorder without updating the
cross-cutting ADR.

<!-- ✅ fixed 2026-04-22 seed half + ✅ cloud path compliant 2026-04-23
     (Team Rust, closes cognitum-one/sdks#11 fully). Seed:
     `src/seed/retry.rs::parse_retry_after` resolves in the ADR-0005 order
     — (1) header seconds, (2) JSON body `retry_after_us` (micros), (3)
     english `"retry after Ns"` regex on the `error` field. 5 unit tests
     cover each arm.
     Cloud: `src/client.rs::parse_retry_after` mirrors the seed helper +
     adds RFC 7231 IMF-fixdate parsing on the header (minimal inline
     parser — no chrono/httpdate dep). Body precedence over header
     matches seed. `Error::RateLimit { retry_after_ms }` now carries the
     parsed value (or ADR-0005 equal-jitter on attempt 1 when no hint is
     present) instead of the hardcoded 1000 ms. 7 new wiremock regression
     tests in tests/client_test.rs. -->


```rust
async fn extract_server_hint_ms(response: &Response) -> Option<u64> {
    // 1. Retry-After header (seconds or HTTP-date).
    if let Some(val) = response.headers().get(reqwest::header::RETRY_AFTER) {
        if let Ok(s) = val.to_str() {
            if let Ok(secs) = s.parse::<u64>() {
                return Some(secs.saturating_mul(1000));
            }
            if let Ok(date) = httpdate::parse_http_date(s) {
                let now = std::time::SystemTime::now();
                if let Ok(delta) = date.duration_since(now) {
                    return Some(delta.as_millis() as u64);
                }
            }
        }
    }
    None
}

/// Post-read helper: the 429 body from seed is
/// `{"error": "rate limited — retry after Ns"}` or JSON with `retry_after_us`.
/// Called after body is read because we need the full text.
pub(crate) fn parse_retry_after_ms(
    response: &Response,
    body_text: &str,
) -> Option<u64> {
    // Header first.
    if let Some(val) = response.headers().get(reqwest::header::RETRY_AFTER) {
        if let Ok(s) = val.to_str() {
            if let Ok(secs) = s.parse::<u64>() {
                return Some(secs.saturating_mul(1000));
            }
        }
    }
    // Structured seed body: {"error":"...", "retry_after_us": 123456}
    #[derive(serde::Deserialize)]
    struct Body {
        #[serde(default)] retry_after_us: Option<u64>,
        #[serde(default)] error: Option<String>,
    }
    if let Ok(b) = serde_json::from_str::<Body>(body_text) {
        if let Some(us) = b.retry_after_us { return Some(us / 1000); }
        if let Some(msg) = b.error {
            if let Some(secs) = parse_retry_after_english(&msg) {
                return Some(secs.saturating_mul(1000));
            }
        }
    }
    None
}

fn parse_retry_after_english(msg: &str) -> Option<u64> {
    // accepts "retry after 2s" / "retry after 2 seconds"
    let low = msg.to_ascii_lowercase();
    let after = low.split("retry after").nth(1)?.trim();
    let num: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    num.parse().ok()
}
```

### 6.4 Tier detection

The seed response does not carry the tier explicitly; we infer from the
caller's pairing state and the request target:

```rust
pub(crate) fn rate_limit_tier_for(
    credential: &crate::auth::SeedCredential,
    host: &str,
) -> RateLimitTier {
    if host == "127.0.0.1" || host == "::1" { return RateLimitTier::Localhost; }
    if credential.has_mtls()                { return RateLimitTier::Lockdown; }
    if credential.has_pairing_token()       { return RateLimitTier::Paired; }
    RateLimitTier::Unpaired
}
```

---

## 7. Auth

### 7.1 Fixing the `Authorization: Bearer` bug
<!-- ✅ fixed 2026-04-22 (PR pending, closes cognitum-one/sdks#10):
     src/client.rs now sends `X-API-Key` by default. `ClientBuilder::
     deprecated_bearer_auth(true)` keeps Bearer+X-API-Key for the 2-minor-
     release deprecation window per ADR-0003. Regression tests live at
     tests/client_test.rs: `default_client_does_not_send_authorization_header`,
     `default_client_sends_x_api_key_not_bearer`,
     `deprecated_bearer_auth_sends_both_headers`. -->


Current line at `/home/ruvultra/projects/sdks/sdks/rust/src/client.rs:161`:

```rust
.header("Authorization", format!("Bearer {}", self.config.api_key));
```

Replace in `src/auth.rs`:

```rust
use secrecy::{ExposeSecret, SecretString};

/// Cloud auth carrier. Redacted `Debug`.
pub struct CloudCredential {
    key: SecretString,
    /// Deprecation-window flag — set by `ClientBuilder::use_bearer_auth(true)`.
    pub(crate) use_bearer: bool,
}

impl std::fmt::Debug for CloudCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CloudCredential")
            .field("key", &"<redacted>")
            .field("use_bearer", &self.use_bearer)
            .finish()
    }
}

impl CloudCredential {
    pub fn from_api_key(key: impl Into<String>) -> Self {
        Self { key: SecretString::new(key.into()), use_bearer: false }
    }

    pub fn from_env() -> Result<Self, crate::error::Error> {
        std::env::var("COGNITUM_API_KEY")
            .map(Self::from_api_key)
            .map_err(|_| crate::error::Error::Auth {
                reason: crate::error::AuthReason::NoCredentials,
                message: "COGNITUM_API_KEY not set".into(),
                source: None,
            })
    }

    pub(crate) fn apply(&self, mut req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if self.use_bearer {
            req = req.header("Authorization",
                format!("Bearer {}", self.key.expose_secret()));
        } else {
            req = req.header("X-API-Key", self.key.expose_secret());
        }
        req
    }
}
```

### 7.2 Seed credential

```rust
#[cfg(feature = "seed")]
pub struct SeedCredential {
    pairing_token: Option<SecretString>,
    client_cert_pem: Option<Vec<u8>>,           // public, OK to keep plain
    client_key_pem: Option<secrecy::SecretVec<u8>>,
}

#[cfg(feature = "seed")]
impl std::fmt::Debug for SeedCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SeedCredential")
            .field("pairing_token",
                &self.pairing_token.as_ref().map(|_| "<redacted>"))
            .field("client_cert_pem",
                &self.client_cert_pem.as_ref().map(|b| format!("<{} bytes>", b.len())))
            .field("client_key_pem",
                &self.client_key_pem.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

#[cfg(feature = "seed")]
impl SeedCredential {
    pub fn from_env() -> Result<Self, crate::error::Error> {
        let token = std::env::var("COGNITUM_SEED_TOKEN").ok().map(SecretString::new);
        Ok(Self { pairing_token: token, client_cert_pem: None, client_key_pem: None })
    }

    pub fn has_pairing_token(&self) -> bool { self.pairing_token.is_some() }
    pub fn has_mtls(&self) -> bool { self.client_cert_pem.is_some() }

    pub(crate) fn apply(&self, mut req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(tok) = &self.pairing_token {
            req = req.header("X-Pairing-Token", tok.expose_secret());
        }
        req
    }
}
```

### 7.3 Environment-variable resolution order

Per ADR-0003 §Credential provisioning:

| Use case | Order |
|----------|-------|
| Cloud | (1) explicit `.api_key(...)`; (2) `COGNITUM_API_KEY`; (3) `Error::Auth { reason: NoCredentials }` at `build()` time |
| Seed pairing | (1) explicit `.pairing_token(...)`; (2) `COGNITUM_SEED_TOKEN`; (3) leave unset, first write fails with `Error::Auth { reason: NotPaired }` |
| Seed mTLS | explicit `.client_cert_pem(...)` only. No env var |
| Seed trust root | explicit `.trust_root_pem(...)` only. No env var |

### 7.4 `TokenStore` trait (opt-in persistence)

Per ADR-0007 §Pairing flow safety: SDKs MUST NOT persist tokens to disk
unless the caller opts in.

```rust
pub trait TokenStore: Send + Sync {
    fn get(&self, client_name: &str) -> Option<SecretString>;
    fn set(&self, client_name: &str, token: SecretString);
    fn delete(&self, client_name: &str);
}
```

Not built-in. Callers implement against `keyring`, a file, or in-memory.

### 7.5 Trust-score protection

Per ADR-0007 §"Trust-score protection" (closes OQ-9 — now MUST for all
three SDKs): SDK MUST NOT retry past 2 auth failures on the same credential.

Implementation note: auth errors are non-retriable (see
`is_retriable_status` in §6.2) so the loop returns them immediately.
Additionally, emit a `tracing::warn!("trust-score block imminent; stop
retrying")` when the same credential has seen 3+ auth failures within
60 s. Tracked per-Client via an `AtomicU8` counter on `ClientInner`.

## Consequences

### Positive

- Retry policy is a data type (`RetryPolicy`), not a hidden constant —
  callers tune per-client via the builder.
- All credentials are `SecretString` — Debug never leaks a key.
- X-API-Key bug at `/home/ruvultra/projects/sdks/sdks/rust/src/client.rs:161` is
  closed and regression-tested (0014e §9.3).
- Equal-jitter math is isolated in one function — unit-testable
  (0014e §9.5).

### Negative / trade-offs

- `secrecy = "0.8"` is unconditional (not feature-gated) because even
  cloud-only users need redacted credentials per ADR-0007.
- `rand` is a new dep under the `seed` feature (also reused by retry
  under the same feature gate). Acceptable — `rand` is already
  transitively present in most projects via `reqwest` / `tokio` trees.
- POST retries are narrower than GET/PUT/DELETE — callers of non-
  idempotent POSTs may see fewer automatic recoveries.

### Neutral

- `tracing` added unconditionally; `log`-facade crates work via
  `tracing-log` shim without user change.

## Alternatives considered

| Option | Why rejected |
|--------|--------------|
| Full jitter (`uniform(0, backoff)`) | marginal saving vs equal-jitter; ADR-0005 locks equal-jitter |
| Retry via middleware (`reqwest-retry` / `tower`) | adds transitive deps and hides ADR-0005 specifics |
| `secstr` instead of `secrecy` | `secrecy` is maintained + used by `tonic` / `clap` |
| No `TokenStore` trait, just allow a `Box<dyn Fn(String)>` | trait is more discoverable + implementable |

## Compliance / verification

- CI greps for `format!("Bearer {}"` in `sdks/rust/src/` and fails if
  found outside the deprecation-gated path in `src/auth.rs`.
- CI greps for `println!` / `dbg!` / format-printing of `api_key`,
  `token`, `Authorization` in `src/`.
- Unit test `tests/retry_jitter_test.rs` (see 0014e §9.5).
- Unit test `tests/auth_redaction_test.rs` (see 0014e §9.3) — asserts
  `X-API-Key` header present, not `Authorization: Bearer`.

## References

- ADR-0003 (auth), ADR-0005 (retry), ADR-0007 (security).
- 0014d §4 (error enum), 0014e §9 (tests).
- Seed rate limiter: `/home/ruvultra/projects/sdks/seed/src/cognitum-agent/src/rate_limit.rs:70-178`.
- Current retry impl: `/home/ruvultra/projects/sdks/sdks/rust/src/client.rs:146-215`.
- Current auth bug: `/home/ruvultra/projects/sdks/sdks/rust/src/client.rs:161`.
- Continues in `0014e-rust-sdk-implementation-streaming-tests-packaging.md`.
