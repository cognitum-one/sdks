#![cfg(feature = "meta-llm")]
//! ADR-0022 §D5 scope preflight, wired into `MetaLlmClient`'s shared
//! request-building path (`meta_llm::nonstream::require_credential` for
//! completion-family routes, `meta_llm::http::get_json` for
//! `whoami`/`models`/`usage`). "Before a billable or mutating call, a
//! provider with known granted scopes is checked locally. Missing scope
//! returns `PermissionDeniedError` before I/O." Every "blocked" case below
//! asserts the mock server received zero requests.

use async_trait::async_trait;
use cognitum_one::agentic::{
    AgenticError, AgenticErrorKind, Credential, CredentialAuthority, CredentialProvider,
    CredentialRequest, RedactedSecret,
};
use cognitum_one::meta_llm::types::{ChatCompletionRequest, ChatMessage, ChatMessageContent, ChatRole};
use cognitum_one::meta_llm::{MetaLlmClient, MetaLlmClientConfig};
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn insecure_config(base_url: impl Into<String>) -> MetaLlmClientConfig {
    let mut config = MetaLlmClientConfig::new(base_url);
    config.allow_insecure_http = true;
    config
}

fn chat_request() -> ChatCompletionRequest {
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
        routing_controls: None,
    }
}

fn chat_completion_body() -> serde_json::Value {
    json!({
        "id": "chatcmpl-1",
        "object": "chat.completion",
        "created": 1,
        "model": "meta-llm-large",
        "choices": [
            {"index": 0, "message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}
        ],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
    })
}

/// Minimal `CredentialProvider` returning a fixed `granted_scopes` (or
/// `None` for "unknown") on every `acquire()` call.
#[derive(Debug)]
struct ScopedCredentialProvider {
    granted_scopes: Option<Vec<String>>,
}

#[async_trait]
impl CredentialProvider for ScopedCredentialProvider {
    async fn describe_authority(
        &self,
        request: &CredentialRequest,
    ) -> Result<CredentialAuthority, AgenticError> {
        Ok(CredentialAuthority {
            provider_fingerprint: "scoped-test".to_owned(),
            product: request.product.clone(),
            normalized_origin: request.normalized_origin.clone(),
            audience: request.audience.clone(),
            principal: None,
            tenant: None,
            delegated_subtenant: None,
            effective_scopes: self.granted_scopes.clone(),
            plan: None,
        })
    }

    async fn acquire(&self, request: &CredentialRequest) -> Result<Credential, AgenticError> {
        Ok(Credential {
            scheme: "Bearer".to_owned(),
            secret: RedactedSecret::new("oauth-test-token"),
            expires_at: None,
            granted_scopes: self.granted_scopes.clone(),
            audience: request.audience.clone(),
            source: "scoped-test-provider".to_owned(),
            authority: CredentialAuthority {
                provider_fingerprint: "scoped-test".to_owned(),
                product: request.product.clone(),
                normalized_origin: request.normalized_origin.clone(),
                audience: request.audience.clone(),
                principal: None,
                tenant: None,
                delegated_subtenant: None,
                effective_scopes: self.granted_scopes.clone(),
                plan: None,
            },
        })
    }

    fn identity(&self) -> String {
        "scoped-test-provider".to_owned()
    }

    async fn invalidate(&self, _reason: &str) {}
}

#[tokio::test]
async fn blocks_chat_completions_before_http_when_scopes_known_insufficient() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(chat_completion_body()))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(std::sync::Arc::new(ScopedCredentialProvider {
        granted_scopes: Some(vec!["some-other-scope".to_owned()]),
    }));
    let client = MetaLlmClient::new(config).unwrap();

    let err = client.chat_completions(&chat_request()).await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::PermissionDenied);
    assert_eq!(server.received_requests().await.unwrap().len(), 0);
}

#[tokio::test]
async fn allows_chat_completions_through_when_scopes_unknown() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(chat_completion_body()))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(std::sync::Arc::new(ScopedCredentialProvider {
        granted_scopes: None,
    }));
    let client = MetaLlmClient::new(config).unwrap();

    let result = client.chat_completions(&chat_request()).await.unwrap();
    assert_eq!(result.data.id, "chatcmpl-1");
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn allows_chat_completions_through_when_scopes_known_sufficient() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(chat_completion_body()))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(std::sync::Arc::new(ScopedCredentialProvider {
        granted_scopes: Some(vec!["meta-llm.inference".to_owned()]),
    }));
    let client = MetaLlmClient::new(config).unwrap();

    let result = client.chat_completions(&chat_request()).await.unwrap();
    assert_eq!(result.data.id, "chatcmpl-1");
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn blocks_whoami_before_http_when_scopes_known_insufficient() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/whoami"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"account_id": "acct_1"})))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(std::sync::Arc::new(ScopedCredentialProvider {
        granted_scopes: Some(vec!["meta-llm.inference".to_owned()]),
    }));
    let client = MetaLlmClient::new(config).unwrap();

    let err = client.whoami().await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::PermissionDenied);
    assert_eq!(server.received_requests().await.unwrap().len(), 0);
}

#[tokio::test]
async fn allows_whoami_through_when_scopes_unknown() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/whoami"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"account_id": "acct_1"})))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(std::sync::Arc::new(ScopedCredentialProvider {
        granted_scopes: None,
    }));
    let client = MetaLlmClient::new(config).unwrap();

    let result = client.whoami().await.unwrap();
    assert_eq!(result.data.account_id.as_deref(), Some("acct_1"));
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}
