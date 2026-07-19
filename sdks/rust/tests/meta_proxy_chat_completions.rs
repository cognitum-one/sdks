#![cfg(feature = "meta-proxy")]

//! ADR-0025a §D5-§D7 integration tests: routing-intent verification, the §D7
//! forwarding header allowlist, transport hardening (proxy-env ignored,
//! redirects rejected), and the local bearer credential provider.

use std::collections::HashMap;
use std::sync::Arc;

use cognitum_one::agentic::AgenticErrorKind;
use cognitum_one::meta_llm::types::openai::{
    ChatCompletionRequest, ChatMessage, ChatMessageContent, ChatRole,
};
use cognitum_one::meta_proxy::{
    LocalBearerTokenCredentialProvider, LocalBearerTokenCredentialProviderOptions, MetaProxyChatCallOptions,
    MetaProxyClient, MetaProxyClientConfig, RoutingIntent, RoutingPlane, WorkloadPolicy,
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

fn chat_response_body() -> serde_json::Value {
    json!({
        "id": "chatcmpl-1",
        "object": "chat.completion",
        "created": 1,
        "model": "cognitum-small",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "hello"},
            "finish_reason": "stop"
        }]
    })
}

fn chat_response_with_receipt(selected_plane: &str) -> serde_json::Value {
    let mut body = chat_response_body();
    body["cognitum_routing_receipt"] = json!({
        "request_id": "rr_1",
        "configured_plane": "local",
        "selected_plane": selected_plane,
        "automatic": false,
        "workload_policy": "standard"
    });
    body["cognitum_upstream_receipt"] = json!({"provider": "cognitum", "cost": "0"});
    body
}

fn intent_requiring(plane: RoutingPlane) -> RoutingIntent {
    RoutingIntent {
        required_plane: Some(plane),
        workload_policy: WorkloadPolicy::Standard,
        ..RoutingIntent::default()
    }
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

// ---------------------------------------------------------------------------
// §D5 rule 7 — required_plane verification (CRITICAL)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn required_plane_mismatch_is_a_protocol_violation_even_on_200() {
    let server = MockServer::start().await;
    // A perfectly valid 200 body — but the receipt says the request went to a
    // DIFFERENT plane than the caller required.
    mount_chat_ok(&server, chat_response_with_receipt("cognitum_cloud")).await;
    let client = client_for(&server);

    let options = MetaProxyChatCallOptions {
        routing_intent: Some(intent_requiring(RoutingPlane::Local)),
        ..Default::default()
    };
    let err = client
        .chat_completions(&chat_request(), Some(options))
        .await
        .expect_err("required_plane mismatch must fail despite the 200");
    assert_eq!(err.kind, AgenticErrorKind::Protocol);
    assert!(!err.retryable, "a plane mismatch is never retryable (§D5 rule 2)");
}

#[tokio::test]
async fn required_plane_match_succeeds() {
    let server = MockServer::start().await;
    mount_chat_ok(&server, chat_response_with_receipt("local")).await;
    let client = client_for(&server);

    let options = MetaProxyChatCallOptions {
        routing_intent: Some(intent_requiring(RoutingPlane::Local)),
        ..Default::default()
    };
    let result = client
        .chat_completions(&chat_request(), Some(options))
        .await
        .expect("matching plane should succeed");
    assert_eq!(result.data.id, "chatcmpl-1");
    assert_eq!(
        result.meta.routing_receipt.as_ref().unwrap().selected_plane,
        "local"
    );
}

#[tokio::test]
async fn required_plane_with_no_receipt_is_a_protocol_violation() {
    let server = MockServer::start().await;
    // 200, well-formed, but NO routing receipt to verify the plane against.
    mount_chat_ok(&server, chat_response_body()).await;
    let client = client_for(&server);

    let options = MetaProxyChatCallOptions {
        routing_intent: Some(intent_requiring(RoutingPlane::Local)),
        ..Default::default()
    };
    let err = client
        .chat_completions(&chat_request(), Some(options))
        .await
        .expect_err("a required plane with no receipt cannot be verified");
    assert_eq!(err.kind, AgenticErrorKind::Protocol);
}

