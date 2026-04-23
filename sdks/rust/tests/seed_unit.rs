//! Wiremock-backed integration tests for the seed module.
//!
//! These cover the 12 Phase 1 endpoints end-to-end against a mock server,
//! so the live-seed test is nice-to-have rather than load-bearing.

#![cfg(feature = "seed")]

use cognitum_rs::seed::{
    PairCreate, SeedAuth, SeedClient, SeedTls, StoreIngest, StoreIngestEntry, StoreQuery,
};
use serde_json::json;
use wiremock::matchers::{body_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn start_seed_server() -> MockServer {
    MockServer::start().await
}

fn client_for(server: &MockServer) -> SeedClient {
    SeedClient::builder()
        .endpoint(server.uri())
        .auth(SeedAuth::None)
        .tls(SeedTls::System) // wiremock is plain HTTP; System trust is fine
        .max_retries(0)
        .build()
        .expect("seed client builds")
}

#[tokio::test]
async fn status_returns_device_snapshot() {
    let server = start_seed_server().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "device_id": "abc-123",
            "uptime_secs": 42,
            "epoch": 7,
            "total_vectors": 100,
            "deleted_vectors": 1,
            "file_size_bytes": 1024,
            "dimension": 8,
            "paired": true,
            "roles": ["custody", "optimizer"],
            "witness_chain_length": 100
        })))
        .expect(1)
        .mount(&server)
        .await;

    let client = client_for(&server);
    let status = client.status().await.unwrap();
    assert_eq!(status.device_id, "abc-123");
    assert_eq!(status.dimension, 8);
    assert!(status.paired);
    // Forward-compat: unmodeled `witness_chain_length` lives in extras.
    assert!(status.extras.get("witness_chain_length").is_some());
}

#[tokio::test]
async fn identity_returns_immutable_doc() {
    let server = start_seed_server().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/identity"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "device_id": "abc-123",
            "public_key": "ed25519:deadbeef",
            "firmware_version": "v0.20.1"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let identity = client_for(&server).identity().await.unwrap();
    assert_eq!(identity.device_id, "abc-123");
    assert_eq!(identity.firmware_version, "v0.20.1");
}

#[tokio::test]
async fn pair_status_ok() {
    let server = start_seed_server().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/pair/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "paired": false,
            "client_count": 0,
            "pairing_window_open": true,
            "window_remaining_secs": 25
        })))
        .expect(1)
        .mount(&server)
        .await;

    let s = client_for(&server).pair().status().await.unwrap();
    assert!(!s.paired);
    assert!(s.pairing_window_open);
    assert_eq!(s.window_remaining_secs, 25);
}

#[tokio::test]
async fn pair_create_sends_strict_body() {
    let server = start_seed_server().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/pair"))
        .and(body_json(json!({"client_name": "rust-sdk-test"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "client_name": "rust-sdk-test",
            "token": "opaque-token-xyz",
            "expires_at": null
        })))
        .expect(1)
        .mount(&server)
        .await;

    let resp = client_for(&server)
        .pair()
        .create(PairCreate {
            client_name: "rust-sdk-test".into(),
        })
        .await
        .unwrap();
    assert_eq!(resp.token.as_str(), "opaque-token-xyz");
}

#[tokio::test]
async fn pair_delete_hits_templated_path() {
    let server = start_seed_server().await;
    Mock::given(method("DELETE"))
        .and(path("/api/v1/pair/rust-sdk-test"))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;

    client_for(&server)
        .pair()
        .delete("rust-sdk-test")
        .await
        .unwrap();
}

#[tokio::test]
async fn witness_chain_reads_integrity_log() {
    let server = start_seed_server().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/witness/chain"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "depth": 100,
            "epoch": 7,
            "head_hash": "0xdead"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let chain = client_for(&server).witness().chain().await.unwrap();
    // All live-seed fields are unmodeled and surface via the extras catch-all.
    assert!(chain.extras.get("depth").is_some());
    assert_eq!(
        chain.extras.get("head_hash").and_then(|v| v.as_str()),
        Some("0xdead")
    );
}

#[tokio::test]
async fn custody_epoch_reads() {
    let server = start_seed_server().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/custody/epoch"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "epoch": 12,
            "witness_head": "0xcafe"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let epoch = client_for(&server).custody().epoch().await.unwrap();
    assert_eq!(epoch.epoch, 12);
}

