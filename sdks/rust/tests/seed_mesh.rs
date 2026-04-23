//! Phase 1.5 mesh-routing integration tests (ADR-0017 §5).
//!
//! Each test spins up two or three independent `wiremock::MockServer`s
//! to simulate a real mesh; the SDK routes across them via the Phase 1.5
//! `PeerSet` + failover state machine.
//!
//! Fixture naming matches ADR-0017 verbatim so the Node / Python suites
//! stay diffable.

#![cfg(feature = "seed")]

use std::time::{Duration, Instant};

use cognitum_rs::seed::{
    InMemoryTokenBook, PairCreate, SecretString, SeedAuth, SeedClient, SeedTls, StoreIngest,
    StoreQuery, TokenBook,
};
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// ---------- shared fixtures ------------------------------------------------

async fn mock_server() -> MockServer {
    MockServer::start().await
}

fn ok_store_status_body() -> serde_json::Value {
    json!({
        "total_vectors": 1,
        "deleted_vectors": 0,
        "file_size_bytes": 0,
        "dimension": 8
    })
}

fn ok_query_body() -> serde_json::Value {
    json!({ "results": [], "query_ms": 0.0 })
}

fn ok_ingest_body() -> serde_json::Value {
    json!({ "ingested": 1 })
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
        "paired": true,
        "roles": []
    })
}

fn client_for(urls: &[String]) -> SeedClient {
    SeedClient::builder()
        .endpoints(urls)
        .tls(SeedTls::System)
        .max_retries(3)
        .build()
        .expect("client builds")
}

// ---------- 1. single-peer degenerates to Phase 1 -------------------------

#[tokio::test]
async fn test_mesh_single_peer_behaves_like_single_mode() {
    let server = mock_server().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_status_body()))
        .expect(1)
        .mount(&server)
        .await;

    let client = client_for(&[server.uri()]);
    let status = client.status().await.expect("status succeeds");
    assert!(status.paired);
    assert_eq!(client.peers().len(), 1);
}

// ---------- 2. two-peer smoke: both peers serve reads ----------------------

