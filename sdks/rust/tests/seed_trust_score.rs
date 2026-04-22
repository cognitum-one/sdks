//! Trust-score 3-strike protection tests (ADR-0007 §Trust-score protection,
//! [cognitum-one/sdks#16]).
//!
//! The seed hardens auth brute-forcing by tripping a circuit on the 3rd
//! consecutive `Error::Auth(_)` for a given peer: the client aborts with
//! a `trust_score_blocked` error, does NOT cycle to another peer, and does
//! NOT retry. A subsequent 2xx on that peer (e.g. after the operator
//! re-pairs) resets the counter.
//!
//! [cognitum-one/sdks#16]: https://github.com/cognitum-one/sdks/issues/16

#![cfg(feature = "seed")]

use cognitum_rs::seed::{SeedAuth, SeedClient, SeedTls};
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn single_peer_client(server: &MockServer) -> SeedClient {
    SeedClient::builder()
        .endpoint(server.uri())
        .auth(SeedAuth::pairing_token("sentinel-token"))
        .tls(SeedTls::System)
        .max_retries(0)
        .build()
        .expect("seed client builds")
}

#[tokio::test]
async fn auth_fail_3_consecutive_same_peer_trips_trust_score() {
    let server = MockServer::start().await;
    // Every call returns 401. Mount an open-ended expectation so we can
    // count exactly how many times the SDK hit the wire.
    Mock::given(method("GET"))
        .and(path("/api/v1/pair/status"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error": "invalid token"})))
        .mount(&server)
        .await;

    let client = single_peer_client(&server);
    let peer_key = server.uri().trim_end_matches('/').to_owned();

    // First two calls surface `Error::Auth` with `invalid_credentials`.
    for _ in 0..2 {
        let err = client.pair().status().await.unwrap_err();
        match err {
            cognitum_rs::Error::Auth(m) => {
                assert!(
                    m.starts_with("invalid_credentials"),
                    "expected invalid_credentials, got: {m}"
                );
            }
            other => panic!("expected Auth, got {other:?}"),
        }
    }
    assert_eq!(client.trust_score_failures(&peer_key), 2);

    // Third call trips the circuit: `trust_score_blocked`, no retry, no cycle.
    let err = client.pair().status().await.unwrap_err();
    match err {
        cognitum_rs::Error::Auth(m) => {
            assert!(
                m.starts_with("trust_score_blocked"),
                "expected trust_score_blocked, got: {m}"
            );
            assert!(m.contains(&peer_key), "peer URL missing from error: {m}");
        }
        other => panic!("expected Auth(trust_score_blocked), got {other:?}"),
    }
    assert_eq!(client.trust_score_failures(&peer_key), 3);

    // Received exactly 3 wire calls — no retry beyond the 3rd trip.
    assert_eq!(
        server.received_requests().await.expect("captured").len(),
        3,
        "trust-score must not cycle / retry"
    );
}

#[tokio::test]
async fn auth_fail_then_success_resets_counter() {
    let server = MockServer::start().await;
    // First two responses: 401. Third: 200.
    Mock::given(method("GET"))
        .and(path("/api/v1/pair/status"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error": "bad"})))
        .up_to_n_times(2)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/pair/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "paired": true,
            "client_count": 1,
            "pairing_window_open": false,
            "window_remaining_secs": 0
        })))
        .mount(&server)
        .await;

    let client = single_peer_client(&server);
    let peer_key = server.uri().trim_end_matches('/').to_owned();

    // Two 401s.
    let _ = client.pair().status().await.unwrap_err();
    let _ = client.pair().status().await.unwrap_err();
    assert_eq!(client.trust_score_failures(&peer_key), 2);

    // A 200 clears the counter.
    client.pair().status().await.expect("2xx clears");
    assert_eq!(client.trust_score_failures(&peer_key), 0);

    // And now the next auth failure is back to count=1 (not tripped).
    Mock::given(method("POST"))
        .and(path("/api/v1/pair"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error": "bad"})))
        .mount(&server)
        .await;
    let err = client
        .pair()
        .create(cognitum_rs::seed::PairCreate {
            client_name: "x".into(),
        })
        .await
        .unwrap_err();
    match err {
        cognitum_rs::Error::Auth(m) => {
            assert!(
                m.starts_with("invalid_credentials"),
                "must NOT be trust_score_blocked yet: {m}"
            );
        }
        other => panic!("unexpected: {other:?}"),
    }
    assert_eq!(client.trust_score_failures(&peer_key), 1);
}

#[tokio::test]
async fn per_peer_counters_independent() {
    // Two separate mock servers (= two peers). Auth failures on A must not
    // bleed into B's counter.
    let server_a = MockServer::start().await;
    let server_b = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/v1/pair/status"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error": "bad"})))
        .mount(&server_a)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/pair/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "paired": true,
            "client_count": 1,
            "pairing_window_open": false,
            "window_remaining_secs": 0
        })))
        .mount(&server_b)
        .await;

    let key_a = server_a.uri().trim_end_matches('/').to_owned();
    let key_b = server_b.uri().trim_end_matches('/').to_owned();

    // Mesh client with both peers. Routing::Pinned makes the first-listed
    // peer the preferred target; cycle only on cyclable errors (5xx /
    // network). 401 is surfaced immediately on the pinned peer.
    let client = SeedClient::builder()
        .endpoints(&[server_a.uri(), server_b.uri()])
        .auth(SeedAuth::pairing_token("sentinel"))
        .tls(SeedTls::System)
        .max_retries(0)
        .build()
        .expect("mesh client");

    // Confirm A is the closest-first pick (list_index=0, no EMA yet).
    let peers = client.peers();
    assert_eq!(peers[0].list_index, 0);

    // Three auth failures on peer A via a session pinned to A.
    let session = client.session();
    assert_eq!(session.pinned_peer(), key_a.as_str());
    for _ in 0..2 {
        let _ = session.pair().status().await.unwrap_err();
    }
    // 3rd call trips A's circuit.
    let err = session.pair().status().await.unwrap_err();
    match err {
        cognitum_rs::Error::Auth(m) => assert!(m.starts_with("trust_score_blocked"), "got: {m}"),
        other => panic!("expected trust_score_blocked, got {other:?}"),
    }
    assert_eq!(client.trust_score_failures(&key_a), 3);
    // B untouched.
    assert_eq!(client.trust_score_failures(&key_b), 0);

    // Reset A via the test helper — counter clears, B still 0.
    client.reset_trust_score(Some(&key_a));
    assert_eq!(client.trust_score_failures(&key_a), 0);
    assert_eq!(client.trust_score_failures(&key_b), 0);

    // Full reset works too.
    let _ = client.pair().status().await; // (noop — A still 401 on next hit)
    client.reset_trust_score(None);
    assert_eq!(client.trust_score_failures(&key_a), 0);
}

