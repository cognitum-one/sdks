//! Phase 2 — mesh observability resource smoke tests (ADR-0016a §D8).
//!
//! Each test spins up a wiremock server that returns the exact JSON
//! captured from a live seed (`ad7d7e7b-56e7-4e03-b078-939209858144`,
//! v0.20.0, 2026-04-22) and asserts the SDK deserializes it cleanly.

#![cfg(feature = "seed")]

use cognitum_rs::seed::{SeedClient, SeedTls};
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn mock() -> MockServer {
    MockServer::start().await
}

fn client(server: &MockServer) -> SeedClient {
    SeedClient::builder()
        .endpoint(server.uri())
        .tls(SeedTls::System)
        .build()
        .expect("client builds")
}

// ---------- 1. /network/mesh/status ---------------------------------------

#[tokio::test]
async fn mesh_status_deserialises_live_shape() {
    let server = mock().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/network/mesh/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "ap_active": true,
            "auto_mesh": false,
            "connected_to_seed": false,
            "device_id": "ad7d7e7b-56e7-4e03-b078-939209858144",
            "has_mesh_password": false,
            "peer_count": 0,
            "peers": []
        })))
        .expect(1)
        .mount(&server)
        .await;

    let got = client(&server).mesh().status().await.expect("decoded");
    assert!(got.ap_active);
    assert!(!got.auto_mesh);
    assert!(!got.connected_to_seed);
    assert_eq!(got.device_id, "ad7d7e7b-56e7-4e03-b078-939209858144");
    assert!(!got.has_mesh_password);
    assert_eq!(got.peer_count, 0);
    assert!(got.peers.is_empty());
    assert!(got.extras.is_empty());
}

// ---------- 2. /peers ------------------------------------------------------

#[tokio::test]
async fn mesh_peers_deserialises_live_shape() {
    let server = mock().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/peers"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "count": 0,
            "discovery_active": true,
            "peers": []
        })))
        .expect(1)
        .mount(&server)
        .await;

    let got = client(&server).mesh().peers().await.expect("decoded");
    assert_eq!(got.count, 0);
    assert!(got.discovery_active);
    assert!(got.peers.is_empty());
}

// ---------- 3. /swarm/status ----------------------------------------------

#[tokio::test]
async fn mesh_swarm_status_deserialises_live_shape() {
    let server = mock().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/swarm/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "device_id": "ad7d7e7b-56e7-4e03-b078-939209858144",
            "discovery_active": true,
            "epoch": 20564,
            "peer_count": 0,
            "total_vectors": 8460,
            "uptime_secs": 23054
        })))
        .expect(1)
        .mount(&server)
        .await;

    let got = client(&server)
        .mesh()
        .swarm_status()
        .await
        .expect("decoded");
    assert_eq!(got.device_id, "ad7d7e7b-56e7-4e03-b078-939209858144");
    assert!(got.discovery_active);
    assert_eq!(got.epoch, 20564);
    assert_eq!(got.peer_count, 0);
    assert_eq!(got.total_vectors, 8460);
    assert_eq!(got.uptime_secs, 23054);
}

// ---------- 4. /cluster/health --------------------------------------------

#[tokio::test]
async fn mesh_cluster_health_deserialises_live_shape() {
    let server = mock().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/cluster/health"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "auto_sync_interval_secs": 60,
            "cluster_enabled": true,
            "discovery_active": true,
            "last_sync_attempt": 1776906597_i64,
            "peer_count": 0,
            "peers": []
        })))
        .expect(1)
        .mount(&server)
        .await;

    let got = client(&server)
        .mesh()
        .cluster_health()
        .await
        .expect("decoded");
    assert_eq!(got.auto_sync_interval_secs, 60);
    assert!(got.cluster_enabled);
    assert!(got.discovery_active);
    assert_eq!(got.last_sync_attempt, 1776906597);
    assert_eq!(got.peer_count, 0);
    assert!(got.peers.is_empty());
}

// ---------- 5. forward-compat: unknown fields captured in `extras` --------

#[tokio::test]
async fn mesh_status_captures_unknown_fields_in_extras() {
    let server = mock().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/network/mesh/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "ap_active": true,
            "auto_mesh": false,
            "connected_to_seed": false,
            "device_id": "abc",
            "has_mesh_password": false,
            "peer_count": 0,
            "peers": [],
            // Future fields that v0.20.0 does not emit
            "mesh_mtu": 1420,
            "radio": "wlan0_ap"
        })))
        .mount(&server)
        .await;

    let got = client(&server).mesh().status().await.expect("decoded");
    assert!(!got.extras.is_empty());
    assert_eq!(
        got.extras.get("mesh_mtu").and_then(|v| v.as_u64()),
        Some(1420)
    );
    assert_eq!(
        got.extras.get("radio").and_then(|v| v.as_str()),
        Some("wlan0_ap")
    );
}
