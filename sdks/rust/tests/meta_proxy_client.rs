#![cfg(feature = "meta-proxy")]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use cognitum_one::agentic::static_api_key_provider::{
    StaticApiKeyCredentialProvider, StaticApiKeyCredentialProviderOptions,
};
use cognitum_one::agentic::{
    AgenticError, AgenticErrorKind, Credential, CredentialAuthority, CredentialProvider,
    CredentialRequest, RedactedSecret,
};
use cognitum_one::meta_proxy::{MetaProxyClient, MetaProxyClientConfig};
use serde_json::json;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn local_bearer_provider(origin: &str) -> Arc<StaticApiKeyCredentialProvider> {
    Arc::new(
        StaticApiKeyCredentialProvider::new(
            "meta-proxy",
            origin,
            origin,
            StaticApiKeyCredentialProviderOptions {
                api_key: Some("mh1.canary-local-token".to_owned()),
                scheme: Some("bearer".to_owned()),
                ..Default::default()
            },
        )
        .expect("provider should construct"),
    )
}

/// Spy `CredentialProvider` that counts `acquire()` calls.
#[derive(Debug, Default)]
struct SpyCredentialProvider {
    acquire_calls: AtomicUsize,
}

#[async_trait]
impl CredentialProvider for SpyCredentialProvider {
    async fn describe_authority(
        &self,
        request: &CredentialRequest,
    ) -> Result<CredentialAuthority, AgenticError> {
        Ok(CredentialAuthority {
            provider_fingerprint: "spy".to_owned(),
            product: request.product.clone(),
            normalized_origin: request.normalized_origin.clone(),
            audience: request.audience.clone(),
            principal: None,
            tenant: None,
            delegated_subtenant: None,
            effective_scopes: None,
            plan: None,
        })
    }

    async fn acquire(&self, request: &CredentialRequest) -> Result<Credential, AgenticError> {
        self.acquire_calls.fetch_add(1, Ordering::SeqCst);
        Ok(Credential {
            scheme: "bearer".to_owned(),
            secret: RedactedSecret::new("mh1.spy-canary"),
            expires_at: None,
            granted_scopes: None,
            audience: request.audience.clone(),
            source: "spy".to_owned(),
            authority: CredentialAuthority {
                provider_fingerprint: "spy".to_owned(),
                product: request.product.clone(),
                normalized_origin: request.normalized_origin.clone(),
                audience: request.audience.clone(),
                principal: None,
                tenant: None,
                delegated_subtenant: None,
                effective_scopes: None,
                plan: None,
            },
        })
    }

    fn identity(&self) -> String {
        "spy-credential-provider".to_owned()
    }

    async fn invalidate(&self, _reason: &str) {}
}

fn full_status_body() -> serde_json::Value {
    json!({
        "product_version": "0.4.0",
        "protocol_version": "1.0",
        "compatible_sdk_range": ">=0.1.0 <1.0.0",
        "process_state": "running",
        "bind": "127.0.0.1:11435",
        "configured_plane": "local",
        "selected_plane": "local",
        "routing_reason": "configured_default",
        "automatic_usage_state": "disabled",
        "workload_policy": "standard",
        "sponsored_available": false,
        "cloud_credential_source": "none",
        "limitations": ["no capabilities endpoint published yet"],
        "request_id": "req_status_1"
    })
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

#[test]
fn construction_performs_no_io_and_defaults_to_documented_loopback_origin() {
    let config = MetaProxyClientConfig::new();
    assert_eq!(config.origin, "http://127.0.0.1:11435");
    assert!(MetaProxyClient::new(config).is_ok());
}

#[test]
fn accepts_an_explicit_loopback_origin() {
    let config = MetaProxyClientConfig::with_origin("http://127.0.0.1:19999");
    let client = MetaProxyClient::new(config).unwrap();
    assert_eq!(client.config().origin, "http://127.0.0.1:19999");
}

#[test]
fn accepts_a_literal_ipv6_loopback_origin() {
    let config = MetaProxyClientConfig::with_origin("http://[::1]:11435");
    assert!(MetaProxyClient::new(config).is_ok());
}

#[test]
fn rejects_a_non_loopback_origin_by_default() {
    let config = MetaProxyClientConfig::with_origin("http://example.com:11435");
    let err = MetaProxyClient::new(config).unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Configuration);
}

