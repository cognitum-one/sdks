#![cfg(feature = "meta-llm")]
//! Real HTTP call logic for the two "direct nonstream call[s] whose
//! accepted contract declares safe replay" landed in issue #58 / M2's
//! continuation pass: `chat_completions` (OpenAI-style) and
//! `messages_create` (Anthropic-style). Split from `meta_llm_client.rs`
//! (already near the 500-line project cap) per ADR-0024a §D6 (error
//! mapping) and §D7 (idempotency and retry).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use async_trait::async_trait;
use cognitum_one::agentic::static_api_key_provider::{
    StaticApiKeyCredentialProvider, StaticApiKeyCredentialProviderOptions,
};
use cognitum_one::agentic::{
    AgenticError, AgenticErrorKind, Credential, CredentialAuthority, CredentialProvider,
    CredentialRequest, RedactedSecret,
};
use cognitum_one::meta_llm::types::{AnthropicMessageParam, AnthropicMessageRequest, ChatCompletionRequest, ChatMessage};
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

fn chat_request() -> ChatCompletionRequest {
    ChatCompletionRequest {
        model: "meta-llm-large".into(),
        messages: vec![ChatMessage {
            role: cognitum_one::meta_llm::types::ChatRole::User,
            content: Some(cognitum_one::meta_llm::types::ChatMessageContent::Text(
                "hello".into(),
            )),
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

fn messages_request() -> AnthropicMessageRequest {
    AnthropicMessageRequest {
        model: "meta-llm-large".into(),
        messages: vec![AnthropicMessageParam {
            role: cognitum_one::meta_llm::types::AnthropicRole::User,
            content: cognitum_one::meta_llm::types::AnthropicMessageContent::Text("hello".into()),
        }],
        max_tokens: 16,
        system: None,
        temperature: None,
        top_p: None,
        top_k: None,
        stop_sequences: None,
        stream: None,
        tools: None,
        tool_choice: None,
        metadata: None,
        routing_controls: None,
    }
}

/// Credential provider that returns a fresh secret each `acquire()` call,
/// so the 401-refresh-once tests can distinguish "first credential" from
/// "refreshed credential" — unlike `StaticApiKeyCredentialProvider`, whose
/// `invalidate()` makes every subsequent `acquire()` fail permanently.
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

/// Minimal RFC3339 UTC formatter for test fixtures, mirroring
/// `OAuthTokenCredentialProvider`'s internal (unexported)
/// `system_time_to_rfc3339` closely enough for `Credential::expires_at` --
/// this integration test only sees the crate's public API, so it cannot
/// reuse that private helper directly.
fn system_time_to_rfc3339(t: SystemTime) -> String {
    let unix_seconds = t
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = unix_seconds.div_euclid(86_400);
    let secs_of_day = unix_seconds.rem_euclid(86_400);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Models an `OAuthTokenCredentialProvider`-style source (PR #99): each
/// `acquire()` call returns a token carrying a real `expires_at`, with the
/// *first* token deliberately set to expire within the bounded-retry delay
/// window (issue #100's race).
///
/// Unlike `RefreshingCredentialProvider`, `invalidate()` here is never
/// expected to be called by a correct fix -- the whole point of the
/// proactive-expiry check is to refresh the credential BEFORE a 401 ever
/// happens, not in response to one.
#[derive(Debug, Default)]
struct ExpiringOAuthCredentialProvider {
    acquire_calls: AtomicUsize,
    invalidate_calls: AtomicUsize,
}

#[async_trait]
impl CredentialProvider for ExpiringOAuthCredentialProvider {
    async fn describe_authority(
        &self,
        request: &CredentialRequest,
    ) -> Result<CredentialAuthority, AgenticError> {
        Ok(CredentialAuthority {
            provider_fingerprint: "expiring-oauth".to_owned(),
            product: request.product.clone(),
            normalized_origin: request.normalized_origin.clone(),
            audience: request.audience.clone(),
            principal: Some("acct_oauth".to_owned()),
            tenant: None,
            delegated_subtenant: None,
            effective_scopes: None,
            plan: None,
        })
    }

    async fn acquire(&self, request: &CredentialRequest) -> Result<Credential, AgenticError> {
        let n = self.acquire_calls.fetch_add(1, Ordering::SeqCst);
        let is_first = n == 0;
        let secret = if is_first {
            "oauth-v1-soon-expired"
        } else {
            "oauth-v2-refreshed"
        };
        // The first token is already stale enough that, by the time the
        // bounded-retry delay (>= 500ms base) elapses, `SystemTime::now()`
        // at the retry check will have passed it -- reproducing the real
        // race from issue #100 without needing a mocked clock. The
        // refreshed token is far in the future so a second race iteration
        // can't accidentally trigger.
        let expires_at = if is_first {
            SystemTime::now() + Duration::from_millis(50)
        } else {
            SystemTime::now() + Duration::from_secs(3600)
        };
        Ok(Credential {
            scheme: "Bearer".to_owned(),
            secret: RedactedSecret::new(secret),
            expires_at: Some(system_time_to_rfc3339(expires_at)),
            granted_scopes: None,
            audience: request.audience.clone(),
            source: "expiring-oauth".to_owned(),
            authority: CredentialAuthority {
                provider_fingerprint: "expiring-oauth".to_owned(),
                product: request.product.clone(),
                normalized_origin: request.normalized_origin.clone(),
                audience: request.audience.clone(),
                principal: Some("acct_oauth".to_owned()),
                tenant: None,
                delegated_subtenant: None,
                effective_scopes: None,
                plan: None,
            },
        })
    }

    fn identity(&self) -> String {
        "expiring-oauth-credential-provider".to_owned()
    }

    async fn invalidate(&self, _reason: &str) {
        self.invalidate_calls.fetch_add(1, Ordering::SeqCst);
    }
}

fn chat_completion_body() -> serde_json::Value {
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
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
    })
}

fn anthropic_message_body() -> serde_json::Value {
    json!({
        "id": "msg-1",
        "type": "message",
        "role": "assistant",
        "content": [{"type": "text", "text": "hi there"}],
        "model": "meta-llm-large",
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 1, "output_tokens": 1}
    })
}

// ---------------------------------------------------------------------------
// Success paths
// ---------------------------------------------------------------------------

#[tokio::test]
async fn chat_completions_success_sends_idempotency_key() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(chat_completion_body()))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let result = client.chat_completions(&chat_request()).await.unwrap();
    assert_eq!(result.data.id, "chatcmpl-1");
    assert_eq!(result.meta.http_status, 200);

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].headers.contains_key("idempotency-key"));
}

