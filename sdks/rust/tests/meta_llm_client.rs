#![cfg(feature = "meta-llm")]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use cognitum_one::agentic::static_api_key_provider::{
    StaticApiKeyCredentialProvider, StaticApiKeyCredentialProviderOptions,
};
use cognitum_one::agentic::{
    AgenticError, AgenticErrorKind, CapabilitySet, CapabilitySource, Credential,
    CredentialAuthority, CredentialProvider, CredentialRequest, RedactedSecret,
};
use cognitum_one::meta_llm::{MetaLlmClient, MetaLlmClientConfig};
use serde_json::json;
use wiremock::matchers::{header, header_exists, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn credential_provider(base_url: &str) -> Arc<StaticApiKeyCredentialProvider> {
    Arc::new(
        StaticApiKeyCredentialProvider::new(
            "meta-llm",
            base_url,
            base_url,
            StaticApiKeyCredentialProviderOptions {
                api_key: Some("sk-test-canary-1234".to_owned()),
                ..Default::default()
            },
        )
        .expect("provider should construct"),
    )
}

/// Spy `CredentialProvider` that counts `acquire()` calls, so tests can
/// prove `health()` (ADR-0024a §D1: process-level response only) never
/// attempts credential acquisition even when a provider IS configured.
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
            scheme: "X-API-Key".to_owned(),
            secret: RedactedSecret::new("sk-spy-canary"),
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

/// Config pointed at a wiremock `http://` server. `allow_insecure_http` is
/// test-only per the doc comment on the field itself — never set against a
/// real deployment.
fn insecure_config(base_url: impl Into<String>) -> MetaLlmClientConfig {
    let mut config = MetaLlmClientConfig::new(base_url);
    config.allow_insecure_http = true;
    config
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

#[test]
fn construction_performs_no_io_and_requires_https() {
    let config = MetaLlmClientConfig::new("https://meta-llm.test.cognitum.one");
    assert!(MetaLlmClient::new(config).is_ok());
}

#[test]
fn rejects_non_https_base_url_by_default() {
    let config = MetaLlmClientConfig::new("http://127.0.0.1:9999");
    let err = MetaLlmClient::new(config).unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Configuration);
}

#[test]
fn allows_non_https_base_url_when_opted_in() {
    let mut config = MetaLlmClientConfig::new("http://127.0.0.1:9999");
    config.allow_insecure_http = true;
    assert!(MetaLlmClient::new(config).is_ok());
}

#[test]
fn rejects_missing_base_url() {
    let config = MetaLlmClientConfig::new("");
    assert!(MetaLlmClient::new(config).is_err());
}

#[test]
fn allow_insecure_http_rejects_non_loopback_host() {
    // ADR-0022 §D3: disabling TLS is allowed only for loopback development.
    let mut config = MetaLlmClientConfig::new("http://example.com:9999");
    config.allow_insecure_http = true;
    let err = MetaLlmClient::new(config).unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Configuration);
}

#[test]
fn allow_insecure_http_rejects_hostname_resolving_to_loopback() {
    // ADR-0022 §D3: hostname resolution to loopback (e.g. "localhost") is
    // insufficient — only a literal IPv4/IPv6 loopback address qualifies.
    let mut config = MetaLlmClientConfig::new("http://localhost:9999");
    config.allow_insecure_http = true;
    let err = MetaLlmClient::new(config).unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Configuration);
}

#[test]
fn allow_insecure_http_accepts_literal_ipv6_loopback() {
    let mut config = MetaLlmClientConfig::new("http://[::1]:9999");
    config.allow_insecure_http = true;
    assert!(MetaLlmClient::new(config).is_ok());
}

// ---------------------------------------------------------------------------
// health()
// ---------------------------------------------------------------------------

#[tokio::test]
async fn health_returns_data_without_credential_provider() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/health"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "status": "ok",
            "version": "0.0.1"
        })))
        .mount(&server)
        .await;

    let config = insecure_config(server.uri());
    let client = MetaLlmClient::new(config).unwrap();

    let result = client.health().await.unwrap();
    assert_eq!(result.data.status, "ok");
    assert_eq!(result.data.version.as_deref(), Some("0.0.1"));
    assert_eq!(result.meta.http_status, 200);
}