#[tokio::test]
async fn no_routing_intent_accepts_any_plane() {
    let server = MockServer::start().await;
    mount_chat_ok(&server, chat_response_with_receipt("cognitum_cloud")).await;
    let client = client_for(&server);

    // No intent at all — whatever plane the Proxy chose is accepted.
    let result = client
        .chat_completions(&chat_request(), None)
        .await
        .expect("no intent accepts any plane");
    assert_eq!(result.data.id, "chatcmpl-1");
}

// ---------------------------------------------------------------------------
// §D7 — forwarding header allowlist (CRITICAL)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn forbidden_headers_are_never_forwarded_and_allowlisted_ones_are() {
    let server = MockServer::start().await;
    mount_chat_ok(&server, chat_response_body()).await;
    let client = client_for(&server);

    let mut bag = HashMap::new();
    // Forbidden — must be dropped, never reach the server:
    bag.insert("Authorization".to_owned(), "Bearer EVIL-OVERRIDE".to_owned());
    bag.insert("Host".to_owned(), "evil.example.com".to_owned());
    bag.insert("Content-Length".to_owned(), "999999".to_owned());
    bag.insert("X-Cognitum-Sponsor".to_owned(), "attacker".to_owned());
    // Allowlisted — must be forwarded verbatim:
    bag.insert("traceparent".to_owned(), "tp-1".to_owned());
    bag.insert("X-Cognitum-Min-Tier".to_owned(), "small".to_owned());
    bag.insert("anthropic-version".to_owned(), "2023-06-01".to_owned());

    let options = MetaProxyChatCallOptions {
        forward_headers: Some(bag),
        ..Default::default()
    };
    client
        .chat_completions(&chat_request(), Some(options))
        .await
        .expect("call should succeed");

    let requests = server
        .received_requests()
        .await
        .expect("mock server records requests");
    assert_eq!(requests.len(), 1);
    let headers = &requests[0].headers;

    // The bearer is the one from validated local state, NOT the caller's
    // forged Authorization header.
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    assert_eq!(auth, format!("Bearer {CANARY_BEARER}"));
    assert!(
        !auth.contains("EVIL-OVERRIDE"),
        "caller Authorization must never be forwarded"
    );

    // Forbidden markers never made it onto the wire.
    assert!(headers.get("x-cognitum-sponsor").is_none());
    // Host is the real server's host, not the forged one.
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    assert!(!host.contains("evil.example.com"));

    // Allowlisted headers were forwarded verbatim.
    assert_eq!(
        headers.get("traceparent").and_then(|v| v.to_str().ok()),
        Some("tp-1")
    );
    assert_eq!(
        headers.get("x-cognitum-min-tier").and_then(|v| v.to_str().ok()),
        Some("small")
    );
    assert_eq!(
        headers.get("anthropic-version").and_then(|v| v.to_str().ok()),
        Some("2023-06-01")
    );
}

#[tokio::test]
async fn allowlisted_headers_forwarded_without_forbidden_ones() {
    let server = MockServer::start().await;
    mount_chat_ok(&server, chat_response_body()).await;
    let client = client_for(&server);

    let mut bag = HashMap::new();
    bag.insert("tracestate".to_owned(), "vendor=abc".to_owned());
    bag.insert("X-Cognitum-Cache".to_owned(), "bypass".to_owned());
    bag.insert("X-Cognitum-Safety".to_owned(), "strict".to_owned());

    let options = MetaProxyChatCallOptions {
        forward_headers: Some(bag),
        ..Default::default()
    };
    client
        .chat_completions(&chat_request(), Some(options))
        .await
        .expect("call should succeed");

    let requests = server.received_requests().await.unwrap();
    let headers = &requests[0].headers;
    assert_eq!(
        headers.get("tracestate").and_then(|v| v.to_str().ok()),
        Some("vendor=abc")
    );
    assert_eq!(
        headers.get("x-cognitum-cache").and_then(|v| v.to_str().ok()),
        Some("bypass")
    );
    assert_eq!(
        headers.get("x-cognitum-safety").and_then(|v| v.to_str().ok()),
        Some("strict")
    );
}

// ---------------------------------------------------------------------------
// §D7 — response decoding + fail-closed auth
// ---------------------------------------------------------------------------

