# ADR 0014a: Rust SDK Implementation — Crate Layout & Public API

<!-- swarm-seed-validation 2026-04-22 (rust agent): Phase 1 ✅ partially
     delivered. `src/seed/**` tree shipped (12 Phase 1 endpoints, single-seed
     mode, Routing::Pinned only). Cloud modules still flat (brain.rs,
     catalog.rs, …) — cloud reorg deferred. Feature flags `seed`, `rustls`,
     `native-tls`, `stream`, `blocking`, `live-seed-tests` all present. No
     SeedCredential/CloudCredential split yet — SeedAuth enum covers the
     seed half; cloud keeps the legacy ClientConfig. -->

## Phase 1 delivery (2026-04-22)

Team Rust shipped the single-seed half of ADR-0011 under
`src/seed/**`. The tree composes over `reqwest::Client` directly (it
does not reuse `crate::Client` — cloud and seed have different
auth/host defaults). Summary:

- **Builder**: `SeedClient::builder().endpoint(...).auth(...).tls(...).routing(Pinned).build()?`
- **Mesh API shape locked**: `.endpoints(&[...])`, `Routing::Session`
  (Phase 1.5 default, closest-first + sticky), and multi-peer
  `PeerSet::new` now route real traffic. Phase 1.5 landed 2026-04-22 —
  see ADR-0014c §"Phase 1.5 delivery" for the 7-test integration matrix.
  `Routing::{Pinned, Balanced, Failover}` remain as constructor aliases
  for back-compat and behave as `Session` on the current router.
- **TLS**: `SeedTls::{System, Pinned(Vec<u8>), Insecure}`. Insecure logs
  once per process via `eprintln!`. `Pinned` disables the system trust
  store and plumbs through `reqwest::Certificate::from_pem`.
- **Errors**: composed over the existing `crate::Error` (pre-fix agent's
  7-variant enum). Reason slot is prefixed into the `Auth` message —
  `"not_paired: …"`, `"invalid_credentials: …"`. Full ADR-0004 taxonomy
  migration lands when the pre-fix agent's Error rewrite ships.
- **Retry**: equal-jitter backoff, Retry-After (header seconds + JSON
  `retry_after_us` + english `"retry after Ns"` fallback), 60s elapsed
  ceiling, POST idempotency rule. Pure helpers in `seed::retry` are
  dep-free.
- **Tests**: 33 lib + 19 wiremock integration = 52 green. Live-seed
  integration gated on `--features live-seed-tests`.

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** SDK WG (Rust lead + cross-cutting)
- **Scope:** sdks/rust

> Implementation companion to ADR-0010 (Rust SDK Architecture). Split for
> length:
>
> - **0014a** — crate layout + public API surface (this file)
> - **0014d** — wire types, error enum, transport
> - **0014b** — retry + auth
> - **0014e** — streaming, test strategy, packaging
> - **0014c** — CI, benchmarks, examples, migration, open questions

## Context

ADR-0010 (`/home/ruvultra/projects/sdks/docs/adr/0010-rust-sdk-architecture.md:1-239`)
set the architecture. What we still need is the concrete, compilable
surface: exact module tree, exact `pub` signatures, exact serde
attributes, exact `reqwest` builder call. Without that, three separate
contributors will land three slightly different implementations of the
same ADR.

Current state (absolute paths):

- Crate manifest: `/home/ruvultra/projects/sdks/sdks/rust/Cargo.toml:1-23` — MSRV
  unset, `reqwest = "0.12"` with `features = ["json"]` only (defaults to
  native-tls on most targets), no `rustls-tls`, no `stream`.
- Lib re-exports: `/home/ruvultra/projects/sdks/sdks/rust/src/lib.rs:25-37` — seven
  cloud modules (`brain`, `catalog`, `contact`, `devices`, `leads`,
  `mcp`, `orders`), no `seed/`, no `auth`, no `retry`, no `sse`.
- Client: `/home/ruvultra/projects/sdks/sdks/rust/src/client.rs:17-241` — sends
  `Authorization: Bearer` at line 161 (the bug fixed by ADR-0003), pure
  exponential backoff without jitter (line 214), retries only
  `{429, 500, 503}` at lines 188-195.
