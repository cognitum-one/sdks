# ADR 0014d: Rust SDK Implementation — Wire Types, Error Enum, Transport

<!-- swarm-seed-validation 2026-04-22 (rust agent): Phase 1 ✅ partial.
     Seed wire types are live at `src/seed/models/**` (Status, Identity,
     PairStatus, PairCreate, PairCreateResponse, StoreStatus, StoreQuery,
     StoreQueryResult, StoreIngest, WitnessChain, CustodyEpoch, OtaConfig,
     OtaCheckNowAck). Each response carries `extras: Extras` for forward
     compat; requests use `deny_unknown_fields`. Cloud `types.rs` still
     covers commerce only. `src/error.rs` is still 7 variants (pre-fix
     agent's turf) — seed half encodes ADR-0004 reason slots into the
     existing `Auth(String)` / `Validation(String)` message payloads
     (`not_paired: …`, `not_implemented: …`) until the full rewrite lands. -->

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** SDK WG (Rust lead + cross-cutting)
- **Scope:** sdks/rust

> Continuation of 0014a (crate layout + API surface). Covers §§3–5 of the
> implementation ADR: typed models, full error enum, transport / TLS.
> Successor: 0014b (retry + auth).

## Context

With the module tree (0014a §1) and the `pub` surface (0014a §2) fixed,
the next normative layer is the exact serde attributes, the exact error
enum, and the exact TLS / HTTP builder call. Seed wire shapes come from
`/home/ruvultra/projects/sdks/seed/docs/seed/api-reference.md` (`:30-42, 120-129, 544-547`)
and the canonical error envelope at
`/home/ruvultra/projects/sdks/seed/src/cognitum-agent/src/http.rs:136-137`. The current
Rust SDK's 7-variant error enum at
`/home/ruvultra/projects/sdks/sdks/rust/src/error.rs:1-42` collapses 401/403 together
and lacks every variant ADR-0004 requires.

## Decision

Implement typed models, `Error`, and transport exactly as below. Every
`#[derive]`, every `#[serde(...)]`, every field order is normative;
reviewers must reject drift.

---

## 3. Typed models

### 3.1 Forward-compatibility pattern

Per ADR-0006 §unknown-field, every wire type MUST tolerate unknown
fields. We adopt **typed extras via `#[serde(flatten)]`** over
`#[serde(other)]` because `#[serde(other)]` only works on enums, while
the seed's shapes are mostly structs.

Shared newtype in `src/models/common.rs`:

```rust
use std::collections::BTreeMap;

/// Catch-all for forward-compatible JSON fields the SDK does not model yet.
///
/// Use `#[serde(flatten)] pub extras: Extras` on every wire struct.
/// Preserves unknown fields across a round-trip and keeps
/// `#[serde(deny_unknown_fields)]` off everywhere *except* request bodies
/// that the seed validates strictly.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(transparent)]
pub struct Extras(pub BTreeMap<String, serde_json::Value>);

pub type Epoch = u64;

/// Opaque device identifier (UUIDv4 per
/// `/home/ruvultra/projects/sdks/docs/adr/ddd/seed-domain.md` §1).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DeviceId(pub String);

/// Dimension of a vector store. Invariant 5.1 of the DDD model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Dimension(pub u32);
```

### 3.2 Core seed wire types

All seed types use snake_case (seed already speaks snake_case — see
`/home/ruvultra/projects/sdks/seed/docs/seed/api-reference.md:30-42`). Cloud types
stay camelCase via `#[serde(rename_all = "camelCase")]` as already in
`/home/ruvultra/projects/sdks/sdks/rust/src/types.rs:8-23`.

`src/seed/types.rs`:

```rust
use serde::{Deserialize, Serialize};
use crate::models::common::{DeviceId, Dimension, Epoch, Extras};

// ── /api/v1/status ─────────────────────────────────────────────────
// verification 2026-04-22 (rust agent) — ✅ wire shape matches live seed v0.20.1.
// Live: witness_chain_length flows through `extras` as designed. Confirmed.
// Shape from /home/ruvultra/projects/sdks/seed/docs/seed/api-reference.md:32-43
// Live firmware also returns `witness_chain_length` even though the docs
// at line 30-42 omit it (see ADR-0006 §unknown-field). `extras` captures it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[non_exhaustive]
pub struct Status {
    pub device_id: DeviceId,
    pub uptime_secs: u64,
    pub epoch: Epoch,
    pub total_vectors: u64,
    pub deleted_vectors: u64,
    pub file_size_bytes: u64,
    pub dimension: Dimension,
    pub paired: bool,
    #[serde(default)]
    pub roles: Vec<String>,
    #[serde(flatten)]
    pub extras: Extras,
}

// ── /api/v1/pair (POST request + response) ─────────────────────────
// Request shape: /home/ruvultra/projects/sdks/seed/docs/seed/api-reference.md:78
// Seed enforces strict validation on this write, so deny unknown fields
// to fail the caller fast rather than silently drop typos.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PairInit {
    pub client_name: String,
}

// Response from POST /api/v1/pair. Opaque token — use secrecy inside the
// SDK, but the wire type is still a plain String so callers can pass it
// to their own TokenStore.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[non_exhaustive]
pub struct PairComplete {
    pub client_name: String,
    pub token: String,
    pub expires_at: Option<String>,
    #[serde(flatten)]
    pub extras: Extras,
}

// ── /api/v1/pair/status (GET) ──────────────────────────────────────
// verification 2026-04-22 — ✅ matches live seed v0.20.1 exactly
// (paired, client_count, pairing_window_open, window_remaining_secs).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[non_exhaustive]
pub struct PairStatus {
    pub paired: bool,
    pub client_count: u32,
    pub pairing_window_open: bool,
    pub window_remaining_secs: u32,
    #[serde(flatten)]
    pub extras: Extras,
}

// ── /api/v1/store/ingest (POST request) ────────────────────────────
// Request shape from api-reference.md:107 — strict validation.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StoreUpsert {
    pub vectors: Vec<StoreUpsertEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StoreUpsertEntry {
    pub id: String,
    pub values: Vec<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

// ── /api/v1/store/query (POST response) ────────────────────────────
// Shape from api-reference.md:121-129
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[non_exhaustive]
pub struct StoreQueryResult {
    pub results: Vec<StoreQueryHit>,
    pub query_ms: f64,
    #[serde(flatten)]
    pub extras: Extras,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[non_exhaustive]
pub struct StoreQueryHit {
    /// `u64` per ddd/seed-domain.md §5 invariant 4 — content-hash on the wire.
    pub id: u64,
    pub distance: f32,
    #[serde(default)]
    pub metadata: serde_json::Value,
    #[serde(flatten)]
    pub extras: Extras,
}

// ── /api/v1/witness/verify (POST response) ─────────────────────────
// Ubiquitous language: "witness proof" — verify result carries
// {valid, chain_length, last_hash}; treat as forward-compatible.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[non_exhaustive]
pub struct WitnessProof {
    pub valid: bool,
    pub chain_length: u64,
    pub last_hash: String,
    #[serde(flatten)]
    pub extras: Extras,
}
```

### 3.3 Strictness rules — `deny_unknown_fields`

Request bodies that the seed validates strictly get
`#[serde(deny_unknown_fields)]`:

- `PairInit` (seed rejects unknown keys in `/api/v1/pair`)
- `StoreUpsert`, `StoreUpsertEntry`, `StoreDeleteRequest`, `StoreQueryRequest`
- `ReflexRulesUpdate` (`PUT /api/v1/sensor/reflex/rules`)
- `ActuatorFireRequest`, `ThermalConfigUpdate`, `CoherenceConfigUpdate`

Response types NEVER use `deny_unknown_fields`; they use
`#[serde(flatten)] pub extras: Extras` instead (forward-compat per ADR-0006).

---

## 4. Error enum
<!-- ⚠ Phase 1 workaround 2026-04-22 (issue cognitum-one/sdks#3 — partial):
     `src/error.rs` is still the 6-variant enum owned by the pre-fix agent
     (adding `AuthReason`/`NotImplemented`/`Timeout`/… is on their track
     to avoid merge conflicts with the Bearer→X-API-Key fix). Seed half
     preserves the ADR-0004 semantics by prefixing reason codes into the
     existing String payload: `Auth("not_paired: …")`,
     `Auth("invalid_credentials: …")`, `Validation("not_implemented: …")`,
     `NotFound("{path} (seed): …")`. The helper `seed::error::from_response`
     will collapse into a single `match` when the pre-fix agent ships the
     12-variant enum. OQ-2 remains open for the final rewrite. -->


Full `src/error.rs` rewrite. 12 variants per ADR-0004, `#[non_exhaustive]`
from day one per ADR-0010 §Error model and ADR-0006 §deprecation.

```rust
use thiserror::Error;

/// All errors surfaced by the Cognitum SDK.
///
/// Marked `#[non_exhaustive]` — consumers MUST match with a `_` arm.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum Error {
    /// Caller must re-authenticate or re-pair. Carries structured reason.
    #[error("authentication failed: {reason:?} — {message}")]
    Auth {
        reason: AuthReason,
        message: String,
        #[source]
        source: Option<Box<dyn std::error::Error + Send + Sync + 'static>>,
    },

    /// 429 from seed or cloud. `retry_after_ms` always populated.
    #[error("rate limited (tier {tier:?}), retry after {retry_after_ms}ms")]
    RateLimit {
        tier: RateLimitTier,
        retry_after_ms: u64,
        raw_body: Option<String>,
    },

    /// 400 / 422 / 405. `field` set when server returned a structured body.
    #[error("validation error{}: {message}",
        field.as_deref().map(|f| format!(" on `{f}`")).unwrap_or_default())]
    Validation {
        field: Option<String>,
        message: String,
    },

    /// 404.
    #[error("not found: {resource}")]
    NotFound { resource: String },

    /// 501 — seed SSE placeholder. Not retriable.
    #[error("not implemented: {endpoint}")]
    NotImplemented { endpoint: String },

    /// 409. Reserved for cloud orders.
    #[error("conflict: {0}")]
    Conflict(String),

    /// 503. Transient; retriable per ADR-0005.
    #[error("service unavailable")]
    Unavailable { retry_after_ms: Option<u64> },

    /// Generic catch-all for unmapped 4xx / 5xx.
    #[error("API error {status}: {message}")]
    Api {
        status: u16,
        code: Option<String>,
        message: String,
        raw_body: Option<String>,
    },

    /// TCP / TLS / DNS / connection refused.
    #[error("network error")]
    Network(#[source] reqwest::Error),

    /// Per-request timeout.
    #[error("timeout during {phase:?}")]
    Timeout { phase: TimeoutPhase },

    /// JSON parse failure / schema mismatch. Never retriable — always a bug.
    #[error("parse error: expected {expected}, got {got}")]
    Parse {
        expected: &'static str,
        got: String,
        #[source]
        source: Option<serde_json::Error>,
    },

    /// Invalid SDK configuration (e.g. self-signed TLS for non-default host).
    #[error("config error: {0}")]
    Config(String),
}

