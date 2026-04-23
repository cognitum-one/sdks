//! Phase 3 — [`Discovery`] provider tests (ADR-0016a §D6, ADR-0016b
//! §"Discovery providers").
//!
//! * Two `Explicit` provider tests (smoke + empty-rejected-at-build).
//! * Three tests for the `Discovery` trait wired through a stub
//!   implementation — these cover the `rediscover()` rebuild logic
//!   without requiring a real mDNS responder in CI.
//! * One integration test that wires the stub into a live `SeedClient`,
//!   calls `rediscover()`, and asserts the peer set was rebuilt.
//!
//! The `MdnsDiscovery` crate-feature gate is smoke-tested by the unit
//! tests inside `src/seed/discovery/mdns.rs`; pulling in a real mDNS
//! responder here would make the suite flaky on CI networks where
//! multicast is blocked.

#![cfg(feature = "seed")]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use cognitum_rs::error::Error;
use cognitum_rs::seed::{DiscoveredPeer, Discovery, Explicit, PeerState, SeedClient, SeedTls};

// ---------- Explicit provider ----------------------------------------------

#[tokio::test]
async fn explicit_discovery_through_builder_seeds_peer_set() {
    // `.discovery(Explicit::new(&[...]))` is an alternative to
    // `.endpoints(&[...])` — both should produce a PeerSet of the same
    // shape. Here we use Explicit, skip `.endpoints()` entirely, and
    // assert the client has two peers with stable URLs.
    let client = SeedClient::builder()
        .discovery(Explicit::new(&[
            "https://seed-a.example:8443",
            "https://seed-b.example:8443",
        ]))
        .tls(SeedTls::System)
        .build()
        .expect("discovery-seeded builder builds");

    let peers = client.peers();
    assert_eq!(peers.len(), 2);
    let urls: Vec<String> = peers
        .iter()
        .map(|p| p.endpoint.url().as_str().trim_end_matches('/').to_owned())
        .collect();
    assert!(urls.contains(&"https://seed-a.example:8443".to_owned()));
    assert!(urls.contains(&"https://seed-b.example:8443".to_owned()));
}

#[tokio::test]
async fn explicit_discovery_with_zero_peers_is_rejected_at_build() {
    // An `Explicit` with no URLs should surface a clear Validation
    // error at build() time, not wait for the first request.
    let err = SeedClient::builder()
        .discovery(Explicit::from_vec(vec![]))
        .build()
        .expect_err("empty discovery list must reject");
    assert!(matches!(err, Error::Validation(ref m) if m.contains("zero peers")));
}

// ---------- Stub Discovery trait impl --------------------------------------

/// Programmable `Discovery` that returns whatever snapshot was set by the
/// test. The `calls` counter lets us prove rediscover() actually invokes
/// `discover()` rather than just resetting the existing PeerSet.
#[derive(Debug)]
struct StubDiscovery {
    snapshots: std::sync::Mutex<Vec<Vec<DiscoveredPeer>>>,
    calls: AtomicUsize,
    closes: AtomicUsize,
}

impl StubDiscovery {
    fn new(initial: Vec<&str>) -> Arc<Self> {
        let first: Vec<DiscoveredPeer> = initial.into_iter().map(DiscoveredPeer::new).collect();
        Arc::new(Self {
            snapshots: std::sync::Mutex::new(vec![first]),
            calls: AtomicUsize::new(0),
            closes: AtomicUsize::new(0),
        })
    }

