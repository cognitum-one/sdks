#![cfg(feature = "meta-proxy")]

//! ADR-0025a §D9 integration tests: the tractable consent-gating slice.
//!
//! §D9: "Separate ADR-0022 grants cover Cognitum cloud routing, sponsor,
//! power saver, direct Anthropic, and training contribution. Credential
//! presence is not consent. Headless clients return `ConsentRequiredError`
//! rather than prompt." These tests prove `chat_completions` and
//! `chat_completions_stream` fail with `ConsentRequiredError` BEFORE any
//! HTTP I/O when a `RoutingIntent` touches the `cognitum_cloud` plane and no
//! matching `cloud_fallback` consent grant is configured — even though a
//! perfectly valid local bearer credential IS present.

use std::sync::Arc;

use cognitum_one::agentic::{AgenticErrorKind, ConsentGrant, ConsentGrantKind};
use cognitum_one::meta_llm::types::openai::{
    ChatCompletionRequest, ChatMessage, ChatMessageContent, ChatRole,
};
use cognitum_one::meta_proxy::{
    LocalBearerTokenCredentialProvider, LocalBearerTokenCredentialProviderOptions,
    MetaProxyChatCallOptions, MetaProxyClient, MetaProxyClientConfig, RoutingIntent, RoutingPlane,
    WorkloadPolicy, CLOUD_ROUTING_CONSENT_KIND,
};
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const CANARY_BEARER: &str = "mh1.canary-local-token";

fn bearer_provider(origin: &str) -> Arc<LocalBearerTokenCredentialProvider> {
    Arc::new(
        LocalBearerTokenCredentialProvider::new(
            origin,
            origin,
            LocalBearerTokenCredentialProviderOptions {
                token: Some(CANARY_BEARER.to_owned()),
                ..Default::default()
            },
        )
        .expect("provider should construct"),
    )
}

fn chat_request() -> ChatCompletionRequest {
    ChatCompletionRequest {
        model: "cognitum-small".to_owned(),
        messages: vec![ChatMessage {
            role: ChatRole::User,
            content: Some(ChatMessageContent::Text("hi".to_owned())),
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
        routing_controls: None,
    }
}

fn chat_response_with_receipt(selected_plane: &str) -> serde_json::Value {
    json!({
        "id": "chatcmpl-1",
        "object": "chat.completion",
        "created": 1,
        "model": "cognitum-small",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "hello"},
            "finish_reason": "stop"
        }],
        "cognitum_routing_receipt": {
            "request_id": "rr_1",
            "configured_plane": "cognitum_cloud",
            "selected_plane": selected_plane,
            "automatic": false,
            "workload_policy": "standard"
        }
    })
}

async fn mount_chat_ok(server: &MockServer, body: serde_json::Value) {
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(server)
        .await;
}

fn client_for(server: &MockServer) -> MetaProxyClient {
    let mut config = MetaProxyClientConfig::with_origin(server.uri());
    config.local_credential_provider = Some(bearer_provider(&server.uri()));
    MetaProxyClient::new(config).unwrap()
}

fn client_with_consent_for(server: &MockServer) -> MetaProxyClient {
    let mut config = MetaProxyClientConfig::with_origin(server.uri());
    config.local_credential_provider = Some(bearer_provider(&server.uri()));
    config.consent_grants = vec![ConsentGrant {
        kind: ConsentGrantKind::CloudFallback,
        product: "meta-proxy".to_owned(),
        origin: server.uri(),
        subject: "test-subject".to_owned(),
        scope: "chat_completions".to_owned(),
        issued_at: "2026-01-01T00:00:00Z".to_owned(),
        expires_at: None,
        evidence_id: None,
    }];
    MetaProxyClient::new(config).unwrap()
}

fn cloud_intent() -> RoutingIntent {
    RoutingIntent {
        allowed_planes: vec![RoutingPlane::CognitumCloud],
        workload_policy: WorkloadPolicy::Standard,
        ..RoutingIntent::default()
    }
}

// ---------------------------------------------------------------------------
// chat_completions() — fails BEFORE any HTTP I/O
// ---------------------------------------------------------------------------

