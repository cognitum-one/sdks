#![cfg(feature = "meta-proxy")]
//! `chat_completions_stream()` tests (ADR-0025a §D8, M3 continuation of
//! issue #61). Mirrors `meta_llm_chat_completions_stream.rs`'s (PR #88)
//! style and `meta_proxy_chat_completions.rs`'s (PR #93) fixtures. Scoped
//! per the task: a full successful stream (terminal event + receipt
//! decoded), the idle-stream-timeout race (real race, not a pre-check), the
//! required_plane mismatch check firing on a streaming terminal receipt,
//! no-retry-after-first-byte on a mid-stream disconnect, and
//! sponsored-stream-fails-locally.

use std::sync::Arc;

use cognitum_one::agentic::AgenticErrorKind;
use cognitum_one::meta_llm::types::openai::{
    ChatCompletionRequest, ChatMessage, ChatMessageContent, ChatRole,
};
use cognitum_one::meta_proxy::{
    LocalBearerTokenCredentialProvider, LocalBearerTokenCredentialProviderOptions,
    MetaProxyChatCallOptions, MetaProxyClient, MetaProxyClientConfig, ProxyTimeBudget,
    RoutingIntent, RoutingPlane, WorkloadPolicy,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn bearer_provider(origin: &str) -> Arc<LocalBearerTokenCredentialProvider> {
    Arc::new(
        LocalBearerTokenCredentialProvider::new(
            origin,
            origin,
            LocalBearerTokenCredentialProviderOptions {
                token: Some("mh1.canary-local-token".to_owned()),
                ..Default::default()
            },
        )
        .expect("provider should construct"),
    )
}

fn client_for(origin: &str) -> MetaProxyClient {
    let mut config = MetaProxyClientConfig::with_origin(origin);
    config.local_credential_provider = Some(bearer_provider(origin));
    MetaProxyClient::new(config).unwrap()
}

fn chat_request() -> ChatCompletionRequest {
    ChatCompletionRequest {
        model: "gpt-proxy".to_owned(),
        messages: vec![ChatMessage {
            role: ChatRole::User,
            content: Some(ChatMessageContent::Text("hello".to_owned())),
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

fn intent_requiring(plane: RoutingPlane) -> RoutingIntent {
    RoutingIntent {
        required_plane: Some(plane),
        workload_policy: WorkloadPolicy::Standard,
        ..RoutingIntent::default()
    }
}

fn routing_receipt_chunk(selected_plane: &str) -> String {
    format!(
        "data: {{\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}],\
         \"cognitum_routing_receipt\":{{\"request_id\":\"rr-1\",\"configured_plane\":\"local\",\
         \"selected_plane\":\"{selected_plane}\",\"routing_reason\":\"configured_default\",\
         \"automatic\":false,\"workload_policy\":\"standard\",\"degraded\":false}},\
         \"cognitum_upstream_receipt\":{{\"provider\":\"cognitum\",\"cost\":\"0.001\"}}}}\n\n"
    )
}

// ---------------------------------------------------------------------------
// Full successful stream — terminal event + receipt decoded
// ---------------------------------------------------------------------------

#[tokio::test]
async fn full_successful_stream_decodes_receipt_and_version_metadata() {
    let server = MockServer::start().await;
    let body = format!(
        "data: {{\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\"}},\"finish_reason\":null}}]}}\n\n\
         data: {{\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"Hello\"}},\"finish_reason\":null}}]}}\n\n\
         {}data: [DONE]\n\n",
        routing_receipt_chunk("local")
    );
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .insert_header("x-cognitum-product-version", "0.4.0")
                .insert_header("x-cognitum-protocol-version", "1.0")
                .set_body_raw(body.into_bytes(), "text/event-stream"),
        )
        .mount(&server)
        .await;

    let client = client_for(&server.uri());
    let mut stream = client
        .chat_completions_stream(&chat_request(), None, None, None)
        .await
        .unwrap();

    let mut last_proxy_meta = None;
    while let Some(envelope) = stream.next_envelope().await.unwrap() {
        last_proxy_meta = Some(envelope.proxy_meta);
    }

    let proxy_meta = last_proxy_meta.expect("at least one envelope");
    assert_eq!(proxy_meta.product_version.as_deref(), Some("0.4.0"));
    assert_eq!(proxy_meta.protocol_version.as_deref(), Some("1.0"));
    let receipt = proxy_meta.routing_receipt.expect("routing receipt present");
    assert_eq!(receipt.selected_plane, "local");
    assert!(proxy_meta.upstream_receipt.is_some());

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
}

#[tokio::test]
async fn request_body_sets_stream_true() {
    let server = MockServer::start().await;
    let body = format!("{}data: [DONE]\n\n", routing_receipt_chunk("local"));
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(body.into_bytes(), "text/event-stream"),
        )
        .mount(&server)
        .await;

    let client = client_for(&server.uri());
    let mut stream = client
        .chat_completions_stream(&chat_request(), None, None, None)
        .await
        .unwrap();
    while stream.next_envelope().await.unwrap().is_some() {}

    let requests = server.received_requests().await.unwrap();
    let sent: serde_json::Value = requests[0].body_json().unwrap();
    assert_eq!(sent.get("stream"), Some(&serde_json::Value::Bool(true)));
}

// ---------------------------------------------------------------------------
// §D5 rule 7 — required_plane mismatch on the streaming terminal receipt
// ---------------------------------------------------------------------------

#[tokio::test]
async fn required_plane_mismatch_on_streaming_terminal_receipt_is_a_protocol_violation() {
    let server = MockServer::start().await;
    let body = format!(
        "data: {{\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\"}},\"finish_reason\":null}}]}}\n\n\
         {}data: [DONE]\n\n",
        routing_receipt_chunk("cognitum_cloud")
    );
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(body.into_bytes(), "text/event-stream"),
        )
        .mount(&server)
        .await;

    let client = client_for(&server.uri());
    let options = MetaProxyChatCallOptions {
        routing_intent: Some(intent_requiring(RoutingPlane::Local)),
        ..Default::default()
    };
    let mut stream = client
        .chat_completions_stream(&chat_request(), Some(options), None, None)
        .await
        .unwrap();

    let mut terminal_error = None;
    loop {
        match stream.next_envelope().await {
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(err) => {
                terminal_error = Some(err);
                break;
            }
        }
    }
    let err = terminal_error.expect("required_plane mismatch must fail despite [DONE]");
    assert_eq!(err.kind, AgenticErrorKind::Protocol);
    assert!(!err.retryable);
}

#[tokio::test]
async fn required_plane_match_on_streaming_terminal_receipt_succeeds() {
    let server = MockServer::start().await;
    let body = format!("{}data: [DONE]\n\n", routing_receipt_chunk("local"));
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(body.into_bytes(), "text/event-stream"),
        )
        .mount(&server)
        .await;

    let client = client_for(&server.uri());
    let options = MetaProxyChatCallOptions {
        routing_intent: Some(intent_requiring(RoutingPlane::Local)),
        ..Default::default()
    };
    let mut stream = client
        .chat_completions_stream(&chat_request(), Some(options), None, None)
        .await
        .unwrap();

    let mut terminal_error = None;
    loop {
        match stream.next_envelope().await {
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(err) => {
                terminal_error = Some(err);
                break;
            }
        }
    }
    assert!(terminal_error.is_none(), "matching plane should succeed");
}

#[tokio::test]
async fn required_plane_with_no_receipt_ever_observed_is_a_protocol_violation() {
    let server = MockServer::start().await;
    let body = "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":\"stop\"}]}\n\n\
                data: [DONE]\n\n";
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(body.as_bytes().to_vec(), "text/event-stream"),
        )
        .mount(&server)
        .await;

    let client = client_for(&server.uri());
    let options = MetaProxyChatCallOptions {
        routing_intent: Some(intent_requiring(RoutingPlane::Local)),
        ..Default::default()
    };
    let mut stream = client
        .chat_completions_stream(&chat_request(), Some(options), None, None)
        .await
        .unwrap();

    let mut terminal_error = None;
    loop {
        match stream.next_envelope().await {
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(err) => {
                terminal_error = Some(err);
                break;
            }
        }
    }
    let err = terminal_error.expect("a required plane with no receipt cannot be verified");
    assert_eq!(err.kind, AgenticErrorKind::Protocol);
}