#[tokio::test]
async fn messages_create_success_sends_idempotency_key() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(anthropic_message_body()))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let result = client.messages_create(&messages_request()).await.unwrap();
    assert_eq!(result.data.id, "msg-1");
    assert_eq!(result.meta.http_status, 200);

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].headers.contains_key("idempotency-key"));
}

// ---------------------------------------------------------------------------
// D6 error mapping — newly added statuses (400/409/402/422)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn chat_completions_maps_400_to_non_retryable_validation() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({"error": "bad request"})))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let err = client.chat_completions(&chat_request()).await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Validation);
    assert!(!err.retryable);
    assert_eq!(err.status, Some(400));
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn chat_completions_maps_409_to_non_retryable_conflict() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(409).set_body_json(json!({"error": "idempotency_mismatch"})),
        )
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let err = client.chat_completions(&chat_request()).await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Conflict);
    assert!(!err.retryable);
    assert_eq!(err.status, Some(409));
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn messages_create_maps_402_to_non_retryable_budget_exceeded() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(
            ResponseTemplate::new(402).set_body_json(json!({"error": "budget exceeded"})),
        )
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let err = client.messages_create(&messages_request()).await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::BudgetExceeded);
    assert!(!err.retryable);
    assert_eq!(err.status, Some(402));
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn messages_create_maps_422_to_non_retryable_safety_blocked() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(
            ResponseTemplate::new(422).set_body_json(json!({"error": "safety_blocked"})),
        )
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let err = client.messages_create(&messages_request()).await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::SafetyBlocked);
    assert!(!err.retryable);
    assert_eq!(err.status, Some(422));
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}

// ---------------------------------------------------------------------------
// D7 idempotency + bounded 502/503/429 retry
// ---------------------------------------------------------------------------

#[tokio::test]
async fn chat_completions_retries_502_reusing_the_same_idempotency_key() {
    let server = MockServer::start().await;
    // First mounted + matches first: fails once, then stops matching.
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(502).set_body_json(json!({"error": "bad gateway"})))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    // Falls through to this once the first mock is exhausted.
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(chat_completion_body()))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let result = client.chat_completions(&chat_request()).await.unwrap();
    assert_eq!(result.data.id, "chatcmpl-1");

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 2, "expected exactly one retry after the 502");
    let key_1 = requests[0].headers.get("idempotency-key").unwrap();
    let key_2 = requests[1].headers.get("idempotency-key").unwrap();
    assert_eq!(
        key_1, key_2,
        "the idempotency key MUST be reused across a retry, not regenerated (ADR-0023 §D5)"
    );
}