#[tokio::test]
async fn trust_score_blocked_is_not_retryable() {
    let server = MockServer::start().await;
    // Only respond 401. The SDK must fire exactly 3 times — no retry on
    // the `trust_score_blocked` error itself even when max_retries > 0.
    Mock::given(method("GET"))
        .and(path("/api/v1/pair/status"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error": "bad"})))
        .mount(&server)
        .await;

    let client = SeedClient::builder()
        .endpoint(server.uri())
        .auth(SeedAuth::pairing_token("sentinel"))
        .tls(SeedTls::System)
        // Generous retry budget — the counter MUST still trip at 3.
        .max_retries(5)
        .build()
        .unwrap();

    for _ in 0..2 {
        let _ = client.pair().status().await.unwrap_err();
    }
    let err = client.pair().status().await.unwrap_err();
    assert!(matches!(
        err,
        cognitum_rs::Error::Auth(ref m) if m.starts_with("trust_score_blocked")
    ));
    // 3 wire calls, not 3 + retries.
    assert_eq!(server.received_requests().await.unwrap().len(), 3);
}

#[tokio::test]
async fn server_5xx_after_auth_fail_still_cycles() {
    // 5xx failures must NOT increment the auth counter. Set up: first two
    // requests return 500 (idempotent GET → retries on same peer in
    // single-peer mode); third request returns 200. No trust-score trip.
    let server = MockServer::start().await;

    // First 2 calls: 500. Subsequent: 200.
    Mock::given(method("GET"))
        .and(path("/api/v1/store/status"))
        .respond_with(ResponseTemplate::new(500).set_body_json(json!({"error": "boom"})))
        .up_to_n_times(2)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/store/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "total_vectors": 1,
            "deleted_vectors": 0,
            "file_size_bytes": 0,
            "dimension": 8
        })))
        .mount(&server)
        .await;

    let client = SeedClient::builder()
        .endpoint(server.uri())
        .auth(SeedAuth::pairing_token("sentinel"))
        .tls(SeedTls::System)
        .max_retries(5)
        .build()
        .unwrap();
    let peer_key = server.uri().trim_end_matches('/').to_owned();

    // Succeeds after the 5xx-retry path — counter must stay at 0.
    let ok = client.store().status().await.expect("retried to 200");
    assert_eq!(ok.total_vectors, 1);
    assert_eq!(
        client.trust_score_failures(&peer_key),
        0,
        "5xx must not poison the auth counter"
    );
}
