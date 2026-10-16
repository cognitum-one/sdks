//! ADR-0005 retriable outcomes and idempotency rule for the cloud `Client`.
//!
//! A POST that reached the server may already have committed, so a 5xx on a
//! POST is returned to the caller instead of being sent again. 429 is still
//! retried for every method (the server refused without acting), and
//! idempotent methods retry 500/502/503/504. Node and Python follow the same
//! rule; these tests pin Rust to it.

use cognitum_one::{Client, ClientConfig, Error};
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn client(base_url: &str, max_retries: u32) -> Client {
    Client::with_config(ClientConfig {
        api_key: "test-key".to_owned(),
        base_url: Some(base_url.to_owned()),
        timeout_secs: 10,
        max_retries,
        ..Default::default()
    })
}

async fn post_attempts_after(status: u16) -> usize {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/createPresalePaymentIntent"))
        .respond_with(ResponseTemplate::new(status).set_body_string("upstream failed"))
        .mount(&server)
        .await;

    let err = client(&server.uri(), 3)
        .orders()
        .create("buyer@example.com", 1)
        .await
        .unwrap_err();
    assert!(
        matches!(err, Error::Api { code, .. } if code == status),
        "expected Api {{ code: {status} }}, got: {err:?}"
    );
    server.received_requests().await.unwrap().len()
}

#[tokio::test]
async fn post_is_not_resent_after_5xx() {
    for status in [500u16, 502, 503, 504] {
        assert_eq!(
            post_attempts_after(status).await,
            1,
            "POST was sent more than once after a {status}"
        );
    }
}

#[tokio::test]
async fn post_is_retried_after_429() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/createPresalePaymentIntent"))
        .respond_with(
            ResponseTemplate::new(429).set_body_json(json!({"retry_after_us": 10_000u64})),
        )
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/createPresalePaymentIntent"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"clientSecret": "cs_test_123"})),
        )
        .mount(&server)
        .await;

    client(&server.uri(), 3)
        .orders()
        .create("buyer@example.com", 1)
        .await
        .unwrap();
    assert_eq!(server.received_requests().await.unwrap().len(), 2);
}

async fn get_recovers_after(status: u16) {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/health"))
        .respond_with(ResponseTemplate::new(status))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/health"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"status": "ok"})))
        .mount(&server)
        .await;

    let resp = client(&server.uri(), 3).health().await.unwrap();
    assert_eq!(resp.status, "ok");
    assert_eq!(
        server.received_requests().await.unwrap().len(),
        2,
        "GET was not retried after a {status}"
    );
}

#[tokio::test]
async fn get_is_retried_after_502() {
    get_recovers_after(502).await;
}

#[tokio::test]
async fn get_is_retried_after_504() {
    get_recovers_after(504).await;
}

#[tokio::test]
async fn forbidden_maps_to_auth_error() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/health"))
        .respond_with(ResponseTemplate::new(403).set_body_string("key not allowed"))
        .mount(&server)
        .await;

    let err = client(&server.uri(), 0).health().await.unwrap_err();
    assert!(
        matches!(err, Error::Auth(ref m) if m == "key not allowed"),
        "expected Auth, got: {err:?}"
    );
}