- Errors: `/home/ruvultra/projects/sdks/sdks/rust/src/error.rs:1-42` — 7 variants;
  `Auth(String)` collapses 401 and 403; no `NotImplemented`, `Timeout`,
  `Network`, `Conflict`, `Unavailable`, structured `AuthReason`, nor
  `#[non_exhaustive]`.
- Types: `/home/ruvultra/projects/sdks/sdks/rust/src/types.rs:1-201` — cloud-only,
  camelCase, no seed schemas.
- Tests: `/home/ruvultra/projects/sdks/sdks/rust/tests/client_test.rs:1-239` — uses
  `wiremock`, no `rstest`, no fixtures dir.

Seed ground truth: `/home/ruvultra/projects/sdks/seed/src/cognitum-agent/src/http.rs:136-137, 145-153`
(error envelope + CORS/response headers), `/home/ruvultra/projects/sdks/seed/docs/seed/api-reference.md:30-42, 120-129, 544-547`
(status/query shapes + TLS notes).

## Decision

Stand up the crate layout and public API surface exactly as specified
below. Every module path and `pub` signature is normative: reviewers
MUST reject PRs that drift.

---

## 1. Crate layout

### 1.1 Source tree

```text
sdks/rust/
├── Cargo.toml
├── README.md                    # compatibility matrix (ADR-0006)
├── CHANGELOG.md
├── deny.toml                    # cargo-deny policy
├── src/
│   ├── lib.rs                   # pub re-exports; no logic
│   ├── client.rs                # Client, ClientBuilder, cloud base-url
│   ├── builder.rs               # shared builder utilities
│   ├── auth.rs                  # Credential, TokenStore trait, redaction
│   ├── retry.rs                 # backoff loop + equal-jitter (ADR-0005)
│   ├── error.rs                 # Error enum + AuthReason + TimeoutPhase (ADR-0004)
│   ├── transport.rs             # reqwest::Client builder, TLS roots
│   ├── redact.rs                # SecretString newtype + Debug redaction
│   ├── sse.rs                   # SSE parser behind `stream` feature
│   │
│   ├── models/                  # shared wire models
│   │   ├── mod.rs
│   │   ├── common.rs            # Epoch, DeviceId, Dimension, Extras
│   │   ├── cloud.rs             # re-exports of existing cloud types
│   │   └── status.rs            # Status (shared cloud/seed shape overlap)
│   │
│   ├── cloud/                   # existing cloud resource modules
│   │   ├── mod.rs
│   │   ├── brain.rs             # was src/brain.rs
│   │   ├── catalog.rs           # was src/catalog.rs
│   │   ├── contact.rs           # was src/contact.rs
│   │   ├── devices.rs           # was src/devices.rs
│   │   ├── leads.rs             # was src/leads.rs
│   │   ├── mcp.rs               # was src/mcp.rs
│   │   └── orders.rs            # was src/orders.rs
│   │
│   └── seed/                    # feature = "seed"
│       ├── mod.rs               # SeedClient, SeedClientBuilder
│       ├── custody.rs           # witness, attestation, signing
│       ├── optimizer.rs         # store, optimize, boundary
│       ├── delivery.rs          # delivery image, delta history/stream
│       ├── pairing.rs           # pair/status, pair, unpair
│       ├── sensor.rs            # 17 sensor endpoints (ADR-041)
│       ├── coherence.rs         # coherence profile (ADR-042)
│       ├── thermal.rs           # thermal state + governor (ADR-043)
│       └── types.rs             # seed snake_case wire types
│
├── tests/
│   ├── client_test.rs           # existing cloud tests; extended
│   ├── seed_pairing_test.rs     # feature = "seed"
│   ├── seed_store_test.rs       # feature = "seed"
│   ├── retry_jitter_test.rs     # ADR-0005 conformance
│   ├── auth_redaction_test.rs   # ADR-0003 / ADR-0007
│   └── fixtures/
│       └── seed/
│           ├── status.json
│           ├── store_query_result.json
│           ├── pair_init.json
│           ├── pair_complete.json
│           ├── witness_chain.json
│           ├── rate_limited_429.json
│           └── error_not_paired_403.json
│
├── examples/
│   ├── cloud_tour.rs            # no features
│   └── seed_tour.rs             # feature = "seed"
│
└── benches/
    └── wire.rs                  # criterion
```

