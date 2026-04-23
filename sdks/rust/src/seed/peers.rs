//! Peer set management.
//!
//! Phase 1.5 ships mesh-mode: a [`PeerSet`] of one or more peers with
//! per-peer health / latency tracking. Each [`Peer`] carries its own
//! `state`, `latency_ema_ms`, and `last_used_at` so the routing layer
//! can pick closest-first and cycle on failure per ADR-0016a §D2/§D3.
//!
//! The public types (`Endpoint`, `PeerSet`) continue to expose the
//! Phase 1 surface; mutable internals live behind `&mut self` methods
//! on `PeerSet` that are called from `SeedInner` under a `Mutex`.

use std::time::{Duration, Instant};

use url::Url;

use crate::error::Error;

/// A seed endpoint (base URL).
///
/// Base URL is of the form `https://<host>:<port>` — no trailing slash, no
/// `/api/v1` prefix (resources add their own path). If you pass a URL with
/// a path, the path is kept verbatim and resources concatenate onto it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Endpoint {
    pub(crate) url: Url,
}

impl Endpoint {
    /// Parse `raw` as an absolute HTTP(S) URL. Returns `Error::Validation`
    /// for non-HTTP(S) schemes, missing host, or unparseable input.
    pub fn parse(raw: &str) -> Result<Self, Error> {
        let url = Url::parse(raw)
            .map_err(|e| Error::Validation(format!("invalid seed endpoint `{raw}`: {e}")))?;

        if url.scheme() != "http" && url.scheme() != "https" {
            return Err(Error::Validation(format!(
                "seed endpoint `{raw}` must be http or https, got `{}`",
                url.scheme()
            )));
        }

        if url.host_str().is_none() {
            return Err(Error::Validation(format!(
                "seed endpoint `{raw}` is missing a host"
            )));
        }

        Ok(Self { url })
    }

    /// Inner [`url::Url`].
    pub fn url(&self) -> &Url {
        &self.url
    }

    /// Full URL to `<base>/api/v1<path>`. `path` MUST start with `/`.
    pub(crate) fn join_api(&self, path: &str) -> Result<Url, Error> {
        debug_assert!(path.starts_with('/'), "seed path must be absolute");
        let full = format!("/api/v1{path}");
        self.url
            .join(&full)
            .map_err(|e| Error::Validation(format!("bad seed path `{path}`: {e}")))
    }

    /// Canonical key used by [`TokenBook`](super::token_book::TokenBook)
    /// and the routing layer. Strips a trailing slash for stability.
    pub(crate) fn key(&self) -> String {
        let s = self.url.as_str();
        s.trim_end_matches('/').to_owned()
    }
}

/// Routing-layer peer health state (ADR-0016a §D7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerState {
    /// Last observation succeeded.
    Healthy,
    /// 1-2 consecutive failures; still routable.
    Degraded,
    /// 3+ consecutive failures; skipped unless all peers are unhealthy.
    Unhealthy,
}

impl PeerState {
    fn rank(self) -> u8 {
        match self {
            PeerState::Healthy => 0,
            PeerState::Degraded => 1,
            PeerState::Unhealthy => 2,
        }
    }
}

/// Error class observed on a peer-level request outcome. Informs the
/// failure bookkeeping in [`PeerSet::mark_failure`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerErrorClass {
    /// TCP / TLS / DNS / connect refused — peer looks offline.
    Network,
    /// Connect / read timeout — peer looks offline.
    Timeout,
    /// 5xx family (500 / 502 / 504) — peer misbehaving.
    Server5xx,
    /// 503 Service Unavailable — cycle immediately (ADR-0016a §D3).
    ServiceUnavailable,
}

/// One configured seed endpoint plus its latency / health state.
#[derive(Debug, Clone)]
pub struct Peer {
    /// Constructor-order index (stable regardless of sort order).
    pub list_index: usize,
    /// Endpoint URL.
    pub endpoint: Endpoint,
    /// Routing-layer health.
    pub state: PeerState,
    /// Exponential moving average of observed latency. `None` until the
    /// first success on this peer.
    pub latency_ema_ms: Option<f64>,
    /// Instant of the last dispatch attempt (success or failure).
    pub last_used_at: Option<Instant>,
    /// Consecutive failures — Degraded at >=1, Unhealthy at >=3.
    pub consecutive_failures: u32,
}

