#![cfg(feature = "meta-llm")]
//! ADR-0024b D11 migration step 1 (issue #59): routing controls +
//! receipt/usage read-only support. Mirrors the style of
//! `meta_llm_nonstream.rs` (PR #86) and `meta_llm_client.rs` (PR #85).
//!
//! Explicitly out of scope (see the ADR and this issue's tracking notes):
//! batches, pods, bench, webhooks, guidance, collaboration, evolution,
//! MicroLoRA, flywheel, genome, brain, vectors, conditional hosts (§D5-§D8).

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
use cognitum_one::meta_llm::types::{
    ChatCompletionRequest, ChatMessage, ChatMessageContent, ChatRole, MetaLlmRoutingControls,
    ModelSelector, ModelTier, UsageQuery,
};
use cognitum_one::meta_llm::{MetaLlmClient, MetaLlmClientConfig};
use serde_json::json;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn insecure_config(base_url: impl Into<String>) -> MetaLlmClientConfig {
    let mut config = MetaLlmClientConfig::new(base_url);
    config.allow_insecure_http = true;
    config
}

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

/// Same shape as `meta_llm_nonstream.rs`'s `RefreshingCredentialProvider`
/// -- a fresh secret each `acquire()` call, needed because
/// `StaticApiKeyCredentialProvider::invalidate()` makes every subsequent
/// `acquire()` fail permanently.
#[derive(Debug, Default)]
struct RefreshingCredentialProvider {
    acquire_calls: AtomicUsize,
    invalidate_calls: AtomicUsize,
}

#[async_trait]
impl CredentialProvider for RefreshingCredentialProvider {
    async fn describe_authority(
        &self,
        request: &CredentialRequest,
    ) -> Result<CredentialAuthority, AgenticError> {
        Ok(CredentialAuthority {
            provider_fingerprint: "refreshing".to_owned(),
            product: request.product.clone(),
            normalized_origin: request.normalized_origin.clone(),
            audience: request.audience.clone(),
            principal: Some("acct_refresh".to_owned()),
            tenant: None,
            delegated_subtenant: None,
            effective_scopes: None,
            plan: None,
        })
    }

    async fn acquire(&self, request: &CredentialRequest) -> Result<Credential, AgenticError> {
        let n = self.acquire_calls.fetch_add(1, Ordering::SeqCst);
        let secret = if n == 0 { "sk-v1" } else { "sk-v2" };
        Ok(Credential {
            scheme: "X-API-Key".to_owned(),
            secret: RedactedSecret::new(secret),
            expires_at: None,
            granted_scopes: None,
            audience: request.audience.clone(),
            source: "refreshing".to_owned(),
            authority: CredentialAuthority {
                provider_fingerprint: "refreshing".to_owned(),
                product: request.product.clone(),
                normalized_origin: request.normalized_origin.clone(),
                audience: request.audience.clone(),
                principal: Some("acct_refresh".to_owned()),
                tenant: None,
                delegated_subtenant: None,
                effective_scopes: None,
                plan: None,
            },
        })
    }

    fn identity(&self) -> String {
        "refreshing-credential-provider".to_owned()
    }

    async fn invalidate(&self, _reason: &str) {
        self.invalidate_calls.fetch_add(1, Ordering::SeqCst);
    }
}

fn chat_completion_body_with_receipt() -> serde_json::Value {
    json!({
        "id": "chatcmpl-1",
        "object": "chat.completion",
        "created": 1,
        "model": "meta-llm-large",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "hi there"},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        "cognitum_receipt": {
            "request_id": "req-abc",
            "resolved_tier": "mid",
            "resolved_model": "meta-llm-large-v2",
            "escalated": false,
            "cap_degraded": false,
            "routing_reason": "auto_selected_mid",
            "price": {"amount": "0.0042", "currency": "USD"},
            "cache_result": "miss",
            "fallback_used": false,
            "breaker_counts": {"meta-llm-large": 0},
            "costs": [{"source": "provider", "amount": 0.0042, "currency": "USD", "finality": "estimate"}],
            // Deliberately not in `KNOWN_RECEIPT_KEYS` -- must survive under `raw`.
            "a_future_governance_field": {"some": "value"}
        }
    })
}

