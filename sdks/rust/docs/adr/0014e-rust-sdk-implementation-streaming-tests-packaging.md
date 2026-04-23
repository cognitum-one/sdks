# ADR 0014e: Rust SDK Implementation — Streaming, Test Strategy, Packaging

<!-- swarm-seed-validation 2026-04-22 (rust agent): Phase 1 ✅ partial.
     `stream` feature flag added in Cargo.toml (gates `eventsource-stream`)
     but the SSE helper + `SeedEvent` type are not yet wired — SSE lands
     in Phase 1.5 alongside mesh mode. Seed 501 responses map to
     `Error::Validation("not_implemented: {endpoint}: …")` via
     `seed::error::from_response` (string-prefix workaround until the
     pre-fix agent ships the full 12-variant Error enum). 52 seed tests
     green (33 lib + 19 wiremock). Wire observation re. /delta/stream
     returning 200 is still accurate and tracked. -->

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** SDK WG (Rust lead + cross-cutting)
- **Scope:** sdks/rust

> Continuation of 0014b (retry + auth). Covers §§8–10 of the
> implementation ADR: SSE streaming (feature = "stream"), the test
> matrix + fixtures + concrete tests, and the full Cargo manifest.
> Successor: 0014c (CI, benches, examples, migration, OQs).

## Context

Retry (0014b §6) and auth (0014b §7) are in place. What remains is how
the crate proves it behaves to the ADR (test strategy) and how it ships
(packaging). Current tests at
`/home/ruvultra/projects/sdks/sdks/rust/tests/client_test.rs:1-239` use `wiremock`
but do not cover the new error variants, and current manifest at
`/home/ruvultra/projects/sdks/sdks/rust/Cargo.toml:1-23` does not declare any
feature flags, MSRV, or benchmark target.

The seed exposes two SSE endpoints
(`/api/v1/delta/stream`, `/api/v1/sensor/stream`) that return 501 today
per `/home/ruvultra/projects/sdks/docs/adr/0002-seed-wire-protocol.md` §"Streaming"
and OQ-3 in `/home/ruvultra/projects/sdks/docs/adr/README.md` §"Open questions".
Callers need typed stream handles that don't break when the seed finally
ships SSE.



## Decision

Implement SSE, tests, and packaging exactly as below.

---

## 8. Streaming (feature = "stream")

