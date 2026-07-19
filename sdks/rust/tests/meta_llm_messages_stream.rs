#![cfg(feature = "meta-llm")]
//! `messages_create_stream()` tests (ADR-0024a §D5) -- issue #58 M2
//! continuation, item 2 of the tracked "what's left" list. Mirrors
//! `meta_llm_chat_completions_stream.rs`'s scope and helpers exactly,
//! substituting the Anthropic Messages wire protocol: `message_start`
//! through `message_stop` (the wire terminal condition -- there is no
//! `[DONE]` sentinel), `ping` decoding to a real event (not `Unknown`),
//! malformed-JSON tolerance, early termination without `message_stop`, no
//! retry after the first byte, an idle-timeout budget case, and
//! confirmation that no `Idempotency-Key` header is ever sent.

use std::sync::Arc;

use cognitum_one::agentic::{
    AgenticError, AgenticErrorKind, StaticApiKeyCredentialProvider,
    StaticApiKeyCredentialProviderOptions, TimeBudget,
};
use cognitum_one::meta_llm::stream::AnthropicStreamEvent;
use cognitum_one::meta_llm::types::{AnthropicMessageParam, AnthropicMessageRequest, AnthropicRole};
use cognitum_one::meta_llm::types::AnthropicMessageContent;
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