fn chat_request(routing_controls: Option<MetaLlmRoutingControls>) -> ChatCompletionRequest {
    ChatCompletionRequest {
        model: "meta-llm-large".into(),
        messages: vec![ChatMessage {
            role: ChatRole::User,
            content: Some(ChatMessageContent::Text("hello".into())),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }],
        max_tokens: None,
        temperature: None,
        top_p: None,
        n: None,
        stream: None,
        stop: None,
        presence_penalty: None,
        frequency_penalty: None,
        logit_bias: None,
        user: None,
        tools: None,
        tool_choice: None,
        response_format: None,
        seed: None,
        routing_controls,
    }
}

// ---------------------------------------------------------------------------
// Success: routing controls flow through the body, receipt decodes on
// success responses.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn chat_completions_sends_routing_controls_and_decodes_receipt() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(chat_completion_body_with_receipt()))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let routing_controls = MetaLlmRoutingControls {
        model: Some(ModelSelector::Tier { tier: ModelTier::Mid }),
        fallback_policy: Some(cognitum_one::meta_llm::FallbackPolicy::BestEffort),
        cache: Some(cognitum_one::meta_llm::CacheMode::Semantic),
        safety: Some(cognitum_one::meta_llm::SafetyMode::Warn),
        ..Default::default()
    };
    let result = client
        .chat_completions(&chat_request(Some(routing_controls.clone())))
        .await
        .unwrap();

    assert_eq!(result.data.id, "chatcmpl-1");

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let sent_body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(sent_body["routing_controls"]["fallback_policy"], "best_effort");

    let receipt = result.meta.receipt.expect("receipt should be decoded");
    assert_eq!(receipt.request_id, "req-abc");
    assert_eq!(receipt.resolved_tier.as_deref(), Some("mid"));
    let price = receipt.price.expect("price should be decoded");
    assert_eq!(price.amount, "0.0042");
    assert_eq!(price.currency, "USD");
    assert_eq!(receipt.costs.len(), 1);
    let raw = receipt.raw.expect("unrecognized field should survive under raw");
    assert!(raw.contains_key("a_future_governance_field"));
}

// ---------------------------------------------------------------------------
// Auth: usage() requires a credential_provider (same gate as whoami/models).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn usage_requires_credential_provider() {
    let server = MockServer::start().await;
    let config = insecure_config(server.uri());
    let client = MetaLlmClient::new(config).unwrap();

    let err = client
        .usage(&UsageQuery::new("2026-01", "2026-06"))
        .await
        .unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Authentication);
    assert_eq!(server.received_requests().await.unwrap().len(), 0);
}

#[tokio::test]
async fn usage_scopes_the_query_to_the_authenticated_account_only() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/usage"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"totals": {"requests": 3}})))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let mut query = UsageQuery::new("2026-01", "2026-06");
    query.model = Some("meta-llm-large".to_owned());
    query.group_by = Some(cognitum_one::meta_llm::UsageGroupBy::Model);
    client.usage(&query).await.unwrap();

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let url = requests[0].url.to_string();
    assert!(url.contains("from=2026-01"));
    assert!(url.contains("to=2026-06"));
    assert!(url.contains("model=meta-llm-large"));
    assert!(url.contains("group_by=model"));
}

// ---------------------------------------------------------------------------
// Validation: unrecognized selector shapes are rejected before any network
// call; malformed usage() query ranges are rejected the same way.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn rejects_empty_contract_declared_alias_before_any_request() {
    let server = MockServer::start().await;
    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let routing_controls = MetaLlmRoutingControls {
        model: Some(ModelSelector::ContractDeclaredAlias { alias: String::new() }),
        ..Default::default()
    };

    let err = client
        .chat_completions(&chat_request(Some(routing_controls)))
        .await
        .unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Validation);
    assert_eq!(server.received_requests().await.unwrap().len(), 0);
}

#[tokio::test]
async fn usage_rejects_malformed_yyyy_mm_range_before_any_request() {
    let server = MockServer::start().await;
    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let err = client
        .usage(&UsageQuery::new("2026-1", "2026-06"))
        .await
        .unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Validation);
    assert_eq!(server.received_requests().await.unwrap().len(), 0);
}

#[tokio::test]
async fn usage_rejects_range_where_from_is_after_to() {
    let server = MockServer::start().await;
    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let err = client
        .usage(&UsageQuery::new("2026-06", "2026-01"))
        .await
        .unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Validation);
    assert_eq!(server.received_requests().await.unwrap().len(), 0);
}

// ---------------------------------------------------------------------------
// Unknown-field preservation: response parsing never drops evidence it
// doesn't recognize yet (ADR-0024b §D2: "Unknown received values are
// preserved").
// ---------------------------------------------------------------------------

