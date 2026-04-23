//! Peer discovery providers (ADR-0016a §D6, ADR-0016b §"Discovery providers").
//!
//! Phase 3 — the "opt-in upgrade path" deferred from Phase 1.5. The Phase 1
//! contract (explicit peer list via `SeedClientBuilder::endpoints()`) stays
//! as-is; [`SeedClientBuilder::discovery`](super::SeedClientBuilder::discovery)
//! is an alternative entry point that yields the same underlying
//! [`PeerSet`](super::peers::PeerSet) at build time.
//!
//! # Providers
//!
//! * [`Explicit`] — wraps a `Vec<String>` of endpoint URLs. Zero-dep, always
//!   available. Equivalent to calling `.endpoints(&[...])`.
//! * [`mdns::MdnsDiscovery`] (feature = `mdns`) — one-shot DNS-SD query
//!   against `_cognitum._tcp.local.`. Parses the TXT record emitted by
//!   `seed/src/cognitum-agent/src/discovery.rs:137-180` (`id`, `port`,
//!   `epoch`, `vectors`, `fp`) into a set of [`DiscoveredPeer`]s.
//!
//! Custom providers are a stable public interface: any type that `impl`s
//! [`Discovery`] + `Send + Sync + 'static` can be handed to
//! `.discovery(...)` on the builder.
//!
//! # Rediscovery
//!
//! When a client is built via `.discovery(...)`,
//! [`SeedClient::rediscover`](super::SeedClient::rediscover) invokes
//! [`Discovery::discover`] and rebuilds the `PeerSet` from the returned
//! list. Session pins (peer URLs recorded via
//! [`SeedClient::session`](super::SeedClient::session)) survive across a
//! rediscovery as long as the pinned URL is still present in the new set.

use std::fmt;

use crate::error::Error;

#[cfg(feature = "mdns")]
pub mod mdns;

#[cfg(feature = "mdns")]
pub use mdns::MdnsDiscovery;

// `TailscaleDiscovery` has no feature flag — it only needs
// `std::process::Command` + `tokio::task::spawn_blocking`, which are
// already available via the base `seed` feature. See
// `src/seed/discovery/tailscale.rs` for rationale.
pub mod tailscale;
pub use tailscale::TailscaleDiscovery;

/// Discovery provider contract (ADR-0016a §D6).
///
/// Implementations MUST be `Send + Sync` — the SDK can call `discover()`
/// from any tokio worker. `close()` is optional; the default impl is a
/// no-op for providers that hold no resources.
///
/// # Error semantics
///
/// Providers should return `Error::Validation(...)` for caller-visible
/// config problems (bad host, malformed TXT, empty list when the caller
/// expected at least one seed). Transient network failures (multicast
/// dropped, resolver timeout) should either retry internally or surface
/// as `Error::Api { code: 0, ... }` so the caller can decide whether to
/// fall back to a stored list.
#[async_trait::async_trait]
pub trait Discovery: Send + Sync + fmt::Debug {
    /// Resolve the current set of peers.
    ///
    /// Called at `SeedClient::build()` time (via the builder) and again
    /// whenever [`SeedClient::rediscover`](super::SeedClient::rediscover)
    /// is invoked. Each call is expected to do its own I/O — providers
    /// SHOULD NOT cache results between calls without an explicit TTL.
    async fn discover(&self) -> Result<Vec<DiscoveredPeer>, Error>;

    /// Release any resources held by the provider.
    ///
    /// Called when the owning [`SeedClient`](super::SeedClient) is
    /// dropped. Default: no-op. Providers that spawn background threads
    /// (e.g. mDNS responders) should implement this to signal shutdown
    /// cleanly.
    async fn close(&self) -> Result<(), Error> {
        Ok(())
    }
}

/// One peer resolved by a [`Discovery`] provider.
///
/// `url` MUST be an absolute `http://` or `https://` URL accepted by
/// [`Endpoint::parse`](super::peers::Endpoint::parse). `device_id` and
/// `latency_ms` are informational — the request loop does not consult
/// them for routing decisions, but tests / observability may.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct DiscoveredPeer {
    /// Endpoint base URL — e.g. `https://seed-a.local:8443`.
    pub url: String,
    /// Seed device identifier parsed from the TXT record, when available.
    pub device_id: Option<String>,
    /// One-shot probe latency in milliseconds, when the provider measures
    /// it. mDNS typically records wall time to the first `ServiceFound`
    /// event; `Explicit` leaves this `None`.
    pub latency_ms: Option<u32>,
    /// SHA-256 cert fingerprint parsed from the `fp=sha256:<hex>` TXT
    /// record key (seed mDNS advert — `seed/src/cognitum-agent/src/discovery.rs`).
    /// Stored as a lowercased hex string without colons so it compares
    /// stably regardless of case. Used by the
    /// [`FingerprintPinVerifier`](super::tls_pin::FingerprintPinVerifier)
    /// to pin the per-peer rustls handshake on link-local self-signed
    /// seeds. `None` for providers that cannot observe the fingerprint
    /// (e.g. [`Explicit`]).
    pub tls_fingerprint: Option<String>,
}