#[tokio::test]
async fn health_maps_503_to_retryable_transport_error() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/health"))
        .respond_with(ResponseTemplate::new(503).set_body_json(json!({"error": "unavailable"})))
        .mount(&server)
        .await;

    let config = insecure_config(server.uri());
    let client = MetaLlmClient::new(config).unwrap();

    let err = client.health().await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Transport);
    assert!(err.retryable);
    assert_eq!(err.status, Some(503));
}

#[tokio::test]
async fn health_never_acquires_a_credential_even_when_a_provider_is_configured() {
    // FIX 3 regression test: ADR-0024a §D1 says health() is process-level
    // response only. Before the fix, `get_json` called
    // `resolve_credential` (and thus `provider.acquire()`) unconditionally
    // regardless of `require_credential`, only discarding the result for
    // health(). A SpyCredentialProvider proves acquire() is now skipped
    // entirely rather than acquired-and-discarded.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/health"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"status": "ok"})))
        .mount(&server)
        .await;

    let spy = Arc::new(SpyCredentialProvider::default());
    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(spy.clone());
    let client = MetaLlmClient::new(config).unwrap();

    let result = client.health().await.unwrap();
    assert_eq!(result.data.status, "ok");
    assert_eq!(
        spy.acquire_calls.load(Ordering::SeqCst),
        0,
        "health() must not acquire a credential even when one is configured"
    );
}

// ---------------------------------------------------------------------------
// whoami()
// ---------------------------------------------------------------------------

#[tokio::test]
async fn whoami_sends_credential_as_x_api_key() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/whoami"))
        .and(header_exists("X-API-Key"))
        .and(header("X-API-Key", "sk-test-canary-1234"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "account_id": "acct_1",
            "credential_type": "api_key"
        })))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let result = client.whoami().await.unwrap();
    assert_eq!(result.data.account_id.as_deref(), Some("acct_1"));
}

#[tokio::test]
async fn whoami_fails_closed_without_credential_provider() {
    let server = MockServer::start().await;
    // Deliberately no Mock registered: a request would panic/fail the test.
    let config = insecure_config(server.uri());
    let client = MetaLlmClient::new(config).unwrap();

    let err = client.whoami().await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Authentication);
}

#[tokio::test]
async fn whoami_rejects_credential_provider_bound_to_a_different_origin() {
    // FIX 4 regression test: a CredentialProvider constructed for a
    // DIFFERENT origin than the client's own base_url must be refused
    // (ADR-0022 §D3: "Credential providers are bound to the normalized
    // origin selected during client construction"). Deliberately no Mock
    // registered on the server — a request escaping to the wire would
    // panic/fail the test, proving no credential leaked to the wrong
    // origin either.
    let server = MockServer::start().await;
    let mismatched_provider = Arc::new(
        StaticApiKeyCredentialProvider::new(
            "meta-llm",
            "https://a-completely-different-origin.example.com",
            "https://a-completely-different-origin.example.com",
            StaticApiKeyCredentialProviderOptions {
                api_key: Some("sk-wrong-origin-canary".to_owned()),
                ..Default::default()
            },
        )
        .expect("provider should construct"),
    );

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(mismatched_provider);
    let client = MetaLlmClient::new(config).unwrap();

    let err = client.whoami().await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Authentication);
}

#[tokio::test]
async fn whoami_maps_401_to_non_retryable_authentication_error() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/whoami"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error": "invalid key"})))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let err = client.whoami().await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Authentication);
    assert!(!err.retryable);
    assert_eq!(err.status, Some(401));
}

#[tokio::test]
async fn whoami_maps_429_to_retryable_rate_limited() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/whoami"))
        .respond_with(
            ResponseTemplate::new(429)
                .set_body_json(json!({"error": "slow down"}))
                .insert_header("retry-after", "2"),
        )
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let err = client.whoami().await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::RateLimited);
    assert!(err.retryable);
}

// ---------------------------------------------------------------------------
// models()
// ---------------------------------------------------------------------------

#[tokio::test]
async fn models_returns_model_list() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "models": [{"id": "meta-llm-large"}]
        })))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let result = client.models().await.unwrap();
    assert_eq!(result.data.models.len(), 1);
    assert_eq!(result.data.models[0].id, "meta-llm-large");
}