#[tokio::test]
async fn response_meta_preserves_routing_and_upstream_receipts() {
    let server = MockServer::start().await;
    mount_chat_ok(&server, chat_response_with_receipt("local")).await;
    let client = client_for(&server);

    let result = client
        .chat_completions(&chat_request(), None)
        .await
        .expect("call should succeed");
    let receipt = result.meta.routing_receipt.expect("routing receipt present");
    assert_eq!(receipt.selected_plane, "local");
    assert_eq!(receipt.configured_plane, "local");
    assert!(result.meta.upstream_receipt.is_some());
}

#[tokio::test]
async fn chat_completions_fails_closed_without_a_local_credential_provider() {
    let server = MockServer::start().await;
    // No mock registered: any HTTP call would be an unexpected request.
    let config = MetaProxyClientConfig::with_origin(server.uri());
    let client = MetaProxyClient::new(config).unwrap();

    let err = client
        .chat_completions(&chat_request(), None)
        .await
        .expect_err("must fail closed before any HTTP call");
    assert_eq!(err.kind, AgenticErrorKind::Authentication);
}

// ---------------------------------------------------------------------------
// §D6/§D10 — transport hardening
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ambient_http_proxy_env_is_ignored() {
    let server = MockServer::start().await;
    mount_chat_ok(&server, chat_response_body()).await;

    // Point the ambient proxy vars at a port nothing is listening on. If the
    // transport honored them it would try to CONNECT through the dead proxy
    // and the request would fail; reaching the mock server proves they were
    // ignored (ADR-0025a §D6/§D10). All clients in this test file use the
    // hardened `.no_proxy()` transport, so this env mutation cannot leak into
    // another test's behavior.
    std::env::set_var("HTTP_PROXY", "http://127.0.0.1:9");
    std::env::set_var("http_proxy", "http://127.0.0.1:9");
    std::env::set_var("HTTPS_PROXY", "http://127.0.0.1:9");
    std::env::set_var("ALL_PROXY", "http://127.0.0.1:9");

    let client = client_for(&server);
    let result = client.chat_completions(&chat_request(), None).await;

    std::env::remove_var("HTTP_PROXY");
    std::env::remove_var("http_proxy");
    std::env::remove_var("HTTPS_PROXY");
    std::env::remove_var("ALL_PROXY");

    assert!(
        result.is_ok(),
        "request must reach the mock server directly, ignoring the bogus proxy: {result:?}"
    );
}

#[tokio::test]
async fn redirects_are_not_followed() {
    let server = MockServer::start().await;
    // The redirect target — must NEVER be hit.
    Mock::given(method("POST"))
        .and(path("/redirected"))
        .respond_with(ResponseTemplate::new(200).set_body_json(chat_response_body()))
        .expect(0)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(302)
                .insert_header("location", format!("{}/redirected", server.uri())),
        )
        .mount(&server)
        .await;
    let client = client_for(&server);

    let err = client
        .chat_completions(&chat_request(), None)
        .await
        .expect_err("a 3xx must surface as an error, not be followed");
    // 302 is not a success and is not in the mapped table -> Protocol.
    assert_eq!(err.status, Some(302));
    // `.expect(0)` on the /redirected mock is verified on server drop.
}

// ---------------------------------------------------------------------------
// §D6 — LocalBearerTokenCredentialProvider + non-loopback guard
// ---------------------------------------------------------------------------

#[test]
fn bearer_provider_fails_closed_without_a_token() {
    let result = LocalBearerTokenCredentialProvider::new(
        "http://127.0.0.1:11435",
        "http://127.0.0.1:11435",
        LocalBearerTokenCredentialProviderOptions {
            env: Some(HashMap::new()),
            ..Default::default()
        },
    );
    let err = result.expect_err("no token available -> construction fails closed");
    assert_eq!(err.kind, AgenticErrorKind::Configuration);
}

#[test]
fn bearer_provider_resolves_token_from_env_var() {
    let mut env = HashMap::new();
    env.insert(
        cognitum_one::meta_proxy::DEFAULT_META_PROXY_TOKEN_ENV_VAR.to_owned(),
        "mh1.from-env".to_owned(),
    );
    let provider = LocalBearerTokenCredentialProvider::new(
        "http://127.0.0.1:11435",
        "http://127.0.0.1:11435",
        LocalBearerTokenCredentialProviderOptions {
            env: Some(env),
            ..Default::default()
        },
    );
    assert!(provider.is_ok());
}