    fn push_snapshot(&self, urls: Vec<&str>) {
        let mut guard = self.snapshots.lock().expect("lock");
        guard.push(urls.into_iter().map(DiscoveredPeer::new).collect());
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl Discovery for StubDiscovery {
    async fn discover(&self) -> Result<Vec<DiscoveredPeer>, Error> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let mut guard = self.snapshots.lock().expect("lock");
        if guard.len() == 1 {
            // Last snapshot — return it repeatedly.
            return Ok(guard[0].clone());
        }
        Ok(guard.remove(0))
    }

    async fn close(&self) -> Result<(), Error> {
        self.closes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

// ---------- Stub through the builder --------------------------------------

#[tokio::test]
async fn stub_discovery_runs_on_build_and_again_on_rediscover() {
    let stub = StubDiscovery::new(vec!["https://x:8443"]);
    stub.push_snapshot(vec!["https://x:8443", "https://y:8443"]);

    let client = SeedClient::builder()
        .discovery_arc(stub.clone())
        .tls(SeedTls::System)
        .build()
        .expect("builds");

    // Initial discover() call happened at build time.
    assert_eq!(stub.calls(), 1);
    assert_eq!(client.peers().len(), 1);

    client.rediscover().await.expect("rediscover");
    assert_eq!(stub.calls(), 2);
    let urls: Vec<String> = client
        .peers()
        .iter()
        .map(|p| p.endpoint.url().as_str().trim_end_matches('/').to_owned())
        .collect();
    assert_eq!(urls.len(), 2);
    assert!(urls.contains(&"https://x:8443".to_owned()));
    assert!(urls.contains(&"https://y:8443".to_owned()));
}

#[tokio::test]
async fn stub_discovery_empty_rebuild_is_rejected_and_leaves_peers_intact() {
    // First build with a non-empty list; then arrange for the next
    // discover() to return an empty list. `rediscover()` must reject
    // and leave the existing PeerSet untouched.
    let stub = StubDiscovery::new(vec!["https://seed:8443"]);
    stub.push_snapshot(vec![]);

    let client = SeedClient::builder()
        .discovery_arc(stub.clone())
        .tls(SeedTls::System)
        .build()
        .expect("builds");
    assert_eq!(client.peers().len(), 1);

    let err = client
        .rediscover()
        .await
        .expect_err("empty rebuild must fail");
    assert!(
        matches!(err, Error::Validation(ref m) if m.contains("zero peers")),
        "got: {err:?}"
    );

    // PeerSet unchanged — still one peer, still healthy.
    let peers = client.peers();
    assert_eq!(peers.len(), 1);
    assert_eq!(peers[0].state, PeerState::Healthy);
}

#[tokio::test]
async fn stub_discovery_preserves_session_pin_when_url_still_present() {
    // Build with two peers, pin a session to one of them, arrange for
    // rediscovery to return a superset that still contains the pinned
    // URL. The session's pinned_peer() should keep resolving.
    let stub = StubDiscovery::new(vec!["https://pinned:8443", "https://sibling:8443"]);
    // Next snapshot: same pinned URL + a new peer. Pin survives.
    stub.push_snapshot(vec![
        "https://pinned:8443",
        "https://sibling:8443",
        "https://new:8443",
    ]);

    let client = SeedClient::builder()
        .discovery_arc(stub)
        .tls(SeedTls::System)
        .build()
        .expect("builds");

    let session = client.session();
    let pin_before = session.pinned_peer().to_owned();
    assert!(
        pin_before == "https://pinned:8443" || pin_before == "https://sibling:8443",
        "pin must be one of the initial peers, got {pin_before}"
    );

    drop(session);
    client.rediscover().await.expect("rediscover");

    // After rediscovery, the pinned URL is still in the PeerSet because
    // the stub's second snapshot is a strict superset of the first.
    let peers_after = client.peers();
    assert_eq!(peers_after.len(), 3);
    assert!(
        peers_after
            .iter()
            .any(|p| p.endpoint.url().as_str().trim_end_matches('/') == pin_before),
        "pinned URL {pin_before} must survive the rediscovery superset"
    );
}

// ---------- Integration: Discovery wired into a SeedClient -----------------

#[tokio::test]
async fn discovery_rebuild_replaces_peer_set_entirely() {
    // Full integration: Discovery yields {A} on build, {B, C} on
    // rediscover. The SeedClient should then route to B or C — A is gone.
    let stub = StubDiscovery::new(vec!["https://a.old:8443"]);
    stub.push_snapshot(vec!["https://b.new:8443", "https://c.new:8443"]);

    let client = SeedClient::builder()
        .discovery_arc(stub.clone())
        .tls(SeedTls::System)
        .build()
        .expect("builds");

    // Initial state — single peer {A}.
    let before: Vec<String> = client
        .peers()
        .iter()
        .map(|p| p.endpoint.url().as_str().trim_end_matches('/').to_owned())
        .collect();
    assert_eq!(before, vec!["https://a.old:8443"]);

    client.rediscover().await.expect("rediscover");

    // After rediscovery — {B, C}, A is gone.
    let after: Vec<String> = client
        .peers()
        .iter()
        .map(|p| p.endpoint.url().as_str().trim_end_matches('/').to_owned())
        .collect();
    assert_eq!(after.len(), 2);
    assert!(after.contains(&"https://b.new:8443".to_owned()));
    assert!(after.contains(&"https://c.new:8443".to_owned()));
    assert!(!after.contains(&"https://a.old:8443".to_owned()));

    // Every new peer starts in Healthy with cleared EMA.
    for p in client.peers() {
        assert_eq!(p.state, PeerState::Healthy);
        assert!(p.latency_ema_ms.is_none());
        assert!(p.last_used_at.is_none());
    }

    // Exactly two discover() invocations: one at build, one at rediscover.
    assert_eq!(stub.calls(), 2);
}
