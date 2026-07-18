#![cfg(feature = "meta-llm")]
//! `chat_completions_stream()` tests (ADR-0024a §D5) -- issue #58 streaming
//! pass. Scoped per the task: a full successful stream, an early
//! termination with a typed terminal error (partial state preserved), and
//! confirmation that no retry occurs after the first response byte.

use std::sync::Arc;

use cognitum_one::agentic::{
    AgenticError, AgenticErrorKind, StaticApiKeyCredentialProvider,
    StaticApiKeyCredentialProviderOptions, TimeBudget,
};
use cognitum_one::meta_llm::stream::ChatCompletionsStreamAccumulator;
use cognitum_one::meta_llm::types::{
    ChatCompletionRequest, ChatMessage, ChatMessageContent, ChatRole,
};
use cognitum_one::meta_llm::{MetaLlmClient, MetaLlmClientConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use wiremock::matchers::{method, path};
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

// ---------------------------------------------------------------------------
// Full successful stream
// ---------------------------------------------------------------------------

#[tokio::test]
async fn full_successful_stream_ends_in_done() {
    let server = MockServer::start().await;
    let body = concat!(
        "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"m\",",
        "\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\" world\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],",
        "\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n",
        "data: [DONE]\n\n",
    );
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(body.as_bytes().to_vec(), "text/event-stream"),
        )
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let mut stream = client
        .chat_completions_stream(&chat_request(), None, None)
        .await
        .unwrap();

    let mut accumulator = ChatCompletionsStreamAccumulator::new();
    let mut sequences = Vec::new();
    while let Some(envelope) = stream.next_envelope().await.unwrap() {
        sequences.push(envelope.sequence);
        accumulator.absorb(&envelope);
    }

    let snapshot = accumulator.snapshot();
    assert_eq!(snapshot.role.as_deref(), Some("assistant"));
    assert_eq!(
        snapshot.content_by_choice.get(&0).map(String::as_str),
        Some("Hello world")
    );
    assert_eq!(
        snapshot.finish_reason_by_choice.get(&0).map(String::as_str),
        Some("stop")
    );
    let usage = snapshot.usage.expect("usage should be present");
    assert_eq!(usage.prompt_tokens, 3);
    assert_eq!(usage.completion_tokens, 2);
    assert_eq!(usage.total_tokens, 5);
    assert!(snapshot.completed);

    let mut sorted = sequences.clone();
    sorted.sort_unstable();
    assert_eq!(
        sequences, sorted,
        "sequence numbers must be strictly increasing"
    );
    let unique: std::collections::HashSet<_> = sequences.iter().collect();
    assert_eq!(
        unique.len(),
        sequences.len(),
        "sequence numbers must be unique"
    );

    let requests = server.received_requests().await.unwrap();
    assert_eq!(
        requests.len(),
        1,
        "exactly one HTTP attempt for a clean success"
    );
}

// ---------------------------------------------------------------------------
// Early termination without [DONE]/finish_reason -- partial state preserved
// ---------------------------------------------------------------------------

#[tokio::test]
async fn early_termination_preserves_partial_state_and_errors() {
    let server = MockServer::start().await;
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n",
    );
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(body.as_bytes().to_vec(), "text/event-stream"),
        )
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = MetaLlmClient::new(config).unwrap();

    let mut stream = client
        .chat_completions_stream(&chat_request(), None, None)
        .await
        .unwrap();

    let mut accumulator = ChatCompletionsStreamAccumulator::new();
    let mut terminal_error: Option<AgenticError> = None;
    loop {
        match stream.next_envelope().await {
            Ok(Some(envelope)) => accumulator.absorb(&envelope),
            Ok(None) => break,
            Err(err) => {
                terminal_error = Some(err);
                break;
            }
        }
    }

    let snapshot = accumulator.snapshot();
    assert_eq!(
        snapshot.content_by_choice.get(&0).map(String::as_str),
        Some("partial")
    );
    assert!(!snapshot.completed);

    let err = terminal_error.expect("expected a terminal error");
    assert_eq!(err.kind, AgenticErrorKind::Protocol);
    assert_eq!(
        err.code.as_deref(),
        Some("stream_ended_without_terminal_event")
    );
    assert!(!err.retryable);
    let details = err.details.expect("details should be present");
    assert_eq!(details.get("partial").and_then(|v| v.as_bool()), Some(true));
}