fn message_request() -> AnthropicMessageRequest {
    AnthropicMessageRequest {
        model: "meta-llm-large".into(),
        messages: vec![AnthropicMessageParam {
            role: AnthropicRole::User,
            content: AnthropicMessageContent::Text("hello".into()),
        }],
        max_tokens: 256,
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

// ---------------------------------------------------------------------------
// Full successful stream
// ---------------------------------------------------------------------------

#[tokio::test]
async fn full_successful_stream_ends_in_message_stop() {
    let server = MockServer::start().await;
    let body = concat!(
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"m\",\"stop_reason\":null,\"usage\":{\"input_tokens\":10,\"output_tokens\":0}}}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" world\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    );
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
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
        .messages_create_stream(&message_request(), None, None)
        .await
        .unwrap();

    let mut kinds = Vec::new();
    let mut sequences = Vec::new();
    while let Some(envelope) = stream.next_envelope().await.unwrap() {
        sequences.push(envelope.sequence);
        kinds.push(match envelope.event {
            AnthropicStreamEvent::MessageStart { .. } => "message_start",
            AnthropicStreamEvent::ContentBlockStart { .. } => "content_block_start",
            AnthropicStreamEvent::ContentBlockDelta { .. } => "content_block_delta",
            AnthropicStreamEvent::ContentBlockStop { .. } => "content_block_stop",
            AnthropicStreamEvent::MessageDelta { .. } => "message_delta",
            AnthropicStreamEvent::MessageStop => "message_stop",
            AnthropicStreamEvent::Ping => "ping",
            AnthropicStreamEvent::Error { .. } => "error",
            AnthropicStreamEvent::Receipt { .. } => "receipt",
            AnthropicStreamEvent::Unknown { .. } => "unknown",
        });
    }

    assert_eq!(
        kinds,
        vec![
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
        ]
    );

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

    // No Idempotency-Key header for a stream call (ADR-0024a §D7 stream exclusion).
    assert!(
        !requests[0].headers.contains_key("idempotency-key"),
        "stream calls must never send an Idempotency-Key header"
    );
}

// ---------------------------------------------------------------------------
// `ping` decodes to a real event, not `Unknown`
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ping_decodes_to_a_real_event() {
    let server = MockServer::start().await;
    let body = concat!(
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"m\",\"stop_reason\":null,\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n",
        "event: ping\ndata: {\"type\":\"ping\"}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    );
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
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
        .messages_create_stream(&message_request(), None, None)
        .await
        .unwrap();

    let mut saw_ping = false;
    let mut saw_unknown = false;
    while let Some(envelope) = stream.next_envelope().await.unwrap() {
        match envelope.event {
            AnthropicStreamEvent::Ping => saw_ping = true,
            AnthropicStreamEvent::Unknown { .. } => saw_unknown = true,
            _ => {}
        }
    }
    assert!(saw_ping, "ping frame must decode to AnthropicStreamEvent::Ping");
    assert!(!saw_unknown, "no event should fall back to Unknown in this stream");
}

// ---------------------------------------------------------------------------
// Malformed payload never panics -- decodes to `Unknown`
// ---------------------------------------------------------------------------

#[tokio::test]
async fn malformed_payload_decodes_to_unknown() {
    let server = MockServer::start().await;
    let body = concat!(
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"m\",\"stop_reason\":null,\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n",
        "event: weird\ndata: not-json-at-all{{{\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    );
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
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
        .messages_create_stream(&message_request(), None, None)
        .await
        .unwrap();

    let mut unknown_count = 0;
    while let Some(envelope) = stream.next_envelope().await.unwrap() {
        if matches!(envelope.event, AnthropicStreamEvent::Unknown { .. }) {
            unknown_count += 1;
        }
    }
    assert_eq!(unknown_count, 1, "malformed JSON must decode to exactly one Unknown event, never panic");
}

// ---------------------------------------------------------------------------
// Early termination without `message_stop` -- partial state preserved
// ---------------------------------------------------------------------------

#[tokio::test]
async fn early_termination_preserves_partial_state_and_errors() {
    let server = MockServer::start().await;
    let body = concat!(
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"m\",\"stop_reason\":null,\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}\n\n",
    );
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
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
        .messages_create_stream(&message_request(), None, None)
        .await
        .unwrap();

    let mut saw_delta = false;
    let mut terminal_error: Option<AgenticError> = None;
    loop {
        match stream.next_envelope().await {
            Ok(Some(envelope)) => {
                if matches!(envelope.event, AnthropicStreamEvent::ContentBlockDelta { .. }) {
                    saw_delta = true;
                }
            }
            Ok(None) => break,
            Err(err) => {
                terminal_error = Some(err);
                break;
            }
        }
    }

    assert!(saw_delta, "partial content_block_delta should have been delivered");

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
// No retry after first byte -- mid-stream disconnect surfaces as a
// transport error with exactly one HTTP attempt, never a retry.
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

            let event = "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"one event then drop\"}}\n\n";
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n{:x}\r\n{}\r\n",
                event.len(),
                event
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.flush().await;
            // Deliberately close WITHOUT the terminating `0\r\n\r\n` chunk --
            // an incomplete chunked body is a genuine transport-level error.
            drop(socket);
        }
    });

    let base_url = format!("http://{addr}");
    let mut config = insecure_config(&base_url);
    config.credential_provider = Some(credential_provider(&base_url));
    let client = MetaLlmClient::new(config).unwrap();

    let mut stream = client
        .messages_create_stream(&message_request(), None, None)
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
// Idle timeout on a silently-hanging stream
// ---------------------------------------------------------------------------

#[tokio::test]
async fn idle_timeout_preserves_partial_state_and_errors() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        if let Ok((mut socket, _)) = listener.accept().await {
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf).await;

            let event = "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"before the hang\"}}\n\n";
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
    let mut config = insecure_config(&base_url);
    config.credential_provider = Some(credential_provider(&base_url));
    let client = MetaLlmClient::new(config).unwrap();

    let time_budget = TimeBudget {
        idle_timeout_ms: Some(30),
        ..Default::default()
    };

    let mut stream = client
        .messages_create_stream(&message_request(), Some(time_budget), None)
        .await
        .unwrap();

    let mut saw_delta = false;
    let mut terminal_error: Option<AgenticError> = None;
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            match stream.next_envelope().await {
                Ok(Some(envelope)) => {
                    if matches!(envelope.event, AnthropicStreamEvent::ContentBlockDelta { .. }) {
                        saw_delta = true;
                    }
                }
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
    assert!(saw_delta);

    let err = terminal_error.expect("expected an idle timeout error");
    assert_eq!(err.kind, AgenticErrorKind::DeadlineExceeded);
    assert_eq!(err.code.as_deref(), Some("idle_timeout"));
    assert!(!err.retryable);
    let details = err.details.expect("details should be present");
    assert_eq!(details.get("partial").and_then(|v| v.as_bool()), Some(true));
}

// ---------------------------------------------------------------------------
// First-byte timeout on a silently-hanging stream
// ---------------------------------------------------------------------------

#[tokio::test]
async fn first_byte_timeout_errors_when_no_byte_ever_arrives() {
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
    let mut config = insecure_config(&base_url);
    config.credential_provider = Some(credential_provider(&base_url));
    let client = MetaLlmClient::new(config).unwrap();

    let time_budget = TimeBudget {
        first_byte_timeout_ms: Some(30),
        ..Default::default()
    };

    let outcome = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        let mut stream = client
            .messages_create_stream(&message_request(), Some(time_budget), None)
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