#[tokio::test]
async fn chat_completions_rejects_with_consent_required_despite_a_valid_credential() {
    let server = MockServer::start().await;
    // Deliberately no mock is mounted at all: if the SDK's consent gate ever
    // regressed and let the call reach the transport, the unmatched request
    // would surface as a different (non-ConsentRequired) error kind — e.g. a
    // wiremock 404 mapped to `not_found` — so this test would still catch
    // the regression even without an explicit "transport was never called"
    // assertion.
    let client = client_for(&server);

    let options = MetaProxyChatCallOptions {
        routing_intent: Some(cloud_intent()),
        ..Default::default()
    };
    let err = client
        .chat_completions(&chat_request(), Some(options))
        .await
        .expect_err("cognitum_cloud intent without a consent grant must fail closed");
    assert_eq!(err.kind, AgenticErrorKind::ConsentRequired);
    assert!(!err.retryable);
}

#[tokio::test]
async fn chat_completions_rejects_when_required_plane_is_cognitum_cloud() {
    let server = MockServer::start().await;
    let client = client_for(&server);

    let options = MetaProxyChatCallOptions {
        routing_intent: Some(RoutingIntent {
            required_plane: Some(RoutingPlane::CognitumCloud),
            workload_policy: WorkloadPolicy::Standard,
            ..RoutingIntent::default()
        }),
        ..Default::default()
    };
    let err = client
        .chat_completions(&chat_request(), Some(options))
        .await
        .expect_err("required_plane cognitum_cloud without consent must fail closed");
    assert_eq!(err.kind, AgenticErrorKind::ConsentRequired);
}

#[tokio::test]
async fn chat_completions_succeeds_once_a_matching_grant_is_configured() {
    let server = MockServer::start().await;
    mount_chat_ok(&server, chat_response_with_receipt("cognitum_cloud")).await;
    let client = client_with_consent_for(&server);

    let options = MetaProxyChatCallOptions {
        routing_intent: Some(cloud_intent()),
        ..Default::default()
    };
    let result = client
        .chat_completions(&chat_request(), Some(options))
        .await
        .expect("a matching cloud_fallback grant must satisfy the gate");
    assert_eq!(result.data.id, "chatcmpl-1");
}

#[tokio::test]
async fn chat_completions_does_not_require_consent_for_a_local_only_intent() {
    let server = MockServer::start().await;
    mount_chat_ok(&server, chat_response_with_receipt("local")).await;
    let client = client_for(&server);

    let options = MetaProxyChatCallOptions {
        routing_intent: Some(RoutingIntent {
            required_plane: Some(RoutingPlane::Local),
            allowed_planes: vec![RoutingPlane::Local],
            workload_policy: WorkloadPolicy::Standard,
            ..RoutingIntent::default()
        }),
        ..Default::default()
    };
    let result = client
        .chat_completions(&chat_request(), Some(options))
        .await
        .expect("a local-only intent is never consent-gated");
    assert_eq!(result.data.id, "chatcmpl-1");
}

#[tokio::test]
async fn chat_completions_does_not_require_consent_when_no_routing_intent() {
    let server = MockServer::start().await;
    mount_chat_ok(&server, chat_response_with_receipt("local")).await;
    let client = client_for(&server);

    let result = client
        .chat_completions(&chat_request(), None)
        .await
        .expect("no routing intent at all is never consent-gated");
    assert_eq!(result.data.id, "chatcmpl-1");
}

// ---------------------------------------------------------------------------
// chat_completions_stream() — fails BEFORE opening the connection
// ---------------------------------------------------------------------------

#[tokio::test]
async fn chat_completions_stream_rejects_with_consent_required_before_any_connection() {
    let server = MockServer::start().await;
    // No mock mounted — the gate must fire before `chat_completions_stream`
    // ever attempts to open the streaming connection.
    let client = client_for(&server);

    let options = MetaProxyChatCallOptions {
        routing_intent: Some(cloud_intent()),
        ..Default::default()
    };
    // `MetaProxyChatCompletionsStream` (the `Ok` type) does not implement
    // `Debug`, so `expect_err`/`unwrap_err` (which require `T: Debug` even on
    // the error path) cannot be used here — match manually instead.
    match client
        .chat_completions_stream(&chat_request(), Some(options), None, None)
        .await
    {
        Ok(_) => panic!("cognitum_cloud intent without a consent grant must fail closed"),
        Err(err) => {
            assert_eq!(err.kind, AgenticErrorKind::ConsentRequired);
            assert_eq!(err.product.as_deref(), Some("meta-proxy"));
        }
    }
}

// ---------------------------------------------------------------------------
// Machine-readable required kind (§D7: "a machine-readable required kind")
// ---------------------------------------------------------------------------

#[test]
fn cloud_routing_consent_kind_is_cloud_fallback() {
    assert_eq!(CLOUD_ROUTING_CONSENT_KIND, ConsentGrantKind::CloudFallback);
}