### 1.2 What moves from current layout

| From | To | Reason |
|------|----|--------|
| `src/brain.rs` | `src/cloud/brain.rs` | group by scope (ADR-0011) |
| `src/catalog.rs` | `src/cloud/catalog.rs` | same |
| `src/contact.rs` | `src/cloud/contact.rs` | same |
| `src/devices.rs` | `src/cloud/devices.rs` | same |
| `src/leads.rs` | `src/cloud/leads.rs` | same |
| `src/mcp.rs` | `src/cloud/mcp.rs` | same |
| `src/orders.rs` | `src/cloud/orders.rs` | same |
| `src/types.rs` | `src/models/cloud.rs` | consolidate |
| inline retry in `src/client.rs:146-215` | `src/retry.rs` | reuse cloud + seed |
| inline auth header at `src/client.rs:161` | `src/auth.rs` | fix X-API-Key bug once |

### 1.3 Cargo features

| Feature | Default? | Adds deps | Enables |
|---------|----------|-----------|---------|
| `rustls` | **yes** | `reqwest/rustls-tls`, `rustls = "0.23"`, `rustls-pemfile = "2"`, `webpki-roots = "0.26"` | rustls TLS stack; required for seed pinning |
| `native-tls` | no | `reqwest/native-tls` | alternate backend; **mutually exclusive** with `rustls` (`compile_error!`) |
| `seed` | no | `rand = "0.8"`; seed module | `cognitum_rs::seed::*` + pinned trust roots |
| `stream` | no | `eventsource-stream`, `futures-util`, `tokio-util` | `impl Stream<Item = Result<Event, Error>>` for SSE |
| `blocking` | no | `reqwest/blocking` | `cognitum_rs::blocking::Client` (see OQ-R1 in 0014c) |

Gating rules:

- `seed` implies `rustls` (required for pinned self-signed certs).
- `native-tls` and `rustls` are mutually exclusive via a `compile_error!`
  in `src/lib.rs`.
- `stream` compiles SSE helpers; without it, those methods don't exist.
- `blocking` adds a parallel sync facade reusing async types.

### 1.4 Manifest skeleton (features + deps only — full manifest in 0014e §10)

```toml
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
```

**Rationale for `default-features = false` on `reqwest`:** the current
`/home/ruvultra/projects/sdks/sdks/rust/Cargo.toml:14` pulls `reqwest`'s defaults,
forcing `native-tls` (via `default-tls`) on most targets. That bloats
link time and makes the `rustls` feature flag meaningless. Locking
defaults off is the correct fix.

---

## 2. Public API surface

<!-- swarm-seed-validation 2026-04-22 (rust): §2.3 `cognitum_rs::seed::SeedClient` (feature = "seed") ✅ shipped in 0.1.0+Phase 1 — closes cognitum-one/sdks#2 (single-seed half); mesh-mode still Phase 1.5. §2.1 re-exports of `seed` ✅ present behind feature flag; `sse`, `blocking` remain `(assumed)`. §2.2 cloud Client auth header ✅ fixed by pre-fix agent — closes cognitum-one/sdks#10. -->

Every signature below is normative. `#[non_exhaustive]` is mandatory on
public structs and enums as called out.

### 2.1 Top-level re-exports (`src/lib.rs`)

```rust
#![doc = include_str!("../README.md")]
#![deny(missing_docs)]
#![forbid(unsafe_code)]

#[cfg(all(feature = "rustls", feature = "native-tls"))]
compile_error!("features `rustls` and `native-tls` are mutually exclusive");

pub mod auth;
pub mod client;
pub mod cloud;
pub mod error;
pub mod models;
pub mod retry;

#[cfg(feature = "seed")]
pub mod seed;

#[cfg(feature = "stream")]
pub mod sse;

#[cfg(feature = "blocking")]
pub mod blocking;

pub use client::{Client, ClientBuilder};
pub use error::{AuthReason, Error, RateLimitTier, TimeoutPhase};
pub use models::common::{DeviceId, Dimension, Epoch};
```