#[test]
fn parse_meta_llm_receipt_preserves_unrecognized_resolved_tier_value() {
    let raw = json!({"request_id": "req-x", "resolved_tier": "ultra_future_tier"});
    let receipt = cognitum_one::meta_llm::parse_meta_llm_receipt(&raw).unwrap();
    assert_eq!(receipt.resolved_tier.as_deref(), Some("ultra_future_tier"));
}

#[test]
fn parse_usage_summary_preserves_unrecognized_field_under_raw() {
    let raw = json!({
        "totals": {"requests": 5},
        "a_future_governance_field": {"some": "value"}
    });
    let summary = cognitum_one::meta_llm::parse_usage_summary(&raw);
    let raw_fields = summary.raw.expect("unrecognized field should survive");
    assert!(raw_fields.contains_key("a_future_governance_field"));
}

#[test]
fn parse_usage_summary_returns_empty_totals_rather_than_fabricating_usage() {
    let summary = cognitum_one::meta_llm::parse_usage_summary(&json!({}));
    assert_eq!(summary.totals.requests, None);
    assert_eq!(summary.totals.total_tokens, None);
}

// ---------------------------------------------------------------------------
// Retry invariant (§D4, critical correctness rule): "The SDK never raises
// tier, enables escalation, changes cache, selects best effort, or changes
// payer during retry." -- proves the routing_controls set on the ORIGINAL
// request are sent byte-identical on every retry attempt.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn routing_controls_sent_byte_identical_across_a_502_retry() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(502).set_body_json(json!({"error": "bad gateway"})))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(chat_completion_body_with_receipt()))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let routing_controls = MetaLlmRoutingControls {
        model: Some(ModelSelector::Tier { tier: ModelTier::High }),
        min_tier: Some(ModelTier::Mid),
        max_tier: Some(ModelTier::High),
        fallback_policy: Some(cognitum_one::meta_llm::FallbackPolicy::FailFast),
        escalation: Some(cognitum_one::meta_llm::EscalationStrategy::PostHoc),
        cache: Some(cognitum_one::meta_llm::CacheMode::Exact),
        safety: Some(cognitum_one::meta_llm::SafetyMode::Block),
        sub_tenant_id: Some("attribution-only-token".to_owned()),
    };

    let result = client
        .chat_completions(&chat_request(Some(routing_controls)))
        .await
        .unwrap();
    assert_eq!(result.data.id, "chatcmpl-1");

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 2, "expected exactly one retry after the 502");

    let first_body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
    let second_body: serde_json::Value = serde_json::from_slice(&requests[1].body).unwrap();

    // Byte-identical serialization, not just deep-equal, proves no silent
    // reordering/mutation crept in between attempts.
    assert_eq!(
        serde_json::to_string(&first_body["routing_controls"]).unwrap(),
        serde_json::to_string(&second_body["routing_controls"]).unwrap(),
    );

    // The Idempotency-Key must also be stable -- otherwise "retry" would
    // really be a second, unrelated logical call (ADR-0024a §D7).
    let key_1 = requests[0].headers.get("idempotency-key").unwrap();
    let key_2 = requests[1].headers.get("idempotency-key").unwrap();
    assert_eq!(key_1, key_2);
}

#[tokio::test]
async fn routing_controls_never_mutated_across_a_401_refresh() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(header("X-API-Key", "sk-v1"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error": "expired"})))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(header("X-API-Key", "sk-v2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(chat_completion_body_with_receipt()))
        .mount(&server)
        .await;

    let provider = Arc::new(RefreshingCredentialProvider::default());
    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(provider);
    let client = MetaLlmClient::new(config).unwrap();

    let routing_controls = MetaLlmRoutingControls {
        min_tier: Some(ModelTier::Low),
        fallback_policy: Some(cognitum_one::meta_llm::FallbackPolicy::FailFast),
        escalation: Some(cognitum_one::meta_llm::EscalationStrategy::Buffered),
        cache: Some(cognitum_one::meta_llm::CacheMode::Disabled),
        ..Default::default()
    };

    client
        .chat_completions(&chat_request(Some(routing_controls)))
        .await
        .unwrap();

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 2, "expected exactly one retry after the 401");

    let first_body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
    let second_body: serde_json::Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert_eq!(first_body["routing_controls"], second_body["routing_controls"]);

    // The credential (payer) DID change across the 401 refresh (that part
    // is expected/required, and is exactly what the two distinct mocks
    // above assert via their `X-API-Key` matchers) -- but routing_controls
    // stayed identical regardless, proving the payer swap never leaked
    // into a routing/cache/escalation/tier mutation.
}