#[test]
fn rejects_a_hostname_that_merely_resolves_to_loopback() {
    let config = MetaProxyClientConfig::with_origin("http://localhost:11435");
    let err = MetaProxyClient::new(config).unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Configuration);
}

#[test]
fn allows_a_non_loopback_origin_when_opted_in() {
    let mut config = MetaProxyClientConfig::with_origin("http://example.com:11435");
    config.allow_non_loopback = true;
    assert!(MetaProxyClient::new(config).is_ok());
}

#[test]
fn rejects_a_non_http_origin() {
    let config = MetaProxyClientConfig::with_origin("ftp://127.0.0.1:11435");
    let err = MetaProxyClient::new(config).unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Configuration);
}

// ---------------------------------------------------------------------------
// status()
// ---------------------------------------------------------------------------

#[tokio::test]
async fn status_returns_parsed_data_on_success() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/status"))
        .and(header("Authorization", "Bearer mh1.canary-local-token"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(full_status_body())
                .insert_header("x-cognitum-request-id", "req_status_1"),
        )
        .mount(&server)
        .await;

    let mut config = MetaProxyClientConfig::with_origin(server.uri());
    config.local_credential_provider = Some(local_bearer_provider(&server.uri()));
    let client = MetaProxyClient::new(config).unwrap();

    let result = client.status().await.unwrap();
    assert_eq!(result.data.product_version, "0.4.0");
    assert_eq!(result.data.process_state, "running");
    assert_eq!(result.data.configured_plane, "local");
    assert_eq!(result.data.selected_plane, "local");
    assert_eq!(result.data.workload_policy.as_deref(), Some("standard"));
    assert_eq!(result.data.sponsored_available, Some(false));
    assert_eq!(result.meta.http_status, 200);
}

#[tokio::test]
async fn status_preserves_unrecognized_fields_verbatim_under_raw() {
    let server = MockServer::start().await;
    let mut body = full_status_body();
    body["a_brand_new_field_the_sdk_does_not_know_about"] = json!("surprise");
    Mock::given(method("GET"))
        .and(path("/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(&server)
        .await;

    let mut config = MetaProxyClientConfig::with_origin(server.uri());
    config.local_credential_provider = Some(local_bearer_provider(&server.uri()));
    let client = MetaProxyClient::new(config).unwrap();

    let result = client.status().await.unwrap();
    assert_eq!(
        result.data.raw.get("a_brand_new_field_the_sdk_does_not_know_about"),
        Some(&json!("surprise"))
    );
}

#[tokio::test]
async fn status_fails_closed_without_a_local_credential_provider() {
    let server = MockServer::start().await;
    // Deliberately no Mock registered: a request would panic/fail the test.
    let config = MetaProxyClientConfig::with_origin(server.uri());
    let client = MetaProxyClient::new(config).unwrap();

    let err = client.status().await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Authentication);
}

#[tokio::test]
async fn status_rejects_credential_provider_bound_to_a_different_origin() {
    let server = MockServer::start().await;
    let mismatched = local_bearer_provider("http://127.0.0.1:9");
    let mut config = MetaProxyClientConfig::with_origin(server.uri());
    config.local_credential_provider = Some(mismatched);
    let client = MetaProxyClient::new(config).unwrap();

    let err = client.status().await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Authentication);
}

#[tokio::test]
async fn status_maps_a_connection_failure_to_a_retryable_transport_error() {
    // Bind to a loopback port nothing is listening on.
    let mut config = MetaProxyClientConfig::with_origin("http://127.0.0.1:1");
    config.local_credential_provider = Some(local_bearer_provider("http://127.0.0.1:1"));
    let client = MetaProxyClient::new(config).unwrap();

    let err = client.status().await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Transport);
    assert!(err.retryable);
}

#[tokio::test]
async fn status_maps_401_to_non_retryable_authentication_error() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/status"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error": "invalid local token"})))
        .mount(&server)
        .await;

    let mut config = MetaProxyClientConfig::with_origin(server.uri());
    config.local_credential_provider = Some(local_bearer_provider(&server.uri()));
    let client = MetaProxyClient::new(config).unwrap();

    let err = client.status().await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Authentication);
    assert!(!err.retryable);
    assert_eq!(err.status, Some(401));
}