### 2.2 `Client` and `ClientBuilder`

```rust
// src/client.rs

use std::time::Duration;
use secrecy::SecretString;

use crate::auth::CloudCredential;
use crate::cloud::{brain, catalog, contact, devices, leads, mcp, orders};
use crate::error::Error;
use crate::models::cloud::HealthResponse;
use crate::retry::RetryPolicy;

/// Cloud control-plane client for `https://api.cognitum.one`.
///
/// Construct via [`Client::new`] for defaults or [`Client::builder`] for
/// full control. Cheap to clone (`Arc`-backed internally).
#[derive(Debug, Clone)]
pub struct Client {
    inner: std::sync::Arc<ClientInner>,
}

#[derive(Debug)]
struct ClientInner {
    http: reqwest::Client,
    base_url: url::Url,
    credential: CloudCredential,   // SecretString inside; redacts in Debug
    retry: RetryPolicy,
    timeout: Duration,
}

impl Client {
    /// Convenience constructor: `X-API-Key` from the given key, defaults elsewhere.
    pub fn new(api_key: impl Into<String>) -> Self { /* ... */ }

    /// Convenience constructor: read `COGNITUM_API_KEY` from the environment.
    pub fn from_env() -> Result<Self, Error> { /* ... */ }

    /// Start a fluent builder.
    pub fn builder() -> ClientBuilder { ClientBuilder::default() }

    // Resource accessors — unchanged from current crate.
    pub fn catalog(&self) -> catalog::CatalogResource<'_> { /* ... */ }
    pub fn orders(&self) -> orders::OrdersResource<'_> { /* ... */ }
    pub fn leads(&self) -> leads::LeadsResource<'_> { /* ... */ }
    pub fn contact(&self) -> contact::ContactResource<'_> { /* ... */ }
    pub fn devices(&self) -> devices::DevicesResource<'_> { /* ... */ }
    pub fn mcp(&self) -> mcp::McpResource<'_> { /* ... */ }
    pub fn brain(&self) -> brain::BrainResource<'_> { /* ... */ }

    /// Health check.
    pub async fn health(&self) -> Result<HealthResponse, Error> { /* ... */ }
}

/// Fluent builder for [`Client`].
#[derive(Debug, Default)]
#[non_exhaustive]
pub struct ClientBuilder {
    api_key: Option<SecretString>,
    base_url: Option<url::Url>,
    timeout: Option<Duration>,
    retry: Option<RetryPolicy>,
    user_agent: Option<String>,
    /// Deprecation-window Bearer flag. Remove in 0.3.0. (ADR-0003)
    use_bearer_auth: bool,
}

impl ClientBuilder {
    pub fn api_key(mut self, key: impl Into<String>) -> Self { /* ... */ }
    pub fn base_url(mut self, url: url::Url) -> Self { /* ... */ }
    pub fn timeout(mut self, dur: Duration) -> Self { /* ... */ }
    pub fn retry(mut self, policy: RetryPolicy) -> Self { /* ... */ }
    pub fn user_agent(mut self, ua: impl Into<String>) -> Self { /* ... */ }

    /// Temporarily restore `Authorization: Bearer` for one deprecation window.
    /// Removed in 0.3.0 per ADR-0006 §deprecation.
    #[deprecated(since = "0.2.0", note = "use X-API-Key; Bearer removed in 0.3.0")]
    pub fn use_bearer_auth(mut self, yes: bool) -> Self { /* ... */ }

    pub fn build(self) -> Result<Client, Error> { /* ... */ }
}
```

### 2.3 `SeedClient` and `SeedClientBuilder` (feature = "seed")

```rust
// src/seed/mod.rs
#![cfg(feature = "seed")]

use std::time::Duration;

use crate::auth::SeedCredential;
use crate::error::Error;
use crate::retry::RetryPolicy;