impl Peer {
    fn new(list_index: usize, endpoint: Endpoint) -> Self {
        Self {
            list_index,
            endpoint,
            state: PeerState::Healthy,
            latency_ema_ms: None,
            last_used_at: None,
            consecutive_failures: 0,
        }
    }

    /// Stable sort key: (state rank, latency EMA, list_index). Peers with
    /// no EMA sort after peers with a known-fast latency.
    fn sort_key(&self) -> (u8, u64, usize) {
        let ema = self
            .latency_ema_ms
            .map(|v| (v.max(0.0) * 1_000.0) as u64)
            .unwrap_or(u64::MAX / 2);
        (self.state.rank(), ema, self.list_index)
    }
}

/// Ordered peer table. Phase 1 accepts one endpoint; Phase 1.5 accepts
/// 1..N and maintains health/latency per peer.
#[derive(Debug, Clone)]
pub struct PeerSet {
    peers: Vec<Peer>,
}

impl PeerSet {
    /// Single-endpoint constructor. Equivalent to
    /// [`PeerSet::new`](Self::new) with a one-element list.
    pub fn single(endpoint: Endpoint) -> Self {
        Self {
            peers: vec![Peer::new(0, endpoint)],
        }
    }

    /// Phase 1.5 constructor — accepts 1..N endpoints. Order is preserved
    /// as `list_index`.
    pub fn new(endpoints: Vec<Endpoint>) -> Result<Self, Error> {
        if endpoints.is_empty() {
            return Err(Error::Validation(
                "PeerSet requires at least one endpoint".into(),
            ));
        }
        let peers = endpoints
            .into_iter()
            .enumerate()
            .map(|(i, ep)| Peer::new(i, ep))
            .collect();
        Ok(Self { peers })
    }

    /// Phase 1 alias retained for back-compat with earlier code paths.
    pub fn try_from_many(endpoints: Vec<Endpoint>) -> Result<Self, Error> {
        Self::new(endpoints)
    }

    /// The first endpoint (constructor order). Kept for single-peer
    /// call sites that predate mesh routing.
    pub fn primary(&self) -> &Endpoint {
        &self.peers[0].endpoint
    }

    /// Total peer count.
    pub fn len(&self) -> usize {
        self.peers.len()
    }

    /// True when the configured list is empty. Always `false` in practice —
    /// the constructors reject empty lists — but present for the
    /// `len_without_is_empty` lint.
    pub fn is_empty(&self) -> bool {
        self.peers.is_empty()
    }

    /// Whether more than one peer is configured.
    pub fn is_mesh(&self) -> bool {
        self.peers.len() > 1
    }

    /// Iterate endpoints in constructor order.
    pub fn iter(&self) -> impl Iterator<Item = &Endpoint> {
        self.peers.iter().map(|p| &p.endpoint)
    }

    /// Immutable view of all peers (for introspection / health probe).
    pub fn peers(&self) -> &[Peer] {
        &self.peers
    }

    /// Pick the next peer to dispatch against per closest-first ordering.
    /// Prefers `Healthy` → `Degraded`; falls back to `Unhealthy` only if
    /// every peer is unhealthy (so the request still attempts something).
    pub fn pick(&self) -> &Peer {
        let mut best: Option<&Peer> = None;
        for p in &self.peers {
            match best {
                None => best = Some(p),
                Some(current) if p.sort_key() < current.sort_key() => best = Some(p),
                _ => {}
            }
        }
        best.expect("PeerSet invariant: at least one peer")
    }

    /// Pick the first peer that matches `wanted_key`, if any.
    pub fn find_by_key(&self, wanted_key: &str) -> Option<&Peer> {
        self.peers.iter().find(|p| p.endpoint.key() == wanted_key)
    }

    /// Prefer the peer with the lowest `list_index` that is not
    /// `Unhealthy`; fall back to `pick` if all peers are unhealthy
    /// (Phase 2 — `Prefer::LocalFirst`).
    pub fn pick_local_first(&self) -> &Peer {
        self.peers
            .iter()
            .filter(|p| p.state != PeerState::Unhealthy)
            .min_by_key(|p| p.list_index)
            .unwrap_or_else(|| self.pick())
    }