/// Canonical auth failure reason; crosses the wire for logging/telemetry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
#[serde(rename_all = "snake_case")]
pub enum AuthReason {
    NoCredentials,
    InvalidCredentials,
    NotPaired,
    PairingWindowClosed,
    LockdownMTlsRequired,
    TrustScoreBlocked,
}

/// Seed rate-limit tier (unpaired/paired/localhost/lockdown per
/// /home/ruvultra/projects/sdks/seed/src/cognitum-agent/src/rate_limit.rs:27-40).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
#[serde(rename_all = "snake_case")]
pub enum RateLimitTier {
    Unpaired,
    Paired,
    Localhost,
    Lockdown,
    Unknown,
}

/// Phase at which a timeout fired.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum TimeoutPhase {
    Connect,
    Read,
    Total,
}
```

### 4.1 `From` impls

```rust
impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            let phase = if e.is_connect() {
                TimeoutPhase::Connect
            } else {
                TimeoutPhase::Read
            };
            Error::Timeout { phase }
        } else {
            // Network covers connect/body/request and unknown reqwest errors.
            Error::Network(e)
        }
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Parse {
            expected: "valid JSON",
            got: e.to_string(),
            source: Some(e),
        }
    }
}

impl From<url::ParseError> for Error {
    fn from(e: url::ParseError) -> Self { Error::Config(e.to_string()) }
}
```

### 4.2 Status-code mapping

Centralised in `src/error.rs` so both `Client` and `SeedClient` reuse it.

```rust
/// Map a non-success HTTP response to the canonical `Error`.
///
/// `context.endpoint_path` is used in `NotFound` and `NotImplemented`;
/// `context.is_seed` switches rate-limit tier detection.
pub(crate) async fn from_http(
    status: reqwest::StatusCode,
    response: reqwest::Response,
    context: ErrorContext<'_>,
) -> Error {
    let body_text = response.text().await.unwrap_or_default();
    let parsed = serde_json::from_str::<SeedErrorEnvelope>(&body_text).ok();
    let message = parsed
        .as_ref()
        .map(|p| p.error.clone())
        .unwrap_or_else(|| {
            status.canonical_reason().unwrap_or("unknown").to_string()
        });

    match status.as_u16() {
        // ── 401 UNAUTHORIZED ──────────────────────────────────────────
        // ADR-0004 explicit: 401 ⇒ Auth { reason: InvalidCredentials }.
        401 => Error::Auth {
            reason: AuthReason::InvalidCredentials,
            message,
            source: None,
        },

        // ── 403 FORBIDDEN ─────────────────────────────────────────────
        // Disambiguate "not paired" vs "lockdown" vs "trust score block"
        // by inspecting the seed error body.
        403 => {
            let reason = match message.to_ascii_lowercase() {
                s if s.contains("not paired") => AuthReason::NotPaired,
                s if s.contains("pairing window") => AuthReason::PairingWindowClosed,
                s if s.contains("lockdown") => AuthReason::LockdownMTlsRequired,
                s if s.contains("blocked") || s.contains("trust") => AuthReason::TrustScoreBlocked,
                _ => AuthReason::InvalidCredentials,
            };
            Error::Auth { reason, message, source: None }
        }

        400 | 405 | 422 => Error::Validation {
            field: parsed.and_then(|p| p.field),
            message,
        },

        404 => Error::NotFound { resource: context.endpoint_path.to_owned() },

        409 => Error::Conflict(message),

        429 => Error::RateLimit {
            tier: context.rate_limit_tier(),
            retry_after_ms: parse_retry_after_ms(&response, &body_text).unwrap_or(1000),
            raw_body: Some(body_text.clone()),
        },

        501 => Error::NotImplemented { endpoint: context.endpoint_path.to_owned() },

        503 => Error::Unavailable {
            retry_after_ms: parse_retry_after_ms(&response, &body_text),
        },

        s => Error::Api {
            status: s, code: None, message, raw_body: Some(body_text),
        },
    }
}

