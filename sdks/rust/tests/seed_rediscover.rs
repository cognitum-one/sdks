//! Phase 2 — `SeedClient::rediscover()` tests (ADR-0016b).
//!
//! `rediscover()` resets all peer state: every peer is marked `Healthy`
//! again, `consecutive_failures` → 0, `latency_ema_ms` and `last_used_at`
//! are cleared. Idempotent, no network I/O.

#![cfg(feature = "seed")]

use cognitum_rs::seed::{PeerState, SeedClient, SeedTls};
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn mock() -> MockServer {
    MockServer::start().await
}

fn ok_status_body() -> serde_json::Value {
    json!({
        "device_id": "abc",
        "uptime_secs": 1,
        "epoch": 1,
        "total_vectors": 0,
        "deleted_vectors": 0,
        "file_size_bytes": 0,
        "dimension": 8,
        "paired": false,
        "roles": []
    })
}

/// Drive peer A into `Unhealthy` by issuing a call that 500s then peer B
/// succeeds; then call `rediscover()` and assert both peers are back to
/// `Healthy` with `None` latency EMAs.
#[tokio::test]
async fn rediscover_resets_unhealthy_peer_to_healthy() {
    let a = mock().await;
    let b = mock().await;

    // A: 3x 500 → drives A to Unhealthy via mark_failure's 3-strike rule.
    Mock::given(method("GET"))
        .and(path("/api/v1/status"))
        .respond_with(ResponseTemplate::new(500).set_body_string("{}"))
        .up_to_n_times(3)
        .mount(&a)
        .await;
    // B: always succeeds (cycled-to when A fails).
    Mock::given(method("GET"))
        .and(path("/api/v1/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_status_body()))
        .mount(&b)
        .await;

    let client = SeedClient::builder()
        .endpoints(&[a.uri(), b.uri()])
        .tls(SeedTls::System)
        .max_retries(0)
        .build()
        .expect("builds");

    // One call: A 500s → cycles to B → B 200s.
    let _ = client.status().await.expect("B succeeds");

    // Peer A should be at least Degraded (one failure, may be Unhealthy
    // per the request loop's extra mark-on-retry pass). Either way it's
    // NOT Healthy.
    let peers = client.peers();
    let peer_a = peers
        .iter()
        .find(|p| p.endpoint.url().as_str().trim_end_matches('/') == a.uri())
        .expect("peer A present");
    assert_ne!(peer_a.state, PeerState::Healthy);
    assert!(peer_a.consecutive_failures >= 1);

    let peer_b = peers
        .iter()
        .find(|p| p.endpoint.url().as_str().trim_end_matches('/') == b.uri())
        .expect("peer B present");
    assert_eq!(peer_b.state, PeerState::Healthy);
    assert!(peer_b.latency_ema_ms.is_some());

    // Rediscover: both peers revert to clean state. No Discovery
    // provider is configured, so this is pure SDK-local bookkeeping and
    // cannot fail.
    client.rediscover().await.expect("rediscover");

    let after = client.peers();
    for p in &after {
        assert_eq!(p.state, PeerState::Healthy);
        assert_eq!(p.consecutive_failures, 0);
        assert!(p.latency_ema_ms.is_none());
        assert!(p.last_used_at.is_none());
    }
}

/// Calling `rediscover()` on a freshly-built client is a no-op that
/// leaves every peer in the `Healthy` state it started in.
#[tokio::test]
async fn rediscover_is_idempotent_on_fresh_client() {
    let a = mock().await;
    let b = mock().await;

    let client = SeedClient::builder()
        .endpoints(&[a.uri(), b.uri()])
        .tls(SeedTls::System)
        .build()
        .expect("builds");

    // First call — should be safe on a clean client.
    client.rediscover().await.expect("first rediscover");
    // Second call — still safe.
    client.rediscover().await.expect("second rediscover");

    for p in client.peers() {
        assert_eq!(p.state, PeerState::Healthy);
        assert_eq!(p.consecutive_failures, 0);
        assert!(p.latency_ema_ms.is_none());
        assert!(p.last_used_at.is_none());
    }
}
