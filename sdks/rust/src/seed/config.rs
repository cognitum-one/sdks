//! Builder-side configuration types for [`SeedClient`](super::SeedClient).
//!
//! Phase 1 of ADR-0011 (single-seed mode) ships fully; the mesh shape is
//! locked but [`Routing::Balanced`] / [`Routing::Failover`] return
//! [`Error::NotImplemented`](crate::Error::NotImplemented) at build time.
//!
//! Shape intentionally mirrors ADR-0016 so the builder signature does not
//! need to change when Phase 1.5 lands.

use std::fmt;
use std::time::Duration;

pub use super::token_book::SecretString;

/// Authentication mode for a [`SeedClient`](super::SeedClient).
///
/// Unpaired reads are always allowed against the WiFi-read allowlist per
/// ADR-0003 §"WiFi-read allowlist"; this enum attaches a pairing token
/// (or reserves space for mTLS) on top.
///
/// Token material is wrapped in [`SecretString`] per
/// [cognitum-one/sdks#19] so that `{:?}` / tracing dumps do not leak the
/// raw token. Use [`SeedAuth::pairing_token`] to construct and
/// `SecretString::as_str()` on the request path when the string value is
/// required (e.g. sending an `X-Pairing-Token` header).
///
/// [cognitum-one/sdks#19]: https://github.com/cognitum-one/sdks/issues/19
#[derive(Clone, Default)]
#[non_exhaustive]
pub enum SeedAuth {
    /// No pairing token — only unauthenticated reads are allowed. The first
    /// write will 403 with `AuthReason::NotPaired`.
    #[default]
    None,
    /// `X-Pairing-Token: <token>` per ADR-0003 §"Seed auth".
    PairingToken(SecretString),
    // Future: MTls { cert_pem: Vec<u8>, key_pem: Vec<u8> } — reserved.
}

impl fmt::Debug for SeedAuth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SeedAuth::None => f.write_str("SeedAuth::None"),
            // Never print the token value — #19 security fix.
            SeedAuth::PairingToken(_) => f.write_str("SeedAuth::PairingToken(<redacted>)"),
        }
    }
}

impl SeedAuth {
    /// Build a pairing-token auth from any string-like value. The inner
    /// token is wrapped in [`SecretString`] — the raw value will not
    /// appear in `{:?}` dumps or `tracing::debug!` logs.
    pub fn pairing_token(token: impl Into<String>) -> Self {
        SeedAuth::PairingToken(SecretString::new(token))
    }
}

/// TLS posture for a [`SeedClient`](super::SeedClient).
///
/// * `System`   — use the OS / webpki trust store (production cloud-signed).
/// * `Pinned`   — trust exactly one custom CA (PEM-encoded). Disables the
///   system trust store.
/// * `Insecure` — accept any certificate. **Development only.** Emits a
///   one-shot `log::warn!` and maps to `reqwest::ClientBuilder::danger_accept_invalid_certs(true)`
///   per ADR-0007 §TLS.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub enum SeedTls {
    /// OS / webpki trust store.
    #[default]
    System,
    /// Pinned CA (PEM-encoded).
    Pinned(Vec<u8>),
    /// Accept invalid / self-signed certificates. Development only.
    Insecure,
}

/// Routing strategy across a [`PeerSet`](super::peers::PeerSet).
///
/// Phase 1.5 default is `Session` (closest-first, sticky reads per
/// ADR-0016a §D2). `Pinned`, `Balanced`, and `Failover` are retained so
/// existing call sites that set them explicitly keep compiling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum Routing {
    /// Closest-first with session-sticky reads. Phase 1.5 default.
    #[default]
    Session,
    /// Always target the first endpoint in the peer set. Phase 1 alias;
    /// behaves identically to `Session` when N == 1.
    Pinned,
    /// Best-live peer with per-call round-robin opt-in (Phase 1.5).
    Balanced,
    /// Primary endpoint with failover to alternates on error (Phase 1.5).
    Failover,
}

/// Failover posture (reserved for Phase 1.5). Shape locked so builders
/// that set [`Routing::Failover`] do not need to change later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct Failover {
    /// Maximum peers to try before surfacing an error.
    pub max_hops: u8,
    /// Gap between hops (milliseconds).
    pub hop_delay_ms: u32,
}