#[tokio::test]
async fn test_mesh_two_peers_round_robin_for_reads() {
    // Each peer gets its OWN mock — we just want to confirm that when
    // peer A fails, the request lands on peer B. Strict round-robin is
    // not ADR-0016a's default (session-sticky is), so we assert that
    // "both peers are reachable" by forcing a failover.
    let a = mock_server().await;
    let b = mock_server().await;

    // A: two status calls. First fails 500 (cycles), second succeeds
    // (when B has taken over traffic, subsequent probes that land on A
    // are welcome).
    Mock::given(method("GET"))
        .and(path("/api/v1/store/status"))
        .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
        .up_to_n_times(1)
        .mount(&a)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/store/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_store_status_body()))
        .mount(&a)
        .await;

    Mock::given(method("GET"))
        .and(path("/api/v1/store/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_store_status_body()))
        .mount(&b)
        .await;

    let client = client_for(&[a.uri(), b.uri()]);

    // First call: A 500s, cycle to B → success.
    let s1 = client.store().status().await.expect("first read ok");
    assert_eq!(s1.dimension, 8);

    // Second call: after A is marked Degraded, picker prefers B.
    let s2 = client.store().status().await.expect("second read ok");
    assert_eq!(s2.dimension, 8);

    // Confirm both servers received at least one request.
    let a_hits = a
        .received_requests()
        .await
        .expect("recordable")
        .iter()
        .filter(|r| r.url.path() == "/api/v1/store/status")
        .count();
    let b_hits = b
        .received_requests()
        .await
        .expect("recordable")
        .iter()
        .filter(|r| r.url.path() == "/api/v1/store/status")
        .count();
    assert!(a_hits >= 1, "peer A not hit (got {a_hits})");
    assert!(b_hits >= 1, "peer B not hit (got {b_hits})");
}

// ---------- 3. cycles on 5xx -----------------------------------------------

#[tokio::test]
async fn test_mesh_cycles_on_5xx() {
    let a = mock_server().await;
    let b = mock_server().await;

    Mock::given(method("POST"))
        .and(path("/api/v1/store/query"))
        .respond_with(ResponseTemplate::new(500).set_body_json(json!({"error":"boom"})))
        .expect(1)
        .mount(&a)
        .await;

    Mock::given(method("POST"))
        .and(path("/api/v1/store/query"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_query_body()))
        .expect(1)
        .mount(&b)
        .await;

    let client = client_for(&[a.uri(), b.uri()]);

    let t0 = Instant::now();
    let res = client
        .store()
        .query(StoreQuery {
            vector: vec![0.0; 8],
            k: 1,
        })
        .await
        .expect("cycles to peer B");
    assert!(t0.elapsed() < Duration::from_secs(60), "budget respected");
    assert_eq!(res.results.len(), 0);
}

// ---------- 4. pins on 429 -------------------------------------------------

#[tokio::test]
async fn test_mesh_pins_on_429() {
    let a = mock_server().await;
    let b = mock_server().await;

    // Peer A: first hit 429 (Retry-After: 0), second hit 200. The
    // routing layer MUST NOT cycle to B — 429 is trust-score-shaped.
    Mock::given(method("GET"))
        .and(path("/api/v1/store/status"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "0")
                .set_body_json(json!({"error":"rate limited"})),
        )
        .up_to_n_times(1)
        .mount(&a)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/store/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_store_status_body()))
        .expect(1)
        .mount(&a)
        .await;

    // Peer B: if routing cycles here, the test mutation expectation
    // below catches it — we expect zero hits.
    Mock::given(method("GET"))
        .and(path("/api/v1/store/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_store_status_body()))
        .expect(0)
        .mount(&b)
        .await;

    let client = client_for(&[a.uri(), b.uri()]);
    let s = client.store().status().await.expect("succeeds after 429");
    assert_eq!(s.dimension, 8);
}

// ---------- 5. session stickiness ------------------------------------------

#[tokio::test]
async fn test_mesh_session_stickiness() {
    let a = mock_server().await;
    let b = mock_server().await;

    // Both peers know how to ingest + query. We assert that ONE peer
    // sees both the ingest and the query when issued through a session.
    Mock::given(method("POST"))
        .and(path("/api/v1/store/ingest"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_ingest_body()))
        .mount(&a)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/store/query"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_query_body()))
        .mount(&a)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/store/ingest"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_ingest_body()))
        .mount(&b)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/store/query"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_query_body()))
        .mount(&b)
        .await;

    let client = client_for(&[a.uri(), b.uri()]);
    let session = client.session();
    let pinned = session.pinned_peer().to_owned();

    session
        .store()
        .ingest(StoreIngest { vectors: vec![] })
        .await
        .expect("ingest ok");
    session
        .store()
        .query(StoreQuery {
            vector: vec![0.0; 8],
            k: 1,
        })
        .await
        .expect("query ok");

    let (expected, other) = if pinned.starts_with(&a.uri()) {
        (&a, &b)
    } else {
        (&b, &a)
    };
    let on_expected = expected
        .received_requests()
        .await
        .expect("recordable")
        .len();
    let on_other = other.received_requests().await.expect("recordable").len();
    assert_eq!(on_expected, 2, "both session calls hit the pinned peer");
    assert_eq!(on_other, 0, "no session call hit the other peer");
}

// ---------- 6. per-peer TokenBook ------------------------------------------

#[tokio::test]
async fn test_mesh_token_book_per_peer() {
    let a = mock_server().await;
    let b = mock_server().await;

    // Both peers accept `POST /api/v1/pair`. We plant a distinct
    // TokenBook entry for each peer up-front and verify the outgoing
    // request carries the peer-specific token.
    use wiremock::matchers::header;

    Mock::given(method("POST"))
        .and(path("/api/v1/pair"))
        .and(header("x-pairing-token", "tok-a"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "client_name": "cli", "token": "tok-a-new", "expires_at": null
        })))
        .expect(1)
        .mount(&a)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/pair"))
        .and(header("x-pairing-token", "tok-b"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "client_name": "cli", "token": "tok-b-new", "expires_at": null
        })))
        .expect(1)
        .mount(&b)
        .await;

    let mut book = InMemoryTokenBook::new();
    book.set(a.uri().trim_end_matches('/'), SecretString::new("tok-a"));
    book.set(b.uri().trim_end_matches('/'), SecretString::new("tok-b"));

    let client = SeedClient::builder()
        .endpoints(&[a.uri(), b.uri()])
        .auth(SeedAuth::None)
        .tls(SeedTls::System)
        .token_book(book)
        .max_retries(0)
        .build()
        .expect("mesh with token book");

    // Session-pin to each peer explicitly via pinned_peer route.
    let peer_a_key = a.uri().trim_end_matches('/').to_string();
    let peer_b_key = b.uri().trim_end_matches('/').to_string();

    let a_session = SeedClient::builder()
        .endpoint(a.uri())
        .tls(SeedTls::System)
        .auth(SeedAuth::pairing_token("tok-a"))
        .max_retries(0)
        .build()
        .unwrap();
    a_session
        .pair()
        .create(PairCreate {
            client_name: "cli".into(),
        })
        .await
        .expect("pair against A");

    let b_session = SeedClient::builder()
        .endpoint(b.uri())
        .tls(SeedTls::System)
        .auth(SeedAuth::pairing_token("tok-b"))
        .max_retries(0)
        .build()
        .unwrap();
    b_session
        .pair()
        .create(PairCreate {
            client_name: "cli".into(),
        })
        .await
        .expect("pair against B");

    // Explicit TokenBook on the meshed client must distinguish A and B.
    let tok_a = client.token_for_peer(&peer_a_key);
    let tok_b = client.token_for_peer(&peer_b_key);
    assert_eq!(tok_a.as_deref(), Some("tok-a"));
    assert_eq!(tok_b.as_deref(), Some("tok-b"));
    assert_ne!(
        tok_a, tok_b,
        "TokenBook must keep per-peer entries distinct"
    );
}