// ---------------------------------------------------------------------------
// No retry after first byte -- mid-stream disconnect (raw TCP, chunked
// transfer-encoding closed before its terminating chunk) surfaces as a
// transport error with exactly one HTTP attempt, never a retry.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn no_retry_after_first_byte_on_mid_stream_disconnect() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let attempts_clone = attempts.clone();

    tokio::spawn(async move {
        // Accept exactly one connection, prove no retry occurs by never
        // accepting a second one within the test's lifetime.
        if let Ok((mut socket, _)) = listener.accept().await {
            attempts_clone.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let mut buf = [0u8; 4096];
            // Drain the request (don't need to parse it).
            let _ = socket.read(&mut buf).await;

            let event = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"one event then drop\"},\"finish_reason\":null}]}\n\n";
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n{:x}\r\n{}\r\n",
                event.len(),
                event
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.flush().await;
            // Deliberately close WITHOUT the terminating `0\r\n\r\n` chunk --
            // an incomplete chunked body is a genuine transport-level error,
            // not a clean end-of-stream.
            drop(socket);
        }
    });

    let base_url = format!("http://{addr}");
    let mut config = insecure_config(&base_url);
    config.credential_provider = Some(credential_provider(&base_url));
    let client = MetaLlmClient::new(config).unwrap();

    let mut stream = client
        .chat_completions_stream(&chat_request(), None, None)
        .await
        .unwrap();

    let mut terminal_error: Option<AgenticError> = None;
    loop {
        match stream.next_envelope().await {
            Ok(Some(_envelope)) => {}
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
    assert_eq!(
        attempts.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "exactly one HTTP attempt -- no retry after the first response byte"
    );
}

// ---------------------------------------------------------------------------
// Idle timeout on a silently-hanging stream -- a server that accepts the
// connection, sends some bytes, then goes silent WITHOUT closing the socket
// must still be bounded by `idle_timeout_ms`. Raw TCP (like the disconnect
// test above) so the connection can be held open past the configured
// timeout without ever completing the response.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn idle_timeout_preserves_partial_state_and_errors() {
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
            // Go silent WITHOUT closing -- well past the test's 30ms idle
            // budget, but bounded so this task doesn't outlive the test
            // process if something goes wrong.
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            drop(socket);
        }
    });

    let base_url = format!("http://{addr}");
    let mut config = insecure_config(&base_url);
    config.credential_provider = Some(credential_provider(&base_url));
    let client = MetaLlmClient::new(config).unwrap();

    let time_budget = TimeBudget {
        idle_timeout_ms: Some(30),
        ..Default::default()
    };

    let mut stream = client
        .chat_completions_stream(&chat_request(), Some(time_budget), None)
        .await
        .unwrap();

    let mut accumulator = ChatCompletionsStreamAccumulator::new();
    let mut terminal_error: Option<AgenticError> = None;
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            match stream.next_envelope().await {
                Ok(Some(envelope)) => accumulator.absorb(&envelope),
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
    assert_eq!(err.code.as_deref(), Some("idle_timeout"));
    assert!(!err.retryable);
    let details = err.details.expect("details should be present");
    assert_eq!(details.get("partial").and_then(|v| v.as_bool()), Some(true));
}

// ---------------------------------------------------------------------------
// First-byte timeout on a silently-hanging stream -- a server that accepts
// the connection and never sends a single byte must be bounded by
// `first_byte_timeout_ms`.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn first_byte_timeout_errors_when_no_byte_ever_arrives() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        if let Ok((mut socket, _)) = listener.accept().await {
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf).await;
            // Send full HTTP response headers (so the pre-byte connect/send
            // phase completes normally and `chat_completions_stream()`
            // returns a live stream) but then never write a single body
            // chunk -- `first_byte_timeout_ms` governs the wait for the
            // first BODY byte, not the initial headers.
            let response =
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n";
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.flush().await;
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            drop(socket);
        }
    });

    let base_url = format!("http://{addr}");
    let mut config = insecure_config(&base_url);
    config.credential_provider = Some(credential_provider(&base_url));
    let client = MetaLlmClient::new(config).unwrap();

    let time_budget = TimeBudget {
        first_byte_timeout_ms: Some(30),
        ..Default::default()
    };

    // Headers arrive normally, so `chat_completions_stream()` itself
    // returns quickly -- the hang (and the fix under test) is entirely
    // inside `next_envelope()`'s wait for the first body byte. The outer
    // `tokio::time::timeout` is just a test-suite safety net: if the fix
    // regresses and this genuinely hangs, the test fails loudly instead of
    // stalling the whole suite.
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        let mut stream = client
            .chat_completions_stream(&chat_request(), Some(time_budget), None)
            .await
            .expect("stream should open even though the server never answers");

        let mut terminal_error: Option<AgenticError> = None;
        loop {
            match stream.next_envelope().await {
                Ok(Some(_envelope)) => {}
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