// ---------------------------------------------------------------------------
// No retry after first byte — mid-stream disconnect
// ---------------------------------------------------------------------------

#[tokio::test]
async fn no_retry_after_first_byte_on_mid_stream_disconnect() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let attempts_clone = attempts.clone();

    tokio::spawn(async move {
        if let Ok((mut socket, _)) = listener.accept().await {
            attempts_clone.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf).await;

            let event = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"one event then drop\"},\"finish_reason\":null}]}\n\n";
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n{:x}\r\n{}\r\n",
                event.len(),
                event
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.flush().await;
            drop(socket);
        }
    });

    let base_url = format!("http://{addr}");
    let client = client_for(&base_url);
    let mut stream = client
        .chat_completions_stream(&chat_request(), None, None, None)
        .await
        .unwrap();

    let mut terminal_error = None;
    loop {
        match stream.next_envelope().await {
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(err) => {
                terminal_error = Some(err);
                break;
            }
        }
    }

    let err = terminal_error.expect("expected a terminal transport error");
    assert_eq!(err.kind, AgenticErrorKind::Transport);
    assert_eq!(err.code.as_deref(), Some("stream_disconnected"));
    assert!(!err.retryable);
    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
}

// ---------------------------------------------------------------------------
// §D8 — no automatic POST retry on 429/502/503 (pre-byte)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_503_pre_byte_response_is_a_single_terminal_error_and_is_never_auto_retried() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(503)
                .set_body_json(serde_json::json!({"error": "warming up"}))
                .insert_header("retry-after", "7"),
        )
        .mount(&server)
        .await;
    let client = client_for(&server.uri());

    let result = client
        .chat_completions_stream(&chat_request(), None, None, None)
        .await;
    let err = match result {
        Ok(_) => panic!("a 503 must surface as an error before any stream is returned"),
        Err(err) => err,
    };
    assert_eq!(err.status, Some(503));
    assert_eq!(err.retry_after_ms, Some(7000));

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1, "no automatic retry on 503 (§D8)");
}