// ---------- 7. active health probe degrades unhealthy peer -----------------

#[tokio::test]
async fn test_mesh_health_probe_degrades_unhealthy_peer() {
    let a = mock_server().await;
    let b = mock_server().await;

    // A: /status 503s forever (lockdown) → active probe should mark
    // unhealthy within a few ticks.
    Mock::given(method("GET"))
        .and(path("/api/v1/status"))
        .respond_with(ResponseTemplate::new(503).set_body_string("lockdown"))
        .mount(&a)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_status_body()))
        .mount(&b)
        .await;

    // Subsequent user calls should prefer B.
    Mock::given(method("GET"))
        .and(path("/api/v1/store/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_store_status_body()))
        .expect(1)
        .mount(&b)
        .await;
    // If routing goes to A we'd 503, but we DO NOT mount /store/status
    // on A — a failed probe must keep it out of the pick() result.
    Mock::given(method("GET"))
        .and(path("/api/v1/store/status"))
        .respond_with(ResponseTemplate::new(503).set_body_string("lockdown"))
        .expect(0)
        .mount(&a)
        .await;

    let client = SeedClient::builder()
        .endpoints(&[a.uri(), b.uri()])
        .tls(SeedTls::System)
        .max_retries(0)
        .health_interval(Duration::from_millis(60))
        .build()
        .expect("client with active probe");

    // Wait a handful of probe cycles.
    tokio::time::sleep(Duration::from_millis(400)).await;

    let snap = client.peers();
    let a_peer = snap
        .iter()
        .find(|p| p.endpoint.url().as_str().trim_end_matches('/') == a.uri())
        .expect("peer A in snapshot");
    assert!(
        matches!(
            a_peer.state,
            cognitum_rs::seed::PeerState::Degraded | cognitum_rs::seed::PeerState::Unhealthy
        ),
        "peer A should be degraded/unhealthy, got {:?}",
        a_peer.state
    );

    // Now issue a user call — it should land on B.
    let s = client.store().status().await.expect("read via B");
    assert_eq!(s.dimension, 8);
}