    /// Pseudo-random pick across `Healthy`/`Degraded` peers (Phase 2 —
    /// `Prefer::Random`). Uses a cheap nanosecond-hash so we don't drag
    /// `rand` into the crate. Falls back to `pick` when every peer is
    /// `Unhealthy`.
    pub fn pick_random(&self) -> &Peer {
        let candidates: Vec<&Peer> = self
            .peers
            .iter()
            .filter(|p| p.state != PeerState::Unhealthy)
            .collect();
        if candidates.is_empty() {
            return self.pick();
        }
        let seed = Instant::now().elapsed().subsec_nanos() as usize;
        let idx = seed % candidates.len();
        candidates[idx]
    }

    /// Reset all peers to `Healthy` with cleared latency + failure state
    /// (Phase 2 — `SeedClient::rediscover`). Idempotent.
    pub fn rediscover(&mut self) {
        for p in &mut self.peers {
            p.state = PeerState::Healthy;
            p.consecutive_failures = 0;
            p.latency_ema_ms = None;
            p.last_used_at = None;
        }
    }

    /// Next peer to try after `failed` has returned a cycling-eligible
    /// error. Skips `failed` by `list_index`; scans remaining peers in
    /// the same closest-first order, preferring healthier / faster /
    /// earlier-listed peers.
    pub fn next_after(&self, failed: &Peer) -> Option<&Peer> {
        let mut best: Option<&Peer> = None;
        for p in &self.peers {
            if p.list_index == failed.list_index {
                continue;
            }
            match best {
                None => best = Some(p),
                Some(current) if p.sort_key() < current.sort_key() => best = Some(p),
                _ => {}
            }
        }
        best
    }

    /// Record a successful outcome: update EMA, clear failure counter,
    /// promote state to `Healthy`.
    pub fn mark_success(&mut self, peer_key: &str, latency: Duration) {
        if let Some(p) = self.peer_mut(peer_key) {
            let ms = latency.as_secs_f64() * 1_000.0;
            p.latency_ema_ms = Some(match p.latency_ema_ms {
                None => ms,
                Some(prev) => 0.8 * prev + 0.2 * ms,
            });
            p.consecutive_failures = 0;
            p.state = PeerState::Healthy;
            p.last_used_at = Some(Instant::now());
        }
    }

    /// Record a failure. `class` determines the state transition:
    ///
    /// * `ServiceUnavailable` — immediate `Unhealthy` (lockdown semantics).
    /// * `Network` / `Timeout` / `Server5xx` — bumps
    ///   `consecutive_failures`; `Degraded` at 1-2, `Unhealthy` at >=3.
    pub fn mark_failure(&mut self, peer_key: &str, class: PeerErrorClass) {
        if let Some(p) = self.peer_mut(peer_key) {
            p.consecutive_failures = p.consecutive_failures.saturating_add(1);
            p.last_used_at = Some(Instant::now());
            p.state = match class {
                PeerErrorClass::ServiceUnavailable => PeerState::Unhealthy,
                _ => {
                    if p.consecutive_failures >= 3 {
                        PeerState::Unhealthy
                    } else {
                        PeerState::Degraded
                    }
                }
            };
        }
    }