#[tokio::test]
async fn status_maps_429_to_retryable_rate_limited_error() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/status"))
        .respond_with(
            ResponseTemplate::new(429)
                .set_body_json(json!({"error": "slow down"}))
                .insert_header("retry-after", "3"),
        )
        .mount(&server)
        .await;

    let mut config = MetaProxyClientConfig::with_origin(server.uri());
    config.local_credential_provider = Some(local_bearer_provider(&server.uri()));
    let client = MetaProxyClient::new(config).unwrap();

    let err = client.status().await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::RateLimited);
    assert!(err.retryable);
}

#[tokio::test]
async fn status_maps_503_to_retryable_transport_error() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/status"))
        .respond_with(
            ResponseTemplate::new(503).set_body_json(json!({"error": "local backend unavailable"})),
        )
        .mount(&server)
        .await;

    let mut config = MetaProxyClientConfig::with_origin(server.uri());
    config.local_credential_provider = Some(local_bearer_provider(&server.uri()));
    let client = MetaProxyClient::new(config).unwrap();

    let err = client.status().await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Transport);
    assert!(err.retryable);
}

#[tokio::test]
async fn status_acquires_a_credential_exactly_once_per_call() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(full_status_body()))
        .mount(&server)
        .await;

    let spy = Arc::new(SpyCredentialProvider::default());
    let mut config = MetaProxyClientConfig::with_origin(server.uri());
    config.local_credential_provider = Some(spy.clone());
    let client = MetaProxyClient::new(config).unwrap();

    client.status().await.unwrap();
    assert_eq!(spy.acquire_calls.load(Ordering::SeqCst), 1);
}

// ---------------------------------------------------------------------------
// capabilities()
// ---------------------------------------------------------------------------

#[tokio::test]
async fn capabilities_derives_a_capability_set_shaped_result() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(full_status_body()))
        .mount(&server)
        .await;

    let mut config = MetaProxyClientConfig::with_origin(server.uri());
    config.local_credential_provider = Some(local_bearer_provider(&server.uri()));
    let client = MetaProxyClient::new(config).unwrap();

    let result = client.capabilities().await.unwrap();
    assert_eq!(result.data.capabilities.product, "meta-proxy");
    assert_eq!(result.data.capabilities.product_version, "0.4.0");
    assert_eq!(result.data.capabilities.protocol, "cognitum.meta-proxy.http");
    assert_eq!(result.data.configured_plane.as_deref(), Some("local"));
    assert_eq!(result.data.selected_plane.as_deref(), Some("local"));
    assert!(result
        .data
        .capabilities
        .limitations
        .iter()
        .any(|l| l == "no capabilities endpoint published yet"));
}

#[tokio::test]
async fn capabilities_fails_closed_without_a_local_credential_provider() {
    let server = MockServer::start().await;
    let config = MetaProxyClientConfig::with_origin(server.uri());
    let client = MetaProxyClient::new(config).unwrap();

    let err = client.capabilities().await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Authentication);
}

#[tokio::test]
async fn capabilities_warns_on_expected_proxy_version_mismatch() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(full_status_body()))
        .mount(&server)
        .await;

    let mut config = MetaProxyClientConfig::with_origin(server.uri());
    config.local_credential_provider = Some(local_bearer_provider(&server.uri()));
    config.expected_proxy_version = Some("9.9.9".to_owned());
    let client = MetaProxyClient::new(config).unwrap();

    let result = client.capabilities().await.unwrap();
    let warnings = result.meta.warnings.unwrap_or_default();
    assert!(warnings.iter().any(|w| w.contains("9.9.9")));
}

#[tokio::test]
async fn capabilities_never_sends_a_prompt_to_discover_support() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(full_status_body()))
        .expect(1)
        .mount(&server)
        .await;

    let mut config = MetaProxyClientConfig::with_origin(server.uri());
    config.local_credential_provider = Some(local_bearer_provider(&server.uri()));
    let client = MetaProxyClient::new(config).unwrap();

    client.capabilities().await.unwrap();
    // wiremock's `.expect(1)` on the single registered GET /status mock is
    // verified on drop — a POST (e.g. an inference probe) would not match
    // and would panic the test with "unexpected request".
}