#[tokio::test]
async fn messages_create_retries_503_reusing_the_same_idempotency_key() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(503).set_body_json(json!({"error": "unavailable"})))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(anthropic_message_body()))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let result = client.messages_create(&messages_request()).await.unwrap();
    assert_eq!(result.data.id, "msg-1");

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0].headers.get("idempotency-key").unwrap(),
        requests[1].headers.get("idempotency-key").unwrap()
    );
}

/// Issue #100: an OAuth credential (real `expires_at`, unlike a static API
/// key) that expires during the retry-delay window must be proactively
/// re-acquired before the retry is sent, not resent stale and left to fail
/// with a 401 on the retry attempt.
#[tokio::test]
async fn chat_completions_proactively_reacquires_credential_expiring_during_429_delay() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(header("Authorization", "Bearer oauth-v1-soon-expired"))
        .respond_with(
            ResponseTemplate::new(429)
                .set_body_json(json!({"error": "rate limited"}))
                .insert_header("retry-after", "0"),
        )
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(header("Authorization", "Bearer oauth-v2-refreshed"))
        .respond_with(ResponseTemplate::new(200).set_body_json(chat_completion_body()))
        .mount(&server)
        .await;

    let provider = Arc::new(ExpiringOAuthCredentialProvider::default());
    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(provider.clone());
    let client = MetaLlmClient::new(config).unwrap();

    let result = client.chat_completions(&chat_request()).await.unwrap();
    assert_eq!(result.data.id, "chatcmpl-1");

    // The retry-delay wait (>= 500ms base per `RetryPolicy::default()`) is
    // a real `tokio::time::sleep` here, not a mocked one -- it is what
    // lets the first token's 50ms expiry lapse, reproducing the actual
    // race. `acquire()` must be called a second time BEFORE the retry
    // request goes out...
    assert_eq!(provider.acquire_calls.load(Ordering::SeqCst), 2);
    // ...and that second acquisition must happen via the proactive-expiry
    // path, never via the 401-challenge refresh path (there is no 401 in
    // this test at all -- the `Mock`s above would simply not match if a
    // stale/unexpected bearer token were sent on the retry).
    assert_eq!(provider.invalidate_calls.load(Ordering::SeqCst), 0);

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 2, "expected exactly one retry after the 429");
}

// ---------------------------------------------------------------------------
// D6 401: at most one refresh after a verified challenge
// ---------------------------------------------------------------------------

#[tokio::test]
async fn chat_completions_refreshes_credential_once_after_401_then_succeeds() {
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
        .respond_with(ResponseTemplate::new(200).set_body_json(chat_completion_body()))
        .mount(&server)
        .await;

    let provider = Arc::new(RefreshingCredentialProvider::default());
    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(provider.clone());
    let client = MetaLlmClient::new(config).unwrap();

    let result = client.chat_completions(&chat_request()).await.unwrap();
    assert_eq!(result.data.id, "chatcmpl-1");

    assert_eq!(provider.acquire_calls.load(Ordering::SeqCst), 2);
    assert_eq!(provider.invalidate_calls.load(Ordering::SeqCst), 1);
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 2, "expected exactly one retry after the 401");
}

#[tokio::test]
async fn chat_completions_does_not_retry_a_second_401() {
    let server = MockServer::start().await;
    // Both credentials get 401'd — proves the client does not loop forever
    // or retry more than once (ADR-0024a §D6: "at most one refresh").
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error": "expired"})))
        .mount(&server)
        .await;

    let provider = Arc::new(RefreshingCredentialProvider::default());
    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(provider.clone());
    let client = MetaLlmClient::new(config).unwrap();

    let err = client.chat_completions(&chat_request()).await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Authentication);

    assert_eq!(provider.acquire_calls.load(Ordering::SeqCst), 2);
    assert_eq!(provider.invalidate_calls.load(Ordering::SeqCst), 1);
    let requests = server.received_requests().await.unwrap();
    assert_eq!(
        requests.len(),
        2,
        "exactly 2 total HTTP attempts — the original plus one refresh retry, no more"
    );
}