pub mod custody;
pub mod optimizer;
pub mod delivery;
pub mod pairing;
pub mod sensor;
pub mod coherence;
pub mod thermal;
pub mod types;

pub use types::{
    ActuatorList, BoundaryReport, CoherenceProfile, DeltaHistory, DriftStatus,
    OptimizerMetrics, PairInit, PairComplete, PairStatus, SensorEmbedding,
    Status, StoreQueryResult, StoreStatus, StoreUpsert, ThermalState,
    WitnessChain, WitnessProof,
};

/// Seed-direct client for `https://<host>:8443/api/v1/*`.
///
/// Default host: `169.254.42.1` (USB gadget) on port 8443.
#[derive(Debug, Clone)]
pub struct SeedClient {
    inner: std::sync::Arc<SeedInner>,
}

#[derive(Debug)]
struct SeedInner {
    http: reqwest::Client,
    base_url: url::Url,
    credential: SeedCredential,
    retry: RetryPolicy,
    timeout: Duration,
}

impl SeedClient {
    pub fn builder() -> SeedClientBuilder { SeedClientBuilder::default() }

    // ── ubiquitous-language resource accessors ────────────────────────
    pub fn status(&self) -> custody::StatusResource<'_> { /* ... */ }
    pub fn identity(&self) -> custody::IdentityResource<'_> { /* ... */ }
    pub fn witness(&self) -> custody::WitnessResource<'_> { /* ... */ }
    pub fn custody(&self) -> custody::CustodyResource<'_> { /* ... */ }
    pub fn store(&self) -> optimizer::StoreResource<'_> { /* ... */ }
    pub fn optimize(&self) -> optimizer::OptimizeResource<'_> { /* ... */ }
    pub fn boundary(&self) -> optimizer::BoundaryResource<'_> { /* ... */ }
    pub fn delivery(&self) -> delivery::DeliveryResource<'_> { /* ... */ }
    pub fn delta(&self) -> delivery::DeltaResource<'_> { /* ... */ }
    pub fn pair(&self) -> pairing::PairResource<'_> { /* ... */ }
    pub fn sensor(&self) -> sensor::SensorResource<'_> { /* ... */ }
    pub fn coherence(&self) -> coherence::CoherenceResource<'_> { /* ... */ }
    pub fn thermal(&self) -> thermal::ThermalResource<'_> { /* ... */ }
}

/// Fluent builder for [`SeedClient`].
#[derive(Debug, Default)]
#[non_exhaustive]
pub struct SeedClientBuilder {
    host: Option<String>,
    port: Option<u16>,
    pairing_token: Option<secrecy::SecretString>,
    client_cert_pem: Option<Vec<u8>>,
    client_key_pem: Option<secrecy::SecretVec<u8>>,
    trust_root_pem: Option<Vec<u8>>,
    /// Allow self-signed cert for default seed hostnames only (ADR-0007).
    allow_default_self_signed: bool,
    dangerously_insecure: bool,
    timeout: Option<Duration>,
    retry: Option<RetryPolicy>,
}

impl SeedClientBuilder {
    pub fn host(mut self, host: impl Into<String>) -> Self { /* ... */ }
    pub fn port(mut self, port: u16) -> Self { /* ... */ }
    pub fn pairing_token(mut self, token: impl Into<String>) -> Self { /* ... */ }
    pub fn client_cert_pem(
        mut self,
        cert: impl Into<Vec<u8>>,
        key: impl Into<Vec<u8>>,
    ) -> Self { /* ... */ }
    pub fn trust_root_pem(mut self, pem: impl Into<Vec<u8>>) -> Self { /* ... */ }
    pub fn timeout(mut self, dur: Duration) -> Self { /* ... */ }
    pub fn retry(mut self, policy: RetryPolicy) -> Self { /* ... */ }

