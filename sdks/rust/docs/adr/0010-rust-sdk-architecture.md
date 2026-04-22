# ADR 0010: Rust SDK Architecture

<!-- swarm-seed-validation 2026-04-22 (rust agent): Phase 1 ✅ — the seed
     module now exists at `src/seed/**` behind the `seed` feature flag
     (closes cognitum-one/sdks#2 for single-seed mode). Cloud `Client`
     still at `https://api.cognitum.one`; seed composes over reqwest
     directly instead of reusing `Client`. All 12 Phase 1 endpoints are
     wired via `SeedClient` resources. Mesh-mode is Phase 1.5. -->

- **Status:** Accepted (Cloud scope). Seed-direct module Proposed (ADR-0011).
- **Date:** 2026-04-22
- **Scope:** sdks/rust
- **Crate:** `cognitum-rs` (`sdks/rust/Cargo.toml:2`)

## Context

`sdks/rust/` ships an async-only crate on `tokio` + `reqwest` + `serde` +
`thiserror`. Seven resource modules mirror the other SDKs: `brain`, `catalog`,
`contact`, `devices`, `leads`, `mcp`, `orders` plus `client`, `error`, `types`.

Existing source of truth:

- `lib.rs` — public re-exports (`lib.rs:25-37`)
- `client.rs` — `Client`, `ClientConfig`, retry loop (`client.rs:17-241`)
- `error.rs` — 7-variant `enum Error` (`error.rs:1-42`)
- `Cargo.toml` — `reqwest = "0.12"`, `serde`, `serde_json`, `thiserror = "2"`,
  `tokio = { features = ["time"] }` (`Cargo.toml:13-18`)
- Tests: `tests/client_test.rs` with `wiremock`.

## Decision

### Transport

- `reqwest` (`rustls-tls` preferred, not `native-tls`, for portability).
  Currently `features = ["json"]` only (`Cargo.toml:14`) — default TLS
  ships with native-tls on most targets; lock to `rustls-tls`:
  ```toml
  reqwest = { version = "0.12", default-features = false,
              features = ["json", "rustls-tls", "stream"] }
  ```
- `stream` feature enables async SSE over `response.bytes_stream()` for
  the seed-direct module.
- `tokio` full runtime NOT forced; keep `features = ["time"]` in the lib
  crate and let the binary choose the runtime.

### Auth

<!-- ✅ fixed 2026-04-22 (pre-fix agent, closes cognitum-one/sdks#10): client.rs now sends `X-API-Key` by default; `ClientBuilder::deprecated_bearer_auth(true)` keeps Bearer+X-API-Key for the 2-minor-release deprecation window per ADR-0003. Seed half uses `X-Pairing-Token` via `SeedAuth::PairingToken`. -->

**Breaking fix (per ADR-0003):** today Rust uses `Authorization: Bearer`
(`client.rs:161`). Switch to `X-API-Key`:

```rust
req = req.header("X-API-Key", &self.config.api_key);
```

Keep the Bearer path behind a deprecation-window `#[deprecated]` method
`ClientConfig::use_bearer_auth()` that the caller must opt into. Remove in
0.2.0 per ADR-0006.

For seed-direct, `cognitum_rs::seed::SeedClient` mirrors the structure:

```rust
let seed = SeedClient::builder()
    .host("169.254.42.1")
    .port(8443)
    .pairing_token("...")
    .client_cert_pem(cert_bytes, key_bytes)  // optional, lockdown
    .build()?;
```

### Retry / rate-limit

Per ADR-0005:

- `max_retries: 3` (retain), `timeout: 30s` (retain).
- Replace `backoff_duration`'s pure exponential
  (`client.rs:197-215`) with equal-jitter:
  ```rust
  let base = Duration::from_millis(500);
  let cap  = Duration::from_secs(30);
  let raw  = std::cmp::min(cap, base * 2u32.pow(attempt.saturating_sub(1)));
  let jitter = rand::thread_rng().gen_range(0..base.as_millis() as u64);
  raw + Duration::from_millis(jitter)
  ```
  (Requires `rand` dependency — already transitively present via
  many reqwest trees but add explicitly to make it future-proof.)
- Add 502 and 504 to `is_retryable` (`client.rs:188-195`).
- Parse the seed's `retry_after_us` JSON body in the seed module.

### Type / schema strategy

- `serde::Deserialize` + `Serialize` on all wire types. Request / response
  shapes live in `src/types.rs` (shared) and `src/seed/types.rs` (seed-only).
- `#[serde(rename_all = "camelCase")]` for cloud types.
- Seed types stay in snake_case (the seed already uses it); no renaming.
- Unknown fields: `#[serde(default)]` + `#[serde(other)]` variants on enums.
- Closed enums MUST be `#[non_exhaustive]` to preserve forward compatibility
  (ADR-0006).
- No `anyhow` in the public API.

### Error model

Per ADR-0004. Current `Error` is missing variants. Replace with:

```rust
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    #[error("authentication failed: {reason:?}")]
    Auth { reason: AuthReason, message: String },

    #[error("rate limited (tier {tier}), retry after {retry_after_ms}ms")]
    RateLimit { tier: RateLimitTier, retry_after_ms: u64 },

    #[error("validation error: {message}")]
    Validation { field: Option<String>, message: String },

    #[error("not found: {resource}")]
    NotFound { resource: String },

    #[error("not implemented: {endpoint}")]
    NotImplemented { endpoint: String },

    #[error("conflict: {0}")]
    Conflict(String),

    #[error("service unavailable")]
    Unavailable { retry_after_ms: Option<u64> },

    #[error("API error {status}: {message}")]
    Api { status: u16, code: Option<String>, message: String },

    #[error("network error")]
    Network(#[source] reqwest::Error),

    #[error("timeout during {phase}")]
    Timeout { phase: TimeoutPhase },

    #[error("parse error: expected {expected}, got {got}")]
    Parse { expected: &'static str, got: String },

    #[error("JSON error")]
    Json(#[source] serde_json::Error),
}

pub enum AuthReason {
    NoCredentials, InvalidCredentials, NotPaired,
    PairingWindowClosed, LockdownMTlsRequired, TrustScoreBlocked,
}
```

Migration: the old `Auth(String)`, `Validation(String)`, `NotFound(String)`,
`Api`, `Http(reqwest::Error)` all map cleanly. Add `#[non_exhaustive]` from
day one so later additions do not break consumers.

### Streaming & pagination

- SSE: `async fn stream(&self) -> Result<impl Stream<Item = Result<Event, Error>>, Error>`
  returning a `futures::Stream`. Implement for
  `seed.sensor.stream_readings()` and `seed.delta.stream()` with a
  placeholder that emits `Error::NotImplemented` when the seed returns 501.
- No pagination.

### Testing strategy

- `wiremock` for HTTP mocking (`Cargo.toml:22`, already present).
- `tokio::test` for async unit tests.
- Integration tests behind `#[ignore]` and a `COGNITUM_LIVE_TEST=1` env var.
- `cargo deny` + `cargo audit` in CI.
- Minimum supported Rust version (MSRV): 1.76 — covers `#[non_exhaustive]`
  everywhere and async-trait-free code.

### API surface shape

```rust
use cognitum_rs::{Client, Error};
use cognitum_rs::seed::SeedClient;

#[tokio::main]
async fn main() -> Result<(), Error> {
    // Cloud
    let c = Client::new("sk-...");
    let catalog = c.catalog().browse().await?;

    // Seed
    let seed = SeedClient::builder()
        .host("169.254.42.1")
        .pairing_token("...")
        .build()?;
    let status = seed.status().await?;
    let results = seed.store().query(&vec![0.1; 8], 5).await?;
    Ok(())
}
```

### Packaging

- Publish to crates.io as `cognitum-rs`.
- Optional Cargo features:
  - `default = ["rustls"]`
  - `native-tls` — alternate TLS backend.
  - `seed` — enable the seed-direct module + `rustls-tls-webpki-roots` +
    support for manually-pinned self-signed roots.
  - `stream` — enable SSE iteration helpers.
- MSRV documented in `README.md` and enforced with `cargo msrv` in CI.

## Consequences

### Positive

- Single async client, zero unsafe, pluggable TLS.
- `thiserror` enum error is idiomatic and composes with `?`.

### Negative

- `#[non_exhaustive]` on the error enum means consumers must include a
  `_ => ...` match arm — a deliberate choice that makes future variants
  non-breaking.
- Switching `Authorization: Bearer` → `X-API-Key` is a breaking change for
  anyone who customized outgoing headers. ADR-0006's deprecation window
  softens it.
- Adding `rand` to the dependency tree is small but additive.

## Alternatives considered

| Option | Why rejected |
|--------|--------------|
| `hyper` + bespoke HTTP | Too much surface for an SDK; `reqwest` covers 99%. |
| `async-std` runtime | `tokio` ecosystem is standard; `async-std` is deprecated in most production shops. |
| Sync-only via `reqwest::blocking` | The seed's expected usage (dashboards, CLIs) is async-friendly; sync adds double maintenance. |

## Compliance

- `cargo clippy --all -D warnings` clean.
- `cargo doc --no-deps` builds with no missing-doc warnings on public items.
- `cargo test --all-features` green against the virtual seed.
- Grep rule: no `unwrap()` or `expect()` in non-test code paths except in
  `Client::with_config` where the reqwest builder failure is impossible.

## References

- DDD model: `docs/adr/ddd/seed-domain.md`
- Client: `sdks/rust/src/client.rs:17-241`
- Error: `sdks/rust/src/error.rs:1-42`
- Crate manifest: `sdks/rust/Cargo.toml:1-23`
- Lib re-exports: `sdks/rust/src/lib.rs:25-37`
- Related: ADRs 0002, 0003, 0004, 0005, 0006, 0007, 0011.