// ---------------------------------------------------------------------------
// Idle-stream-timeout race on a silently-hanging stream
// ---------------------------------------------------------------------------

#[tokio::test]
async fn idle_stream_timeout_races_the_blocking_read() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        if let Ok((mut socket, _)) = listener.accept().await {
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf).await;

            let event = "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n";
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n{:x}\r\n{}\r\n",
                event.len(),
                event
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.flush().await;
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            drop(socket);
        }
    });

    let base_url = format!("http://{addr}");
    let client = client_for(&base_url);
    let budget = ProxyTimeBudget {
        idle_stream_timeout_ms: Some(30),
        ..Default::default()
    };

    let mut stream = client
        .chat_completions_stream(&chat_request(), None, Some(budget), None)
        .await
        .unwrap();

    let mut terminal_error = None;
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            match stream.next_envelope().await {
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(err) => {
                    terminal_error = Some(err);
                    break;
                }
            }
        }
    })
    .await;
    assert!(
        outcome.is_ok(),
        "next_envelope() never resolved -- the idle timeout was not enforced against the blocking read"
    );

    let err = terminal_error.expect("expected an idle timeout error");
    assert_eq!(err.kind, AgenticErrorKind::DeadlineExceeded);
    assert_eq!(err.code.as_deref(), Some("idle_stream_timeout"));
    assert!(!err.retryable);
}

#[tokio::test]
async fn first_byte_timeout_races_the_blocking_read() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        if let Ok((mut socket, _)) = listener.accept().await {
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf).await;
            let response =
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n";
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.flush().await;
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            drop(socket);
        }
    });

    let base_url = format!("http://{addr}");
    let client = client_for(&base_url);
    let budget = ProxyTimeBudget {
        first_byte_timeout_ms: Some(30),
        ..Default::default()
    };

    let outcome = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        let mut stream = client
            .chat_completions_stream(&chat_request(), None, Some(budget), None)
            .await
            .expect("stream should open even though the server never answers");

        let mut terminal_error = None;
        loop {
            match stream.next_envelope().await {
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(err) => {
                    terminal_error = Some(err);
                    break;
                }
            }
        }
        terminal_error
    })
    .await;

    let terminal_error = outcome
        .expect("next_envelope() never resolved -- the first-byte timeout was not enforced")
        .expect("expected a first-byte timeout error");
    assert_eq!(terminal_error.kind, AgenticErrorKind::DeadlineExceeded);
    assert_eq!(terminal_error.code.as_deref(), Some("first_byte_timeout"));
    assert!(!terminal_error.retryable);
}

// ---------------------------------------------------------------------------
// Sponsored streaming fails locally
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sponsored_stream_fails_locally_before_any_http_io() {
    let server = MockServer::start().await;
    // No mock registered — any HTTP call would be an unexpected request.
    let client = client_for(&server.uri());

    let mut request = chat_request();
    request.stream = Some(true);
    let err = client
        .sponsored_chat_completions(&request)
        .await
        .expect_err("sponsored stream=true must fail locally");
    assert_eq!(err.kind, AgenticErrorKind::UnsupportedCapability);
    assert!(
        err.message.contains("sponsored-inference-streaming") || err.message.contains("streaming")
    );

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 0, "zero HTTP I/O for the fail-fast guard");
}

#[tokio::test]
async fn sponsored_nonstream_also_fails_locally() {
    let server = MockServer::start().await;
    let client = client_for(&server.uri());

    let err = client
        .sponsored_chat_completions(&chat_request())
        .await
        .expect_err("sponsored non-stream forwarding is not implemented this pass");
    assert_eq!(err.kind, AgenticErrorKind::UnsupportedCapability);

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 0);
}
