#![cfg(feature = "meta-llm")]
//! Real HTTP call logic for the remaining direct nonstream operations named
//! in ADR-0024a §D7 — `completions` (legacy OpenAI completions),
//! `responses`, `embeddings`, and `messages_count_tokens` — issue #58 / M2
//! continuation.
//!
//! This is mechanical reuse of the exact `chat_completions`/
//! `messages_create` pattern already proven in `meta_llm_nonstream.rs`
//! (PR #86): the same `post_json_idempotent` infrastructure, the same D6
//! error-mapping table, and the same D7 idempotency/retry loop. Per the
//! tracking issue, this file does NOT re-prove every status code or the
//! full retry/401-refresh matrix for each of the four operations — that
//! infrastructure is already covered. Instead: one success test per
//! operation (proving each operation wires into the shared infrastructure
//! correctly), one error-mapping smoke test, and one idempotency-retry
//! smoke test.

use cognitum_one::agentic::static_api_key_provider::{
    StaticApiKeyCredentialProvider, StaticApiKeyCredentialProviderOptions,
};
use cognitum_one::agentic::AgenticErrorKind;
use cognitum_one::meta_llm::types::{
    AnthropicMessageContent, AnthropicMessageParam, AnthropicRole, ChatMessageContent,
    CountTokensRequest, EmbeddingRequest, LegacyCompletionRequest, ResponsesRequest,
    StringOrStrings,
};
use cognitum_one::meta_llm::{MetaLlmClient, MetaLlmClientConfig};
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn insecure_config(base_url: impl Into<String>) -> MetaLlmClientConfig {
    let mut config = MetaLlmClientConfig::new(base_url);
    config.allow_insecure_http = true;
    config
}

fn credential_provider(base_url: &str) -> std::sync::Arc<StaticApiKeyCredentialProvider> {
    std::sync::Arc::new(
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

fn legacy_completion_request() -> LegacyCompletionRequest {
    LegacyCompletionRequest {
        model: "meta-llm-large".into(),
        prompt: StringOrStrings::One("hello".into()),
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
        routing_controls: None,
    }
}

fn responses_request() -> ResponsesRequest {
    ResponsesRequest {
        model: "meta-llm-large".into(),
        input: ChatMessageContent::Text("hello".into()),
        instructions: None,
        previous_response_id: None,
        max_output_tokens: None,
        temperature: None,
        top_p: None,
        stream: None,
        tools: None,
        tool_choice: None,
        metadata: None,
        routing_controls: None,
    }
}

fn embedding_request() -> EmbeddingRequest {
    EmbeddingRequest {
        model: "meta-llm-embed".into(),
        input: StringOrStrings::One("hello".into()),
        encoding_format: None,
        dimensions: None,
        user: None,
    }
}

fn count_tokens_request() -> CountTokensRequest {
    CountTokensRequest {
        model: "meta-llm-large".into(),
        messages: vec![AnthropicMessageParam {
            role: AnthropicRole::User,
            content: AnthropicMessageContent::Text("hello".into()),
        }],
        system: None,
        tools: None,
    }
}

fn legacy_completion_body() -> serde_json::Value {
    json!({
        "id": "cmpl-1",
        "object": "text_completion",
        "created": 1,
        "model": "meta-llm-large",
        "choices": [{"text": "hi there", "index": 0, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
    })
}

fn responses_body() -> serde_json::Value {
    json!({
        "id": "resp-1",
        "object": "response",
        "created_at": 1,
        "model": "meta-llm-large",
        "status": "completed",
        "output": [{
            "type": "message",
            "id": "out-1",
            "role": "assistant",
            "content": [{"type": "text", "text": "hi"}]
        }]
    })
}

fn embedding_body() -> serde_json::Value {
    json!({
        "object": "list",
        "data": [{"object": "embedding", "embedding": [0.1, 0.2], "index": 0}],
        "model": "meta-llm-embed",
        "usage": {"prompt_tokens": 3, "total_tokens": 3}
    })
}

fn count_tokens_body() -> serde_json::Value {
    json!({"input_tokens": 5})
}

// ---------------------------------------------------------------------------
// Success paths — one per operation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn completions_success_sends_idempotency_key() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(legacy_completion_body()))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let result = client
        .completions(&legacy_completion_request())
        .await
        .unwrap();
    assert_eq!(result.data.id, "cmpl-1");
    assert_eq!(result.meta.http_status, 200);

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].headers.contains_key("idempotency-key"));
}

#[tokio::test]
async fn responses_success_sends_idempotency_key() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/responses"))
        .respond_with(ResponseTemplate::new(200).set_body_json(responses_body()))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let result = client.responses(&responses_request()).await.unwrap();
    assert_eq!(result.data.id, "resp-1");
    assert_eq!(result.meta.http_status, 200);

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].headers.contains_key("idempotency-key"));
}

#[tokio::test]
async fn embeddings_success_sends_idempotency_key() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(ResponseTemplate::new(200).set_body_json(embedding_body()))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let result = client.embeddings(&embedding_request()).await.unwrap();
    assert_eq!(result.data.model, "meta-llm-embed");
    assert_eq!(result.data.data.len(), 1);

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].headers.contains_key("idempotency-key"));
}

#[tokio::test]
async fn messages_count_tokens_success_sends_idempotency_key() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages/count_tokens"))
        .respond_with(ResponseTemplate::new(200).set_body_json(count_tokens_body()))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let result = client
        .messages_count_tokens(&count_tokens_request())
        .await
        .unwrap();
    assert_eq!(result.data.input_tokens, 5);

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].headers.contains_key("idempotency-key"));
}

// ---------------------------------------------------------------------------
// D6 error mapping — smoke test only (full table already proven in
// meta_llm_nonstream.rs); one status on one operation proves this operation
// wires into the shared `MetaLlmClient::map_http_error` table correctly.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn embeddings_maps_429_to_retryable_rate_limited() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(
            ResponseTemplate::new(429)
                .set_body_json(json!({"error": "slow down"}))
                .insert_header("retry-after", "1"),
        )
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let err = client.embeddings(&embedding_request()).await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::RateLimited);
    assert!(err.retryable);
    assert_eq!(err.status, Some(429));
}

// ---------------------------------------------------------------------------
// D7 idempotency + bounded retry — smoke test only (the full retry/401
// matrix is already proven in meta_llm_nonstream.rs); one retry on one
// operation proves this operation wires into the shared retry loop
// correctly, reusing the same Idempotency-Key across the retry.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn responses_retries_502_reusing_the_same_idempotency_key() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/responses"))
        .respond_with(ResponseTemplate::new(502).set_body_json(json!({"error": "bad gateway"})))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/responses"))
        .respond_with(ResponseTemplate::new(200).set_body_json(responses_body()))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let result = client.responses(&responses_request()).await.unwrap();
    assert_eq!(result.data.id, "resp-1");

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 2, "expected exactly one retry after the 502");
    let key_1 = requests[0].headers.get("idempotency-key").unwrap();
    let key_2 = requests[1].headers.get("idempotency-key").unwrap();
    assert_eq!(
        key_1, key_2,
        "the idempotency key MUST be reused across a retry, not regenerated (ADR-0023 §D5)"
    );
}