impl DiscoveredPeer {
    /// Build a peer with just a URL. `device_id` / `latency_ms` /
    /// `tls_fingerprint` are `None`.
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            device_id: None,
            latency_ms: None,
            tls_fingerprint: None,
        }
    }

    /// Attach a device ID.
    pub fn with_device_id(mut self, id: impl Into<String>) -> Self {
        self.device_id = Some(id.into());
        self
    }

    /// Attach an observed probe latency.
    pub fn with_latency_ms(mut self, ms: u32) -> Self {
        self.latency_ms = Some(ms);
        self
    }

    /// Attach a SHA-256 cert fingerprint. Accepts any case; stored
    /// lowercased without colons.
    pub fn with_tls_fingerprint(mut self, fp: impl Into<String>) -> Self {
        self.tls_fingerprint = Some(normalize_fingerprint(&fp.into()));
        self
    }
}

/// Normalise a TXT-record fingerprint to a lowercased hex string with no
/// `sha256:` prefix and no colons. Public-in-module so the mDNS parser
/// and the verifier agree on a single canonical form.
pub(crate) fn normalize_fingerprint(raw: &str) -> String {
    let trimmed = raw.trim();
    let without_prefix = trimmed
        .strip_prefix("sha256:")
        .or_else(|| trimmed.strip_prefix("SHA256:"))
        .unwrap_or(trimmed);
    without_prefix
        .chars()
        .filter(|c| *c != ':')
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Zero-dep provider that returns a fixed list of URLs.
///
/// Equivalent to calling
/// [`SeedClientBuilder::endpoints`](super::SeedClientBuilder::endpoints),
/// but plugged through the [`Discovery`] trait so callers can swap it
/// for [`MdnsDiscovery`] or a custom impl without touching the builder
/// chain.
#[derive(Debug, Clone)]
pub struct Explicit {
    urls: Vec<String>,
}

impl Explicit {
    /// Build from a slice of string-likes.
    pub fn new<S: AsRef<str>>(urls: &[S]) -> Self {
        Self {
            urls: urls.iter().map(|u| u.as_ref().to_owned()).collect(),
        }
    }

    /// Build from an owned `Vec<String>` without extra allocation.
    pub fn from_vec(urls: Vec<String>) -> Self {
        Self { urls }
    }

    /// Number of configured URLs.
    pub fn len(&self) -> usize {
        self.urls.len()
    }

    /// Whether the configured list is empty.
    pub fn is_empty(&self) -> bool {
        self.urls.is_empty()
    }
}

#[async_trait::async_trait]
impl Discovery for Explicit {
    async fn discover(&self) -> Result<Vec<DiscoveredPeer>, Error> {
        Ok(self.urls.iter().map(DiscoveredPeer::new).collect())
    }
}

// Small re-export of async_trait so consumers who `impl Discovery` in
// their own crate don't need a parallel dep declaration. The crate is
// tiny and already pulled in transitively by reqwest's dev-dependency
// chain in the test tree, so this is effectively free.
#[doc(hidden)]
pub use async_trait::async_trait;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn explicit_returns_exact_list() {
        let d = Explicit::new(&["https://a:8443", "https://b:8443"]);
        let peers = d.discover().await.expect("discover");
        assert_eq!(peers.len(), 2);
        assert_eq!(peers[0].url, "https://a:8443");
        assert_eq!(peers[1].url, "https://b:8443");
        // Explicit never populates device_id / latency_ms.
        assert!(peers[0].device_id.is_none());
        assert!(peers[0].latency_ms.is_none());
    }

    #[tokio::test]
    async fn explicit_empty_is_allowed_here_caller_validates() {
        // `Explicit` itself doesn't reject the empty list — the
        // `SeedClientBuilder::build()` path surfaces the error with a
        // clearer message ("at least one .endpoint(...) is required").
        let d = Explicit::from_vec(vec![]);
        let peers = d.discover().await.unwrap();
        assert!(peers.is_empty());
    }

    #[tokio::test]
    async fn discovered_peer_builder_is_fluent() {
        let p = DiscoveredPeer::new("https://x:8443")
            .with_device_id("abc")
            .with_latency_ms(42)
            .with_tls_fingerprint("sha256:AA:BB:CC");
        assert_eq!(p.url, "https://x:8443");
        assert_eq!(p.device_id.as_deref(), Some("abc"));
        assert_eq!(p.latency_ms, Some(42));
        assert_eq!(p.tls_fingerprint.as_deref(), Some("aabbcc"));
    }

    #[test]
    fn normalize_fingerprint_handles_prefix_and_case() {
        assert_eq!(normalize_fingerprint("sha256:AA:BB"), "aabb");
        assert_eq!(normalize_fingerprint("SHA256:AaBb"), "aabb");
        assert_eq!(normalize_fingerprint("aabb"), "aabb");
        assert_eq!(normalize_fingerprint("  sha256:CC:DD  "), "ccdd");
    }
}