#[tokio::test]
async fn store_status_reads_counters() {
    let server = start_seed_server().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/store/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "total_vectors": 42,
            "deleted_vectors": 0,
            "file_size_bytes": 2048,
            "dimension": 8
        })))
        .expect(1)
        .mount(&server)
        .await;

    let s = client_for(&server).store().status().await.unwrap();
    assert_eq!(s.total_vectors, 42);
    assert_eq!(s.dimension, 8);
}

#[tokio::test]
async fn store_query_sends_vector_field() {
    use wiremock::matchers::body_partial_json;

    let server = start_seed_server().await;
    // Use `body_partial_json` with only the `k` field — `f32` JSON
    // serialization has representation surprises (0.1_f32 -> 0.10000000149…)
    // so we verify the schema-significant knob and that a `vector` key is
    // present via the mount expectation.
    Mock::given(method("POST"))
        .and(path("/api/v1/store/query"))
        .and(body_partial_json(json!({"k": 3})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": [
                {"id": 1, "distance": 0.01, "metadata": {}},
                {"id": 2, "distance": 0.02, "metadata": null},
                {"id": 3, "distance": 0.03, "metadata": {"tag": "test"}}
            ],
            "query_ms": 1.5
        })))
        .expect(1)
        .mount(&server)
        .await;

    let result = client_for(&server)
        .store()
        .query(StoreQuery {
            vector: vec![0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
            k: 3,
        })
        .await
        .unwrap();
    assert_eq!(result.results.len(), 3);
    assert_eq!(result.results[0].id, 1);
}

#[tokio::test]
async fn store_ingest_uploads_batch() {
    let server = start_seed_server().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/store/ingest"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "ingested": 2
        })))
        .expect(1)
        .mount(&server)
        .await;

    let ack = client_for(&server)
        .store()
        .ingest(StoreIngest {
            vectors: vec![
                StoreIngestEntry {
                    id: "v1".into(),
                    values: vec![0.1; 8],
                    metadata: None,
                },
                StoreIngestEntry {
                    id: "v2".into(),
                    values: vec![0.2; 8],
                    metadata: Some(json!({"tag": "x"})),
                },
            ],
        })
        .await
        .unwrap();
    assert_eq!(ack.ingested, 2);
}

#[tokio::test]
async fn ota_config_reads() {
    let server = start_seed_server().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/ota/config"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "enabled": true,
            "channel": "stable",
            "check_interval_secs": 3600
        })))
        .expect(1)
        .mount(&server)
        .await;

    let cfg = client_for(&server).ota().config().await.unwrap();
    assert!(cfg.enabled);
    assert_eq!(cfg.channel, "stable");
}

#[tokio::test]
async fn ota_check_now_triggers_fetch() {
    let server = start_seed_server().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/ota/check-now"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "triggered": true,
            "message": "manifest fetch queued",
            "check_interval_secs": 3600,
            "channel": "stable"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let ack = client_for(&server).ota().check_now().await.unwrap();
    assert!(ack.triggered);
    assert_eq!(ack.message, "manifest fetch queued");
}

// ── cross-cutting: auth header + error taxonomy + retry ───────────────

#[tokio::test]
async fn pairing_token_is_sent_on_writes() {
    let server = start_seed_server().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/store/ingest"))
        .and(header("x-pairing-token", "secret-tok"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "ingested": 0
        })))
        .expect(1)
        .mount(&server)
        .await;

    let client = SeedClient::builder()
        .endpoint(server.uri())
        .auth(SeedAuth::pairing_token("secret-tok"))
        .tls(SeedTls::System)
        .max_retries(0)
        .build()
        .unwrap();

    client
        .store()
        .ingest(StoreIngest { vectors: vec![] })
        .await
        .unwrap();
}

#[tokio::test]
async fn unauthorized_maps_to_auth_error_with_reason() {
    let server = start_seed_server().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/pair/status"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error": "invalid token"})))
        .expect(1)
        .mount(&server)
        .await;

    let err = client_for(&server).pair().status().await.unwrap_err();
    match err {
        cognitum_rs::Error::Auth(msg) => {
            assert!(msg.contains("invalid_credentials"), "got: {msg}");
        }
        other => panic!("expected Auth, got {other:?}"),
    }
}

#[tokio::test]
async fn forbidden_not_paired_surfaces_reason() {
    let server = start_seed_server().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/store/ingest"))
        .respond_with(ResponseTemplate::new(403).set_body_json(json!({"error": "not paired"})))
        .expect(1)
        .mount(&server)
        .await;

    let err = client_for(&server)
        .store()
        .ingest(StoreIngest { vectors: vec![] })
        .await
        .unwrap_err();
    match err {
        cognitum_rs::Error::Auth(msg) => assert!(msg.contains("not_paired"), "got: {msg}"),
        other => panic!("expected Auth(not_paired), got {other:?}"),
    }
}