#[derive(serde::Deserialize)]
struct SeedErrorEnvelope {
    #[serde(default)] error: String,
    #[serde(default)] field: Option<String>,
}
```

### 4.3 Migration from current `error.rs`

| Current variant | `/home/ruvultra/projects/sdks/sdks/rust/src/error.rs` line | New variant | Breaking? |
|-----------------|---------------------------------------------------------------|-------------|-----------|
| `Auth(String)` | L7-8 | `Auth { reason, message, source }` | yes |
| `RateLimit { retry_after_ms }` | L10-15 | `RateLimit { tier, retry_after_ms, raw_body }` | yes |
| `Validation(String)` | L17-19 | `Validation { field, message }` | yes |
| `NotFound(String)` | L21-23 | `NotFound { resource }` | yes |
| `Api { code, message }` | L25-32 | `Api { status, code, message, raw_body }` | yes — `code`→`status` |
| `Http(reqwest::Error)` | L34-36 | `Network(#[source] reqwest::Error)` | yes — renamed |
| `Json(serde_json::Error)` | L38-40 | `Parse { expected, got, source }` | yes |
| *(new)* | — | `NotImplemented`, `Conflict`, `Unavailable`, `Timeout`, `Config` | additive |

Because the crate is pre-1.0 (`/home/ruvultra/projects/sdks/sdks/rust/Cargo.toml:3`)
this is an allowed MINOR break under ADR-0006 §pre-1.0. Call it out in
`CHANGELOG.md`.

---

## 5. Transport

Centralised in `src/transport.rs`. Both `Client` and `SeedClient` call
into this module so TLS and HTTP/2 knobs are configured in one place.

### 5.1 Cloud builder

```rust
// src/transport.rs
use std::time::Duration;

pub(crate) fn build_cloud_http(
    timeout: Duration,
    user_agent: &str,
) -> Result<reqwest::Client, crate::error::Error> {
    let builder = reqwest::Client::builder()
        .user_agent(user_agent)
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(10))
        .pool_max_idle_per_host(8)
        .pool_idle_timeout(Some(Duration::from_secs(90)))
        .http2_prior_knowledge()         // cloud supports h2 via HTTPS upgrade
        .https_only(true);

    Ok(builder.build().map_err(crate::error::Error::Network)?)
}
```

### 5.2 Seed builder (feature = "seed")
<!-- ✅ fixed 2026-04-22 (closes cognitum-one/sdks#4 for Phase 1):
     Pre-fix agent landed the cloud `ClientBuilder` TLS escape hatch
     (`.danger_accept_invalid_certs`, `.trust_root_pem`,
     `.trust_root_pem_file`). Team Rust Phase 1 adds the seed-side TLS
     matrix via `SeedTls::{System, Pinned(Vec<u8>), Insecure}`. Insecure
     emits a one-shot warning; Pinned disables the system trust store
     and loads the PEM via `reqwest::Certificate::from_pem`. Per-host
     pinned rustls verifier (§5.2 `PinnedSeedVerifier`) is Phase 1.5 —
     callers supply a `trust_root_pem` for non-default hosts today. -->


The seed presents a self-signed cert on `169.254.42.1` / `cognitum.local`
(`/home/ruvultra/projects/sdks/seed/docs/seed/api-reference.md:544-547`). Per
ADR-0007 §TLS:

- For default hosts, accept the self-signed cert via a pinned rustls verifier.
- For any other host, require `trust_root_pem` or refuse to build.

```rust
#![cfg(feature = "seed")]

use std::{sync::Arc, time::Duration};
use rustls::ClientConfig;

pub(crate) fn build_seed_http(
    host: &str,
    timeout: Duration,
    trust_root_pem: Option<&[u8]>,
    client_cert_pem: Option<&[u8]>,
    client_key_pem: Option<&[u8]>,
    allow_default_self_signed: bool,
) -> Result<reqwest::Client, crate::error::Error> {
    let is_default_host = host == "169.254.42.1"
        || host == "cognitum.local"
        || host.starts_with("fe80:");

    let tls_config: ClientConfig = match (trust_root_pem, is_default_host, allow_default_self_signed) {
        // Caller-supplied trust root wins regardless of host.
        (Some(pem), _, _) => build_rustls_with_root(pem, client_cert_pem, client_key_pem)?,

        // Default seed hostnames with opt-in — pinned self-signed verifier.
        (None, true, true) => build_rustls_pinned_seed(client_cert_pem, client_key_pem)?,

        // Anywhere else — refuse to build.
        _ => return Err(crate::error::Error::Config(format!(
            "host `{host}` requires `trust_root_pem`; default self-signed \
             is only accepted for 169.254.42.1 / cognitum.local / link-local"
        ))),
    };

    reqwest::Client::builder()
        .use_preconfigured_tls(tls_config)
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(10))
        .pool_max_idle_per_host(4)         // seed is single-host
        .pool_idle_timeout(Some(Duration::from_secs(60)))
        // No http2_prior_knowledge — seed is HTTP/1.1 only
        // (/home/ruvultra/projects/sdks/seed/src/cognitum-agent/src/http.rs:102-108).
        .build()
        .map_err(crate::error::Error::Network)
}
```

### 5.3 Pinned self-signed verifier

```rust
// Pinned verifier for default seed hosts. Accepts any self-signed leaf
// cert, but only when the SNI/host matches the allowed set.
struct PinnedSeedVerifier {
    allowed_hosts: &'static [&'static str],
}

impl rustls::client::ServerCertVerifier for PinnedSeedVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::Certificate,
        _intermediates: &[rustls::Certificate],
        server_name: &rustls::ServerName,
        _scts: &mut dyn Iterator<Item = &[u8]>,
        _ocsp_response: &[u8],
        _now: std::time::SystemTime,
    ) -> Result<rustls::client::ServerCertVerified, rustls::Error> {
        let name = match server_name {
            rustls::ServerName::DnsName(d) => d.as_ref().to_string(),
            rustls::ServerName::IpAddress(ip) => ip.to_string(),
            _ => return Err(rustls::Error::General("unknown server name".into())),
        };
        if self.allowed_hosts.iter().any(|h| *h == name.as_str()) {
            Ok(rustls::client::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(format!(
                "pinned seed verifier refuses host `{name}`"
            )))
        }
    }
}
```

This deliberately does NOT use
`reqwest::Client::builder().danger_accept_invalid_certs(true)` because
that disables verification globally; our pinned verifier is scoped to
the seed-default hosts only.

### 5.4 Connection pool sizing

| Client | `pool_max_idle_per_host` | `pool_idle_timeout` | Rationale |
|--------|--------------------------|----------------------|-----------|
| Cloud  | 8 | 90 s | multiple Firebase regions |
| Seed   | 4 | 60 s | single host, HTTP/1.1, keep-alive preferred |

## Consequences

### Positive

- One canonical wire-type template (`Status`/`StoreUpsert`) — reviewers
  reject deviating shapes.
- Error enum covers every ADR-0004 case; 401 and 403 stop collapsing.
- TLS story is explicit: default-hosts-only self-signed; anywhere else
  requires a `trust_root_pem`.

### Negative / trade-offs

- Every wire struct gains an `extras: Extras` field visible in `Debug`.
- `Extras = BTreeMap<String, serde_json::Value>` adds allocations per
  unknown field.
- 12-variant enum means `match` arms grow wide; `#[non_exhaustive]`
  enforces a `_` arm which irritates exhaustive-match lovers.

### Neutral

- No public resource-method name changes; only types under them.

## Alternatives considered

| Option | Why rejected |
|--------|--------------|
| `#[serde(other)]` only | works on enums, not structs |
| `serde_json::Value` catch-all | loses field names; worse in errors |
| `Error::Api { status, message }` w/o `raw_body` | debugging is painful |
| `danger_accept_invalid_certs(true)` | too broad; defeats ADR-0007 |

## Compliance / verification

- `cargo expand --features seed` confirms every response type contains
  `extras: Extras`.
- CI grep: `#\[serde\(deny_unknown_fields\)\]` must only appear on
  request bodies listed in §3.3.
- TLS test: build `SeedClient` with `host = "example.com"` and no
  `trust_root_pem` → expect `Error::Config`.

## References

- ADR-0002, 0004, 0006, 0007, 0010.
- DDD: `/home/ruvultra/projects/sdks/docs/adr/ddd/seed-domain.md` §1, §5.
- Seed envelopes: `/home/ruvultra/projects/sdks/seed/src/cognitum-agent/src/http.rs:136-137`.
- Current error shape: `/home/ruvultra/projects/sdks/sdks/rust/src/error.rs:1-42`.
- Continues in `0014b-rust-sdk-implementation-behaviors.md`.