    pub fn build(self) -> Result<SeedClient, Error> { /* ... */ }
}
```

### 2.4 Representative seed method signatures (ubiquitous language)

Terms MUST match `/home/ruvultra/projects/sdks/docs/adr/ddd/seed-domain.md` §1.

```rust
// pairing
impl<'c> pairing::PairResource<'c> {
    pub async fn status(&self) -> Result<PairStatus, Error>;                    // GET    /api/v1/pair/status
    pub async fn init(&self, client_name: &str) -> Result<PairComplete, Error>; // POST   /api/v1/pair
    pub async fn unpair(&self, client_name: &str) -> Result<(), Error>;         // DELETE /api/v1/pair/{client_name}
}

// vector store
impl<'c> optimizer::StoreResource<'c> {
    pub async fn status(&self) -> Result<StoreStatus, Error>;                              // GET  /api/v1/store/status
    pub async fn ingest(&self, upsert: &StoreUpsert) -> Result<StoreIngestAck, Error>;     // POST /api/v1/store/ingest
    pub async fn query(&self, vector: &[f32], k: u32)
        -> Result<StoreQueryResult, Error>;                                                // POST /api/v1/store/query
    pub async fn delete(&self, ids: &[u64]) -> Result<StoreDeleteAck, Error>;              // POST /api/v1/store/delete
}

// witness
impl<'c> custody::WitnessResource<'c> {
    pub async fn chain(&self) -> Result<WitnessChain, Error>;                   // GET  /api/v1/witness/chain
    pub async fn verify(&self) -> Result<WitnessProof, Error>;                  // POST /api/v1/witness/verify
}

// delta SSE (feature = "stream")
#[cfg(feature = "stream")]
impl<'c> delivery::DeltaResource<'c> {
    /// Yields `Error::NotImplemented` until the seed ships SSE (OQ-3).
    pub async fn stream(&self) -> Result<
        impl futures_util::Stream<Item = Result<crate::sse::Event, Error>> + 'c,
        Error,
    >;
    pub async fn history(&self) -> Result<DeltaHistory, Error>;                 // GET /api/v1/delta/history
}
```

## Consequences

### Positive

- One file answers "how is this crate laid out?" — reviewers can diff a
  PR against the tree in §1.1.
- `#[non_exhaustive]` on every public data type (here and in 0014d §4)
  makes the 1.0 ship possible without painting ourselves into a corner.
- `default-features = false` on `reqwest` ends the silent native-tls
  default regression.

### Negative / trade-offs

- File moves touch every existing `use` statement in `tests/` and
  downstream crates. Pre-1.0 break, called out in 0014c §14.
- Builder-only construction removes the `ClientConfig` struct literal —
  deprecation flag bridges two minor releases.

### Neutral

- Resource method names unchanged for cloud; only module path shifts.

## Alternatives considered

| Option | Why rejected |
|--------|--------------|
| Keep flat `src/` layout, scope by filename prefix | obscures cloud vs seed split per ADR-0011 |
| Separate `cognitum-seed-rs` crate | ADR-0011 §Rust already decides one-crate-two-features |
| `async-std` runtime | ecosystem fragmentation; ADR-0010 rejects |
| Expose `api/v1/` prefix as builder knob | forbidden by ADR-0006 §wire |

## Compliance / verification

- `cargo check --no-default-features --features rustls` — cloud-only.
- `cargo check --no-default-features --features "rustls seed"` — full.
- `cargo check --no-default-features --features "rustls seed stream"` — SSE.
- CI forbids `Authorization: Bearer` anywhere in `src/` outside
  `src/auth.rs` (ADR-0003 §Compliance).
- `cargo doc --no-deps` must build with `#![deny(missing_docs)]` clean.

## References

- ADR-0002 (wire), 0003 (auth), 0004 (errors), 0006 (versioning), 0010
  (architecture), 0011 (scope), 0007 (security).
- DDD: `/home/ruvultra/projects/sdks/docs/adr/ddd/seed-domain.md`
- Current source:
  `/home/ruvultra/projects/sdks/sdks/rust/Cargo.toml:1-23`,
  `/home/ruvultra/projects/sdks/sdks/rust/src/lib.rs:25-37`,
  `/home/ruvultra/projects/sdks/sdks/rust/src/client.rs:17-241`.
- Continues in `0014d-rust-sdk-implementation-wire-types-and-errors.md`.