<!-- ❌ wire_mismatch 2026-04-22 (issue cognitum-one/seed#48, issue cognitum-one/sdks#3): /api/v1/delta/stream on seed v0.20.0 returns 200 application/json JSON snapshot — NOT 501 and NOT SSE. reports/rust.partial.json n=8 recorded Error::Api{code:200} (no NotImplemented variant exists in 0.1.0 error.rs). §8 contract remains `(assumed)` until seed and SDK reconcile (feature="stream" not yet implemented). -->

Per ADR-0002 §Streaming
(https://github.com/cognitum-one/sdks/blob/main/docs/adr/0002-seed-wire-protocol.md):
`/api/v1/delta/stream` and `/api/v1/sensor/stream` are specified to
return 501 today; SDKs MUST ship typed stream handles that surface
`Error::NotImplemented` when the seed does, without forcing the call
site to change once SSE lands.

**Wire reality (seed v0.20.0):** swarm validation against the live seed
found `/api/v1/delta/stream` returns `200 application/json` with a
snapshot body instead of the documented 501 — see
https://github.com/cognitum-one/seed/issues/48. The 501 contract per
ADR-0002 still describes the intended behaviour, but the Rust SDK must
remain correct against both the documented and the observed wire until
the seed ships a real SSE stream.

The crate therefore exposes **two** entry points under
`feature = "stream"`:

1. `open_sse` — strict "SSE-or-error" variant. On 501 returns
   `Err(Error::NotImplemented { endpoint })` immediately (fail-fast,
   no `.next()` required to discover the capability gap). On a 200 with
   a non-`text/event-stream` content-type, returns
   `Err(Error::Protocol { .. })` so callers that only want SSE never
   silently receive a JSON snapshot.
2. `open_or_snapshot` — enum-returning escape hatch. Lets a single call
   site handle both eras of the seed firmware:

   ```rust
   #[non_exhaustive]
   pub enum StreamOrSnapshot<T, S> {
       /// Server responded with an SSE stream (normal case, seed ≥ v0.21.x).
       Stream(S),
       /// Server responded with a 200 JSON body — the endpoint hasn't yet
       /// been promoted to a real stream (seed < v0.21.x for /delta/stream).
       Snapshot(T),
   }

   pub async fn open_or_snapshot<T: DeserializeOwned>(&self, path: &str)
       -> Result<StreamOrSnapshot<T, impl Stream<Item = Result<Event, Error>>>, Error>;
   ```

   `open_or_snapshot` inspects `content-type`: `text/event-stream` →
   `Stream(_)`, `application/json` → `Snapshot(_)`, anything else →
   `Err(Error::Protocol { .. })`. A 501 still short-circuits to
   `Err(Error::NotImplemented { endpoint })` — the enum only models the
   "server said 200, in one of two shapes" axis.

**Recommendation:** prefer `open_or_snapshot` at the public
`SeedClient::delta().stream()` / `.sensor().stream()` call sites. It is
future-proof, lets clients handle either wire shape without a refactor,
and keeps `open_sse` available for callers that truly require SSE.

Once https://github.com/cognitum-one/seed/issues/48 is resolved and the
seed ships a real SSE stream, the `Snapshot(_)` arm collapses to a
deprecation warning (emitted via `tracing::warn!` with the observed seed
version) and eventually to a hard `Error::Protocol` in a subsequent
MAJOR bump.

### 8.1 Event type

`src/sse.rs`:

```rust
#![cfg(feature = "stream")]

use serde::Deserialize;
use crate::error::Error;

/// A single Server-Sent Event.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[non_exhaustive]
pub struct Event {
    pub id: Option<String>,
    pub event: Option<String>,
    pub data: String,
    pub retry: Option<u64>,
}
```

### 8.2 Stream constructor
<!-- verification 2026-04-22: ❌ no stream constructor exists. No fail-fast
     501 check. Also: live seed now returns 200 on /api/v1/delta/stream, so
     the 501 path is no longer the default case that needs testing. -->


```rust
use eventsource_stream::Eventsource;
use futures_util::{Stream, StreamExt};

pub(crate) async fn open_sse(
    http: &reqwest::Client,
    url: url::Url,
    credential_apply: impl Fn(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
) -> Result<impl Stream<Item = Result<Event, Error>>, Error> {
    let response = credential_apply(http.get(url.clone()))
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .send()
        .await
        .map_err(Error::from)?;

    let status = response.status();
    if !status.is_success() {
        // Capability check per ADR-0011: surface NotImplemented so callers
        // don't need to catch a generic Api error.
        return Err(crate::error::from_http(
            status,
            response,
            crate::error::ErrorContext {
                endpoint_path: url.path(),
                is_seed: true,
                tier: None,
            },
        ).await);
    }

    let stream = response.bytes_stream().eventsource().map(|item| {
        item.map_err(|e| Error::Parse {
            expected: "valid SSE frame",
            got: e.to_string(),
            source: None,
        })
        .and_then(|ev| Ok(Event {
            id: if ev.id.is_empty() { None } else { Some(ev.id) },
            event: if ev.event.is_empty() { None } else { Some(ev.event) },
            data: ev.data,
            retry: ev.retry.map(|d| d.as_millis() as u64),
        }))
    });

    Ok(stream)
}
```

### 8.3 Runtime capability gate

`SeedClient::delta()` / `SeedClient::sensor()` expose `.stream()` methods
only under `#[cfg(feature = "stream")]`. The method calls `open_sse`; on
501 it returns `Err(Error::NotImplemented { endpoint: "/api/v1/delta/stream" })`
so a `while let Some(event) = stream.next().await` loop never spins.

---

## 9. Test strategy

### 9.1 Test matrix

| Layer | Tool | Covers |
|-------|------|--------|
| Unit | built-in `#[test]` | `parse_retry_after_ms`, `compute_delay`, `rate_limit_tier_for`, redaction |
| HTTP | `wiremock = "0.6"` (already at `/home/ruvultra/projects/sdks/sdks/rust/Cargo.toml:22`) | every resource method happy + error |
| Parameterized | `rstest = "0.18"` (new dev-dep) | table-driven error-variant mapping |
| Fixtures | `tests/fixtures/seed/*.json` | golden responses |
| Integration | `#[ignore]` gated by `COGNITUM_LIVE_TEST=1` | real seed at `169.254.42.1:8443` |
| Async | `#[tokio::test(flavor = "multi_thread", worker_threads = 2)]` | realistic scheduler on retry tests |

### 9.2 Fixtures (golden JSON)

Files placed at `tests/fixtures/seed/` and loaded with `include_str!`.
`tests/fixtures/seed/status.json` (shape from
`/home/ruvultra/projects/sdks/seed/docs/seed/api-reference.md:32-43`, with live-firmware
`witness_chain_length` absorbed by `extras`):

```json
{
  "device_id": "24db5659-b9bd-42e3-b4c5-f4fec6e721c5",
  "uptime_secs": 3845,
  "epoch": 21298,
  "total_vectors": 21298,
  "deleted_vectors": 0,
  "file_size_bytes": 1683031,
  "dimension": 8,
  "paired": false,
  "roles": ["custody", "optimizer", "delivery"],
  "witness_chain_length": 21298
}
```

### 9.3 Concrete test — 401 maps to `Auth { reason: InvalidCredentials }`
<!-- verification 2026-04-22: ❌ test not written; current Error::Auth(String)
     has no `reason` field and cannot yet express InvalidCredentials. -->


`tests/auth_redaction_test.rs`:

```rust
use cognitum_rs::{Client, Error, AuthReason};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unauthorized_401_maps_to_auth_invalid_credentials() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/health"))
        .and(header("X-API-Key", "test-key"))   // ADR-0003 conformance
        .respond_with(
            ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "error": "invalid api key"
            })),
        )
        .mount(&server)
        .await;

    let client = Client::builder()
        .api_key("test-key")
        .base_url(server.uri().parse().unwrap())
        .build()
        .unwrap();

    let err = client.health().await.unwrap_err();
    match err {
        Error::Auth { reason, message, .. } => {
            assert_eq!(reason, AuthReason::InvalidCredentials);
            assert_eq!(message, "invalid api key");
        }
        other => panic!("expected Auth InvalidCredentials, got {other:?}"),
    }
}
```

### 9.4 Concrete test — rstest parameterized error mapping

`tests/error_mapping_test.rs`:

```rust
use cognitum_rs::{AuthReason, Error};
use rstest::rstest;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn auth_reason_of(e: &Error) -> Option<AuthReason> {
    if let Error::Auth { reason, .. } = e { Some(*reason) } else { None }
}

#[rstest]
#[case::not_paired(403, r#"{"error":"not paired"}"#, Some(AuthReason::NotPaired))]
#[case::window_closed(403, r#"{"error":"pairing window closed"}"#, Some(AuthReason::PairingWindowClosed))]
#[case::lockdown(403, r#"{"error":"lockdown active; mTLS required"}"#, Some(AuthReason::LockdownMTlsRequired))]
#[case::trust(403, r#"{"error":"blocked: trust score exhausted"}"#, Some(AuthReason::TrustScoreBlocked))]
#[case::invalid(401, r#"{"error":"invalid token"}"#, Some(AuthReason::InvalidCredentials))]
#[tokio::test]
async fn auth_reason_parsing(
    #[case] status: u16,
    #[case] body: &str,
    #[case] expected: Option<AuthReason>,
) {
    let server = MockServer::start().await;
    Mock::given(method("GET")).and(path("/health"))
        .respond_with(ResponseTemplate::new(status).set_body_string(body))
        .mount(&server).await;

    let client = cognitum_rs::Client::builder()
        .api_key("k")
        .base_url(server.uri().parse().unwrap())
        .build().unwrap();

    let err = client.health().await.unwrap_err();
    assert_eq!(auth_reason_of(&err), expected, "body: {body}");
}
```

### 9.5 Equal-jitter conformance test

`tests/retry_jitter_test.rs`:

```rust
use cognitum_rs::retry::RetryPolicy;
use std::time::Duration;

#[test]
fn equal_jitter_within_expected_range() {
    let p = RetryPolicy {
        max_retries: 5,
        base: Duration::from_millis(500),
        cap: Duration::from_secs(30),
        max_elapsed: Duration::from_secs(60),
    };
    // attempt 1: raw = 500*2 = 1000, jitter ∈ [0,500) → [1000, 1500)
    let d = p.compute_delay_for_test(1, None);
    assert!(d >= Duration::from_millis(1000) && d < Duration::from_millis(1500));

    // server_hint_ms wins when larger.
    let d2 = p.compute_delay_for_test(1, Some(5_000));
    assert_eq!(d2, Duration::from_millis(5_000));
}
```

(Expose `compute_delay` as `compute_delay_for_test` under `#[cfg(test)]`
or via a `pub(crate)` in-crate integration test file.)

---

## 10. Packaging

### 10.1 Full `Cargo.toml`

Starting from `/home/ruvultra/projects/sdks/sdks/rust/Cargo.toml:1-23`:

```toml
[package]
name = "cognitum-rs"
version = "0.2.0"                        # MINOR bump: breaking pre-1.0 (ADR-0006)
edition = "2021"
rust-version = "1.78"                    # MSRV
description = "Official Cognitum SDK for Rust (cloud + seed)"
license = "MIT"
keywords = ["cognitum", "ai", "seed", "sdk", "ota"]   # crates.io limit = 5
categories = ["api-bindings", "web-programming::http-client"]
repository = "https://github.com/ruvnet/cognitum"
homepage = "https://cognitum.one"
documentation = "https://docs.rs/cognitum-rs"
readme = "README.md"
publish = true

[features]
default = ["rustls"]
rustls = ["reqwest/rustls-tls", "dep:rustls", "dep:rustls-pemfile", "dep:webpki-roots"]
native-tls = ["reqwest/native-tls"]
seed = ["rustls", "dep:rand"]
stream = ["dep:eventsource-stream", "dep:futures-util", "dep:tokio-util"]
blocking = ["reqwest/blocking"]

[dependencies]
reqwest = { version = "0.12", default-features = false, features = ["json", "http2"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
tokio = { version = "1", features = ["time", "rt"] }
tracing = "0.1"
url = "2"
secrecy = "0.8"
httpdate = "1"

rand = { version = "0.8", optional = true }
rustls = { version = "0.23", optional = true, default-features = false, features = ["std"] }
rustls-pemfile = { version = "2", optional = true }
webpki-roots = { version = "0.26", optional = true }
eventsource-stream = { version = "0.2", optional = true }
futures-util = { version = "0.3", optional = true }
tokio-util = { version = "0.7", optional = true }

[dev-dependencies]
tokio = { version = "1", features = ["full", "test-util"] }
wiremock = "0.6"
rstest = "0.18"
criterion = { version = "0.5", features = ["async_tokio"] }
serde_json = "1"

[[bench]]
name = "wire"
harness = false

[package.metadata.docs.rs]
all-features = true
rustdoc-args = ["--cfg", "docsrs"]
```

### 10.2 Feature matrix (what compiles)

| Invocation | Compiles |
|------------|----------|
| `cargo build` | cloud only, rustls |
| `cargo build --no-default-features --features native-tls` | cloud only, native-tls |
| `cargo build --features seed` | cloud + seed, rustls, pinned verifier |
| `cargo build --features "seed stream"` | + SSE helpers |
| `cargo build --features "seed stream blocking"` | + sync facade |
| `cargo build --all-features` | hits `compile_error!` for rustls+native-tls |

CI must use `--features "seed stream blocking"` instead of
`--all-features` in the one matrix cell — see 0014c §CI.

### 10.3 Publishing

- Crates.io publishes a single crate `cognitum-rs` with all features
  opt-in. No separate `cognitum-seed` crate per ADR-0011 §Rust.
- `cognitum[seed]` is Python syntax. In Rust the equivalent is:
  ```toml
  cognitum-rs = { version = "0.2", features = ["seed"] }
  ```
- Release via `cargo-release` with `--sign-tag` (0014c §11.3).

### 10.4 Crate-level docs

`src/lib.rs` replaces the current lead-in at
`/home/ruvultra/projects/sdks/sdks/rust/src/lib.rs:1-23` with:

```rust
//! # cognitum-rs
//!
//! Official Cognitum SDK for Rust.
//!
//! Two client families live in this crate:
//!
//! - [`Client`] — cloud control plane at `https://api.cognitum.one`.
//! - [`seed::SeedClient`] — direct-to-device at
//!   `https://<seed-host>:8443/api/v1/*` (behind the `seed` Cargo feature).
//!
//! See ADR-0011 for the rationale behind one crate, two clients.
//!
//! ## Feature flags
//!
//! | Feature | Default | Description |
//! |---------|---------|-------------|
//! | `rustls` | yes | rustls TLS stack |
//! | `native-tls` | no | OS-native TLS stack (mutually exclusive with `rustls`) |
//! | `seed` | no | Enables `seed::SeedClient` |
//! | `stream` | no | Enables SSE helpers |
//! | `blocking` | no | Enables `blocking::Client` sync facade |
```

## Consequences

### Positive

- Typed SSE handles are in the API from day one; the 501-today path is
  a one-arm `Error::NotImplemented` match, not a refactor.
- Test matrix is table-driven (`rstest`), adding a new error variant
  means adding a `#[case]` not a whole file.
- Manifest is declarative: every feature flag is documented in one
  place reviewers can diff.

### Negative / trade-offs

- `stream` feature adds three deps (`eventsource-stream`,
  `futures-util`, `tokio-util`) — off by default keeps footprint small
  for cloud-only users.
- `criterion` dev-dep adds ~30 MB to the debug build tree; benches are
  opt-in (`cargo bench`) so release builds are unaffected.

### Neutral

- `docs.rs` metadata (`all-features = true` + `--cfg docsrs`) follows
  Rust-ecosystem convention; no user-visible impact.

## Alternatives considered

| Option | Why rejected |
|--------|--------------|
| Hand-rolled SSE parser | `eventsource-stream` is 200 LoC of already-tested code; rewriting wastes time |
| `insta` for snapshot tests | redundant with `rstest` + JSON fixtures |
| `mockito` instead of `wiremock` | `wiremock` is already the dev-dep; matches Python SDK's `respx` style |

## Compliance / verification

- `cargo test --no-default-features --features "rustls seed stream"`
  green.
- Every variant of `Error` has at least one test case under
  `tests/error_mapping_test.rs`.
- CI runs `cargo test --doc` so the snippets in this ADR's lib.rs docs
  must compile.

## References

- ADR-0002 §Streaming, ADR-0004, ADR-0011.
- 0014a §1.3 (features), 0014d §4 (errors), 0014b §6 (retry).
- SSE ground truth: `/home/ruvultra/projects/sdks/docs/adr/0002-seed-wire-protocol.md` §"Streaming"
  and OQ-3 in `/home/ruvultra/projects/sdks/docs/adr/README.md` §"Open questions".
- Continues in `0014c-rust-sdk-implementation-release.md`.