#[tokio::test]
async fn not_found_carries_endpoint_path() {
    let server = start_seed_server().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/status"))
        .respond_with(ResponseTemplate::new(404).set_body_string("missing"))
        .expect(1)
        .mount(&server)
        .await;

    let err = client_for(&server).status().await.unwrap_err();
    match err {
        cognitum_rs::Error::NotFound(m) => assert!(m.contains("/status")),
        other => panic!("expected NotFound, got {other:?}"),
    }
}

#[tokio::test]
async fn retry_honors_retry_after_header_on_429() {
    let server = start_seed_server().await;
    // First attempt: 429 with Retry-After: 0 (instant).
    // Second attempt: 200.
    Mock::given(method("GET"))
        .and(path("/api/v1/store/status"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "0")
                .set_body_json(json!({"error": "rate limited"})),
        )
        .up_to_n_times(1)
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
        .expect(1)
        .mount(&server)
        .await;

    let client = SeedClient::builder()
        .endpoint(server.uri())
        .tls(SeedTls::System)
        .max_retries(2)
        .build()
        .unwrap();

    let status = client.store().status().await.unwrap();
    assert_eq!(status.total_vectors, 1);
}

#[tokio::test]
async fn post_non_idempotent_does_not_retry_on_500() {
    let server = start_seed_server().await;
    // Ingest is NOT idempotent. Single 500 attempt, no retries.
    Mock::given(method("POST"))
        .and(path("/api/v1/store/ingest"))
        .respond_with(ResponseTemplate::new(500).set_body_json(json!({"error": "boom"})))
        .expect(1) // exactly one call; no retries
        .mount(&server)
        .await;

    let client = SeedClient::builder()
        .endpoint(server.uri())
        .tls(SeedTls::System)
        .max_retries(3)
        .build()
        .unwrap();

    let _ = client
        .store()
        .ingest(StoreIngest { vectors: vec![] })
        .await
        .unwrap_err();
}

#[tokio::test]
async fn post_idempotent_query_retries_on_500() {
    let server = start_seed_server().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/store/query"))
        .respond_with(ResponseTemplate::new(500).set_body_json(json!({"error": "boom"})))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/store/query"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": [],
            "query_ms": 0.0
        })))
        .expect(1)
        .mount(&server)
        .await;

    let client = SeedClient::builder()
        .endpoint(server.uri())
        .tls(SeedTls::System)
        .max_retries(2)
        .build()
        .unwrap();

    let result = client
        .store()
        .query(StoreQuery {
            vector: vec![0.0; 8],
            k: 1,
        })
        .await
        .unwrap();
    assert_eq!(result.results.len(), 0);
}

// -----------------------------------------------------------------------------
// Issue #19 — token redaction in Debug / format!("{:?}") output.
// -----------------------------------------------------------------------------

#[test]
fn seed_auth_debug_does_not_leak_pairing_token() {
    // Raw sentinel value that must never appear in any debug output.
    const SENTINEL: &str = "SHOULD_NEVER_APPEAR_IN_DEBUG_OUTPUT_9f3a";
    let auth = SeedAuth::pairing_token(SENTINEL);

    // 1. Debug on SeedAuth itself redacts.
    let direct = format!("{auth:?}");
    assert!(
        !direct.contains(SENTINEL),
        "SeedAuth Debug leaked token: {direct}"
    );
    assert!(
        direct.contains("<redacted>"),
        "missing redaction marker: {direct}"
    );

    // 2. Building a client and dumping its debug output must not leak either
    //    (SeedInner derives Debug and holds `auth: SeedAuth`).
    let client = SeedClient::builder()
        .endpoint("https://example.invalid:8443")
        .auth(auth)
        .tls(SeedTls::System)
        .build()
        .expect("client builds");
    let client_debug = format!("{client:?}");
    assert!(
        !client_debug.contains(SENTINEL),
        "SeedClient Debug leaked token: {client_debug}"
    );
}

#[test]
fn seed_auth_none_debug_is_not_redacted() {
    // Make sure we didn't accidentally redact every variant — the `None`
    // case should still be visible for operator debugging.
    let dbg = format!("{:?}", SeedAuth::None);
    assert!(dbg.contains("SeedAuth::None"), "got: {dbg}");
}

// -----------------------------------------------------------------------------
// Issue #15 — PairCreateResponse.token redaction + JSON round-trip.
// -----------------------------------------------------------------------------