    fn peer_mut(&mut self, peer_key: &str) -> Option<&mut Peer> {
        self.peers.iter_mut().find(|p| p.endpoint.key() == peer_key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(url: &str) -> Endpoint {
        Endpoint::parse(url).unwrap()
    }

    #[test]
    fn parse_rejects_ws() {
        let err = Endpoint::parse("ws://x:1").unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
    }

    #[test]
    fn parse_rejects_garbage() {
        let err = Endpoint::parse("not a url").unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
    }

    #[test]
    fn parse_accepts_https() {
        let ep = Endpoint::parse("https://cognitum.local:8443").unwrap();
        assert_eq!(ep.url().scheme(), "https");
        assert_eq!(ep.url().host_str(), Some("cognitum.local"));
        assert_eq!(ep.url().port(), Some(8443));
    }

    #[test]
    fn join_api_builds_full_url() {
        let ep = Endpoint::parse("https://cognitum.local:8443").unwrap();
        let url = ep.join_api("/status").unwrap();
        assert_eq!(url.as_str(), "https://cognitum.local:8443/api/v1/status");
    }

    #[test]
    fn single_peerset_is_len_one() {
        let ps = PeerSet::single(ep("https://seed:8443"));
        assert_eq!(ps.len(), 1);
        assert!(!ps.is_mesh());
    }

    #[test]
    fn new_rejects_empty() {
        let err = PeerSet::new(vec![]).unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
    }

    #[test]
    fn pick_prefers_lower_list_index_when_no_latency() {
        let ps = PeerSet::new(vec![
            ep("https://a:8443"),
            ep("https://b:8443"),
            ep("https://c:8443"),
        ])
        .unwrap();
        let picked = ps.pick();
        assert_eq!(picked.list_index, 0);
    }

    #[test]
    fn pick_prefers_lower_latency_ema() {
        let mut ps = PeerSet::new(vec![ep("https://a:8443"), ep("https://b:8443")]).unwrap();
        ps.mark_success("https://a:8443", Duration::from_millis(100));
        ps.mark_success("https://b:8443", Duration::from_millis(10));
        let picked = ps.pick();
        assert_eq!(picked.list_index, 1);
    }

    #[test]
    fn next_after_cycles() {
        let ps = PeerSet::new(vec![ep("https://a:8443"), ep("https://b:8443")]).unwrap();
        let first = ps.pick();
        let next = ps.next_after(first).expect("second peer");
        assert_ne!(first.list_index, next.list_index);
    }

    #[test]
    fn next_after_single_peer_returns_none() {
        let ps = PeerSet::new(vec![ep("https://a:8443")]).unwrap();
        let peer = ps.pick();
        assert!(ps.next_after(peer).is_none());
    }

    #[test]
    fn mark_failure_degrades_then_unhealthy() {
        let mut ps = PeerSet::new(vec![ep("https://a:8443"), ep("https://b:8443")]).unwrap();
        let key = "https://a:8443";
        ps.mark_failure(key, PeerErrorClass::Network);
        assert_eq!(ps.find_by_key(key).unwrap().state, PeerState::Degraded);
        ps.mark_failure(key, PeerErrorClass::Network);
        ps.mark_failure(key, PeerErrorClass::Network);
        assert_eq!(ps.find_by_key(key).unwrap().state, PeerState::Unhealthy);
    }

    #[test]
    fn mark_failure_503_is_immediate_unhealthy() {
        let mut ps = PeerSet::new(vec![ep("https://a:8443"), ep("https://b:8443")]).unwrap();
        ps.mark_failure("https://a:8443", PeerErrorClass::ServiceUnavailable);
        assert_eq!(
            ps.find_by_key("https://a:8443").unwrap().state,
            PeerState::Unhealthy
        );
    }

    #[test]
    fn unhealthy_peers_skipped_but_still_pickable_when_all_unhealthy() {
        let mut ps = PeerSet::new(vec![ep("https://a:8443"), ep("https://b:8443")]).unwrap();
        ps.mark_failure("https://a:8443", PeerErrorClass::ServiceUnavailable);
        // b is still healthy — pick prefers b.
        assert_eq!(ps.pick().list_index, 1);
        ps.mark_failure("https://b:8443", PeerErrorClass::ServiceUnavailable);
        // both unhealthy — still return something (closest-first fallback).
        let picked = ps.pick();
        assert!(picked.list_index == 0 || picked.list_index == 1);
    }

    #[test]
    fn mark_success_clears_unhealthy() {
        let mut ps = PeerSet::new(vec![ep("https://a:8443")]).unwrap();
        ps.mark_failure("https://a:8443", PeerErrorClass::Network);
        ps.mark_failure("https://a:8443", PeerErrorClass::Network);
        ps.mark_failure("https://a:8443", PeerErrorClass::Network);
        assert_eq!(
            ps.find_by_key("https://a:8443").unwrap().state,
            PeerState::Unhealthy
        );
        ps.mark_success("https://a:8443", Duration::from_millis(5));
        assert_eq!(
            ps.find_by_key("https://a:8443").unwrap().state,
            PeerState::Healthy
        );
    }

    #[test]
    fn endpoint_key_strips_trailing_slash() {
        let a = Endpoint::parse("https://a:8443/").unwrap();
        let b = Endpoint::parse("https://a:8443").unwrap();
        assert_eq!(a.key(), b.key());
    }
}