/// Split-phase timeouts per ADR-0002 §"Transport posture".
///
/// `connect` defaults to 5s, `read` defaults to 30s, `total` defaults to
/// 60s. Streams are uncapped (not modeled here).
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub struct Timeouts {
    /// TCP + TLS handshake budget.
    pub connect: Duration,
    /// Single-response read budget.
    pub read: Duration,
    /// Wall-clock ceiling including retries.
    pub total: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(5),
            read: Duration::from_secs(30),
            total: Duration::from_secs(60),
        }
    }
}

/// Per-call routing / timing overrides (Phase 2 — ADR-0016b §"Per-call
/// knobs").
///
/// Every field is `Option<_>` so `CallOptions::default()` is a no-op:
/// each `_with(opts)` flavour of a resource method behaves exactly like
/// its parameterless twin unless the caller sets at least one knob.
///
/// Use-cases:
///
/// * `peer` — pin this one call to a specific peer URL (e.g. to confirm
///   a write landed on the intended node, or to target a slow peer for
///   diagnostics). If the URL is not in the configured [`PeerSet`] the
///   call fails with [`seed_err::config`](super::error::config).
/// * `prefer` — override the closest-first routing for this call only.
/// * `consistency` — request a consistency posture. `Strong` is rejected
///   (the seed has no quorum); `Eventual` opts out of session stickiness
///   just for this call.
/// * `timeout` / `retries` — narrow the per-call budget without touching
///   the builder-level defaults.
///
/// `#[non_exhaustive]` so future fields (e.g. `prefer_role`) can be added
/// without bumping the SemVer major.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct CallOptions {
    /// Pin this call to the named peer URL (must be in the configured
    /// [`PeerSet`](super::peers::PeerSet)). When `None`, routing falls
    /// back to `prefer` / the session pin / [`PeerSet::pick`].
    pub peer: Option<String>,
    /// Override the preferred peer-picking strategy for this call only.
    pub prefer: Option<Prefer>,
    /// Consistency posture. `Strong` returns
    /// [`seed_err::unsupported`](super::error::unsupported); the seed has
    /// no quorum layer.
    pub consistency: Option<Consistency>,
    /// Per-call read timeout. Overrides the builder-level `Timeouts::read`
    /// for this call only. The total / connect budgets are unaffected.
    pub timeout: Option<Duration>,
    /// Per-call retry count. `None` = use the builder default, `Some(0)` =
    /// no retries, `Some(n)` = at most `n`.
    pub retries: Option<u32>,
}

impl CallOptions {
    /// Convenience constructor identical to `CallOptions::default()`.
    pub fn new() -> Self {
        Self::default()
    }

    /// Set [`Self::peer`] fluently.
    pub fn peer(mut self, url: impl Into<String>) -> Self {
        self.peer = Some(url.into());
        self
    }

    /// Set [`Self::prefer`] fluently.
    pub fn prefer(mut self, prefer: Prefer) -> Self {
        self.prefer = Some(prefer);
        self
    }

    /// Set [`Self::consistency`] fluently.
    pub fn consistency(mut self, c: Consistency) -> Self {
        self.consistency = Some(c);
        self
    }

    /// Set [`Self::timeout`] fluently.
    pub fn timeout(mut self, d: Duration) -> Self {
        self.timeout = Some(d);
        self
    }

    /// Set [`Self::retries`] fluently.
    pub fn retries(mut self, n: u32) -> Self {
        self.retries = Some(n);
        self
    }
}

/// Peer-picking strategy (ADR-0016b §"Per-call knobs").
///
/// This is a *per-call* override; the client-wide [`Routing`] default
/// still applies when a call does not supply [`CallOptions::prefer`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Prefer {
    /// Closest-first (default): lowest-latency Healthy peer. Matches the
    /// Phase 1.5 `Routing::Session` behaviour.
    Closest,
    /// Prefer the lowest-list-index (first configured) peer regardless of
    /// latency; useful for pinning to a canonical seed.
    LocalFirst,
    /// Pick a peer uniformly at random from the `Healthy`/`Degraded` set.
    Random,
    /// No preference — whatever the current PeerSet picker returns.
    /// Alias for "let the default routing run".
    Any,
}

/// Consistency posture requested for a single call (ADR-0016b
/// §"Per-call knobs").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Consistency {
    /// Session-sticky reads (SDK default). Returns latest-observed by
    /// this SeedClient / SeedSession.
    Session,
    /// No stickiness. The SDK will route fresh on each call — useful
    /// when reading from whichever peer is nearest-available.
    Eventual,
    /// Quorum-linearizable reads. **Unsupported** — the seed has no
    /// quorum layer. The SDK returns
    /// [`seed_err::unsupported`](super::error::unsupported) immediately
    /// without hitting the network.
    Strong,
}