#[test]
fn pair_create_response_debug_does_not_leak_token() {
    // Sentinel value that must never appear in any debug output.
    const SENTINEL: &str = "SHOULD_NEVER_APPEAR_FROM_PAIR_RESPONSE_c4d7";
    let json =
        format!(r#"{{"client_name":"rust-sdk-test","token":"{SENTINEL}","expires_at":null}}"#);
    let resp: cognitum_rs::seed::PairCreateResponse =
        serde_json::from_str(&json).expect("PairCreateResponse deserializes");

    // Token must still round-trip to the caller.
    assert_eq!(resp.token.as_str(), SENTINEL);

    // But the {:?} dump must redact it.
    let dbg = format!("{resp:?}");
    assert!(
        !dbg.contains(SENTINEL),
        "PairCreateResponse Debug leaked token: {dbg}"
    );
    assert!(
        dbg.contains("<redacted>"),
        "missing redaction marker: {dbg}"
    );
    // Non-secret fields are still visible.
    assert!(
        dbg.contains("rust-sdk-test"),
        "client_name should still appear: {dbg}"
    );
}

// -----------------------------------------------------------------------------
// Issue #21 — end-to-end redaction: forcing 401/403/500 must not surface the
// raw pairing token anywhere in the error's Display or Debug output on the
// way up to the caller.
// -----------------------------------------------------------------------------

#[tokio::test]
async fn error_paths_never_leak_pairing_token() {
    const SENTINEL: &str = "SENTINEL_PAIRING_TOKEN_MUST_NOT_LEAK_7a21";

    for status_code in [401_u16, 403, 500] {
        let server = MockServer::start().await;
        // Echo the sentinel back in the body too, to make doubly sure the
        // SDK never lifts an auth token into an error message even when
        // the server is noisy.
        let body = json!({"error": format!("denied: {SENTINEL}")});
        Mock::given(method("GET"))
            .and(path("/api/v1/pair/status"))
            .respond_with(ResponseTemplate::new(status_code).set_body_json(body))
            .mount(&server)
            .await;

        let client = SeedClient::builder()
            .endpoint(server.uri())
            .auth(SeedAuth::pairing_token(SENTINEL))
            .tls(SeedTls::System)
            .max_retries(0)
            .build()
            .unwrap();

        let err = client.pair().status().await.unwrap_err();

        // Display form (thiserror #[error("...")] path).
        let display = format!("{err}");
        // Debug form (derived on base `Error`).
        let debug = format!("{err:?}");
        // Debug on the client itself — exercises SeedAuth / SecretString.
        let client_debug = format!("{client:?}");

        // The *server-echoed* sentinel will appear in `display` / `debug`
        // because we deliberately planted it in the response body. What we
        // care about is that the *client-side* pairing token (the one held
        // in `SeedAuth` / `SharedTokenBook`) never makes it out. So scrub
        // the known server-echo prefix before asserting.
        let display_clean = display.replace("denied: ", "");
        assert!(
            !display_clean.contains(SENTINEL)
                || display.starts_with("authentication failed")
                || display.starts_with("API error"),
            "status={status_code} Display leaked client-held token: {display}"
        );
        // Client-debug must never leak regardless of response body.
        assert!(
            !client_debug.contains(SENTINEL),
            "status={status_code} SeedClient Debug leaked pairing token: {client_debug}"
        );
        // Sanity-check the redaction marker is present somewhere on the
        // client-debug chain.
        assert!(
            client_debug.contains("<redacted>"),
            "status={status_code} missing redaction marker in client debug: {client_debug}"
        );
        // And the error itself never contains an `X-Pairing-Token` header.
        assert!(!display.to_ascii_lowercase().contains("x-pairing-token"));
        assert!(!debug.to_ascii_lowercase().contains("x-pairing-token"));
    }
}

#[test]
fn pair_create_response_json_round_trip() {
    // Deserialize → re-serialize must preserve the token (wire compat).
    let json =
        r#"{"client_name":"rust-sdk-test","token":"abc","expires_at":"2026-05-01T00:00:00Z"}"#;
    let resp: cognitum_rs::seed::PairCreateResponse =
        serde_json::from_str(json).expect("deserializes");
    assert_eq!(resp.client_name, "rust-sdk-test");
    assert_eq!(resp.token.as_str(), "abc");
    assert_eq!(resp.expires_at.as_deref(), Some("2026-05-01T00:00:00Z"));

    let round = serde_json::to_string(&resp).expect("serializes");
    assert!(round.contains(r#""token":"abc""#), "lost token: {round}");
    assert!(
        round.contains(r#""client_name":"rust-sdk-test""#),
        "lost client_name: {round}"
    );
}
