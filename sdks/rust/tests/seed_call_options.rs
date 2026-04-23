//! Phase 2 — per-call [`CallOptions`] tests (ADR-0016b §"Per-call knobs").
//!
//! Split off from `seed_mesh.rs` because that file is near the 500-line
//! cap; the tests belong logically next to the mesh routing suite but
//! live here to keep both files reviewable.

#![cfg(feature = "seed")]

use cognitum_rs::error::Error;
use cognitum_rs::seed::{CallOptions, Consistency, Prefer, SeedClient, SeedTls};
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
        "paired": true,
        "roles": []
    })
}

// ---------- 1. peer override routes to the named peer --------------------

#[tokio::test]
async fn call_options_peer_pins_named_peer() {
    let a = mock().await;
    let b = mock().await;

    // Only B mounts a responder. If the call lands on A we'll see a
    // wiremock "no matching mock" failure path.
    Mock::given(method("GET"))
        .and(path("/api/v1/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_status_body()))
        .expect(1)
        .mount(&b)
        .await;

    let client = SeedClient::builder()
        .endpoints(&[a.uri(), b.uri()])
        .tls(SeedTls::System)
        .max_retries(0)
        .build()
        .expect("builds");

    let got = client
        .status_with(CallOptions::new().peer(b.uri()))
        .await
        .expect("pinned to B");
    assert_eq!(got.device_id, "abc");
}

// ---------- 2. peer override with unknown URL returns a config error -----

#[tokio::test]
async fn call_options_unknown_peer_returns_config_error() {
    let a = mock().await;

    let client = SeedClient::builder()
        .endpoint(a.uri())
        .tls(SeedTls::System)
        .build()
        .expect("builds");

    let err = client
        .status_with(CallOptions::new().peer("https://ghost:8443"))
        .await
        .unwrap_err();
    match err {
        Error::Validation(m) => {
            assert!(m.starts_with("config:"), "got: {m}");
            assert!(m.contains("peer not in mesh"), "got: {m}");
            assert!(m.contains("https://ghost:8443"), "got: {m}");
        }
        other => panic!("expected Validation, got {other:?}"),
    }
}

// ---------- 3. prefer::LocalFirst picks lowest list_index ----------------

#[tokio::test]
async fn call_options_prefer_local_first_picks_first_peer() {
    let a = mock().await;
    let b = mock().await;

    // Only A responds — LocalFirst must route there even though B would
    // also be eligible.
    Mock::given(method("GET"))
        .and(path("/api/v1/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_status_body()))
        .expect(1)
        .mount(&a)
        .await;

    let client = SeedClient::builder()
        .endpoints(&[a.uri(), b.uri()])
        .tls(SeedTls::System)
        .max_retries(0)
        .build()
        .expect("builds");

    client
        .status_with(CallOptions::new().prefer(Prefer::LocalFirst))
        .await
        .expect("routed to A");
}

// ---------- 4. prefer::Random picks a Healthy/Degraded peer --------------

#[tokio::test]
async fn call_options_prefer_random_stays_in_healthy_set() {
    // Every peer is healthy; random must pick one of them and the call
    // must succeed (we don't assert which — just that the path works).
    let a = mock().await;
    let b = mock().await;

    for s in [&a, &b] {
        Mock::given(method("GET"))
            .and(path("/api/v1/status"))
            .respond_with(ResponseTemplate::new(200).set_body_json(ok_status_body()))
            .mount(s)
            .await;
    }

    let client = SeedClient::builder()
        .endpoints(&[a.uri(), b.uri()])
        .tls(SeedTls::System)
        .build()
        .expect("builds");

    let got = client
        .status_with(CallOptions::new().prefer(Prefer::Random))
        .await
        .expect("random picks a healthy peer");
    assert_eq!(got.device_id, "abc");
}

// ---------- 5. prefer::Any behaves like the default picker ---------------

#[tokio::test]
async fn call_options_prefer_any_is_equivalent_to_default_pick() {
    let a = mock().await;

    Mock::given(method("GET"))
        .and(path("/api/v1/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_status_body()))
        .expect(1)
        .mount(&a)
        .await;

    let client = SeedClient::builder()
        .endpoint(a.uri())
        .tls(SeedTls::System)
        .build()
        .expect("builds");

    client
        .status_with(CallOptions::new().prefer(Prefer::Any))
        .await
        .expect("default-style pick");
}

// ---------- 6. consistency::Strong returns `unsupported` without HTTP ----

#[tokio::test]
async fn call_options_strong_consistency_is_unsupported() {
    // Mount NO responder — if the SDK sends a request at all, the test
    // blows up on wiremock's "unexpected call" side-channel rather than
    // silently passing.
    let server = mock().await;

    let client = SeedClient::builder()
        .endpoint(server.uri())
        .tls(SeedTls::System)
        .build()
        .expect("builds");

    let err = client
        .status_with(CallOptions::new().consistency(Consistency::Strong))
        .await
        .unwrap_err();
    match err {
        Error::Validation(m) => {
            assert!(m.starts_with("unsupported:"), "got: {m}");
            assert!(m.contains("quorum"), "got: {m}");
        }
        other => panic!("expected Validation(unsupported), got {other:?}"),
    }
    assert_eq!(server.received_requests().await.unwrap().len(), 0);
}

// ---------- 7. consistency::Eventual succeeds (single-peer no-op) --------

#[tokio::test]
async fn call_options_eventual_consistency_still_routes() {
    let a = mock().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_status_body()))
        .expect(1)
        .mount(&a)
        .await;

    let client = SeedClient::builder()
        .endpoint(a.uri())
        .tls(SeedTls::System)
        .build()
        .expect("builds");

    client
        .status_with(CallOptions::new().consistency(Consistency::Eventual))
        .await
        .expect("eventual consistency is a no-op on the top-level client");
}

// ---------- 8. CallOptions::default() is a no-op equivalent to status() -

#[tokio::test]
async fn call_options_default_is_equivalent_to_plain_call() {
    let a = mock().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_status_body()))
        .expect(2)
        .mount(&a)
        .await;

    let client = SeedClient::builder()
        .endpoint(a.uri())
        .tls(SeedTls::System)
        .build()
        .expect("builds");

    // Plain call
    let plain = client.status().await.expect("plain status");
    // _with(default) — must hit the same endpoint with the same payload
    let with_default = client
        .status_with(CallOptions::default())
        .await
        .expect("_with");
    assert_eq!(plain.device_id, with_default.device_id);
    assert_eq!(plain.epoch, with_default.epoch);
    assert_eq!(plain.extras, with_default.extras);
}