// ---------------------------------------------------------------------------
// capabilities()
// ---------------------------------------------------------------------------

#[test]
fn capabilities_returns_configured_snapshot_without_io() {
    let mut config = MetaLlmClientConfig::new("https://meta-llm.test.cognitum.one");
    let snapshot = CapabilitySet {
        product: "meta-llm".to_owned(),
        product_version: "0.0.1".to_owned(),
        protocol: "cognitum.meta-llm.http".to_owned(),
        protocol_version: "1.0".to_owned(),
        features: Default::default(),
        limitations: vec![],
        auth_methods: vec!["api_key".to_owned()],
        source: CapabilitySource::StaticCompatibilityTable,
    };
    config.capabilities_snapshot = Some(snapshot.clone());
    let client = MetaLlmClient::new(config).unwrap();

    assert_eq!(
        client.capabilities().product_version,
        snapshot.product_version
    );
}

#[test]
fn capabilities_falls_back_to_intersection_safe_default() {
    let config = MetaLlmClientConfig::new("https://meta-llm.test.cognitum.one");
    let client = MetaLlmClient::new(config).unwrap();
    let caps = client.capabilities();
    assert!(caps.features.is_empty());
    assert_eq!(caps.source, CapabilitySource::StaticCompatibilityTable);
}

// ---------------------------------------------------------------------------
// ready()
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ready_fails_closed() {
    let config = MetaLlmClientConfig::new("https://meta-llm.test.cognitum.one");
    let client = MetaLlmClient::new(config).unwrap();

    let err = client.ready("chat").await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::UnsupportedCapability);
}

// ---------------------------------------------------------------------------
// Protocol placeholders
// ---------------------------------------------------------------------------

#[tokio::test]
async fn protocol_operations_are_not_implemented_yet() {
    use cognitum_one::meta_llm::types::{
        CountTokensRequest, EmbeddingRequest, LegacyCompletionRequest, ResponsesRequest,
    };

    let config = MetaLlmClientConfig::new("https://meta-llm.test.cognitum.one");
    let client = MetaLlmClient::new(config).unwrap();

    // `chat_completions` and `messages_create` now have real HTTP call
    // logic (issue #58 / M2 continuation) — see the dedicated
    // `chat_completions_*` / `messages_create_*` tests below. The other
    // three protocol operations remain follow-up-issue placeholders.
    let completions_err = client
        .completions(&LegacyCompletionRequest {
            model: "m".into(),
            prompt: cognitum_one::meta_llm::types::StringOrStrings::One("hi".into()),
            max_tokens: None,
            temperature: None,
            top_p: None,
            n: None,
            stream: None,
            logprobs: None,
            echo: None,
            stop: None,
            presence_penalty: None,
            frequency_penalty: None,
            best_of: None,
            logit_bias: None,
            user: None,
        })
        .await
        .unwrap_err();
    assert_eq!(
        completions_err.kind,
        AgenticErrorKind::UnsupportedCapability
    );

    let count_tokens_err = client
        .messages_count_tokens(&CountTokensRequest {
            model: "m".into(),
            messages: vec![],
            system: None,
            tools: None,
        })
        .await
        .unwrap_err();
    assert_eq!(
        count_tokens_err.kind,
        AgenticErrorKind::UnsupportedCapability
    );

    let responses_err = client
        .responses(&ResponsesRequest {
            model: "m".into(),
            input: cognitum_one::meta_llm::types::ChatMessageContent::Text("hi".into()),
            instructions: None,
            previous_response_id: None,
            max_output_tokens: None,
            temperature: None,
            top_p: None,
            stream: None,
            tools: None,
            tool_choice: None,
            metadata: None,
        })
        .await
        .unwrap_err();
    assert_eq!(responses_err.kind, AgenticErrorKind::UnsupportedCapability);

    let embeddings_err = client
        .embeddings(&EmbeddingRequest {
            model: "m".into(),
            input: cognitum_one::meta_llm::types::StringOrStrings::One("hi".into()),
            encoding_format: None,
            dimensions: None,
            user: None,
        })
        .await
        .unwrap_err();
    assert_eq!(embeddings_err.kind, AgenticErrorKind::UnsupportedCapability);
}