#[tokio::test]
async fn a_non_loopback_origin_construction_fails_so_no_bearer_can_leave() {
    // The bearer can never be attached to a non-loopback origin because the
    // client cannot even be constructed for one in default-safe mode — the
    // request (and its bearer) never exists (ADR-0025a §D6/§D10).
    let mut config = MetaProxyClientConfig::with_origin("http://example.com:11435");
    config.local_credential_provider = Some(bearer_provider("http://example.com:11435"));
    let err = MetaProxyClient::new(config).expect_err("non-loopback must be rejected");
    assert_eq!(err.kind, AgenticErrorKind::Configuration);

    // With the explicit dangerous-preview opt-in, it constructs.
    let mut config = MetaProxyClientConfig::with_origin("http://example.com:11435");
    config.allow_non_loopback = true;
    config.local_credential_provider = Some(bearer_provider("http://example.com:11435"));
    assert!(MetaProxyClient::new(config).is_ok());
}

// ---------------------------------------------------------------------------
// §D8 — no automatic POST retry on 429/502/503 (duplicate-spend risk)
// ---------------------------------------------------------------------------
//
// ADR-0025a §D8: "No Proxy POST is automatically retried while it drops
// `Idempotency-Key`" -- the currently-deployed Proxy drops the header
// server-side, so the SDK attaching one does not make a silent retry safe.
// The Alternatives-considered table rejects "Retry Proxy POSTs" outright.
// A 429/502/503 must therefore surface as a single terminal,
// non-retryable-by-the-SDK error after exactly one HTTP attempt, carrying
// whatever `retry_after` hint the response supplied so the CALLER can decide
// to retry manually.

#[tokio::test]
async fn a_503_is_a_single_terminal_error_and_is_never_auto_retried() {
    let server = MockServer::start().await;
    // Only ONE mock response is registered (default `.expect(1)` behavior of
    // wiremock when no explicit count is given would still allow more calls,
    // so assert the exact received-request count below instead of relying on
    // mock exhaustion).
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(503)
                .set_body_json(json!({"error": "warming up"}))
                .insert_header("retry-after", "7"),
        )
        .mount(&server)
        .await;
    let client = client_for(&server);

    let err = client
        .chat_completions(&chat_request(), None)
        .await
        .expect_err("a 503 must surface as an error, not be silently retried into a 200");
    assert_eq!(err.status, Some(503));
    assert_eq!(
        err.retry_after_ms,
        Some(7000),
        "the Retry-After hint must be preserved for the caller to retry manually"
    );

    let requests = server
        .received_requests()
        .await
        .expect("mock server records requests");
    assert_eq!(
        requests.len(),
        1,
        "the SDK must make exactly ONE HTTP attempt for a Proxy POST — no automatic retry (§D8)"
    );
}

#[tokio::test]
async fn a_429_is_a_single_terminal_error_and_is_never_auto_retried() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(429)
                .set_body_json(json!({"error": "rate limited"}))
                .insert_header("retry-after", "2"),
        )
        .mount(&server)
        .await;
    let client = client_for(&server);

    let err = client
        .chat_completions(&chat_request(), None)
        .await
        .expect_err("a 429 must surface as an error, not be silently retried");
    assert_eq!(err.status, Some(429));
    assert_eq!(err.retry_after_ms, Some(2000));

    let requests = server
        .received_requests()
        .await
        .expect("mock server records requests");
    assert_eq!(requests.len(), 1, "no automatic retry on 429 (§D8)");
}

#[tokio::test]
async fn a_502_is_a_single_terminal_error_and_is_never_auto_retried() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(502).set_body_json(json!({"error": "bad gateway"})))
        .mount(&server)
        .await;
    let client = client_for(&server);

    let err = client
        .chat_completions(&chat_request(), None)
        .await
        .expect_err("a 502 must surface as an error, not be silently retried");
    assert_eq!(err.status, Some(502));

    let requests = server
        .received_requests()
        .await
        .expect("mock server records requests");
    assert_eq!(requests.len(), 1, "no automatic retry on 502 (§D8)");
}
