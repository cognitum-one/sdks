//! Micro-benchmark: SSE stream parser + envelope decode overhead for
//! `MetaLlmClient::chat_completions_stream()` (ADR-0024a §D5, issue #58 /
//! PR #88/#95's streaming work).
//!
//! Measures two things against a local `wiremock` server emitting a
//! bounded, deterministic sequence of OpenAI-shaped SSE chunks:
//!   1. time-to-first-event — wall clock from calling
//!      `chat_completions_stream()` to the first `next_envelope()`
//!      resolving with a value (dominated by the local HTTP round trip,
//!      not the parser);
//!   2. steady-state throughput — events/sec once bytes are flowing,
//!      isolating the `crate::sse::SseParser::feed` + OpenAI SSE decode +
//!      envelope-build cost per event (CPU-bound, not I/O-bound, since the
//!      whole response body is already buffered by wiremock/hyper by the
//!      time `next_envelope()` starts draining it).
//!
//! `MetaProxyClient`'s streaming (`meta_proxy::stream`) is built on the
//! same generic `crate::sse::SseParser` (see that module's doc comment:
//! "Anthropic Messages streaming and Responses streaming ... reuse the
//! same generic parser"), so this bench's steady-state parser numbers are
//! representative of Meta Proxy's streaming overhead too, not just Meta
//! LLM's.
//!
//! Targets (engineering estimates, NOT ADR-mandated — no ADR cites a
//! streaming-latency number the way ADR-0005 cites <1ms p50 for the seed
//! client):
//!   - time-to-first-event p50 < 5 ms against a local mock (should be
//!     dominated by the loopback HTTP round trip, not the parser);
//!   - steady-state throughput > 20,000 events/sec (< 50 µs/event for
//!     SSE-frame parse + OpenAI JSON decode + envelope construction).
//!
//! Run it as an example:
//!
//! ```bash
//! cargo run --release --features meta-llm --example agentic_streaming_bench
//! # or, registered as a bench target:
//! cargo bench --features meta-llm --bench agentic_streaming_bench
//! ```

#![cfg(feature = "meta-llm")]

use std::sync::Arc;
use std::time::{Duration, Instant};

use cognitum_one::agentic::{StaticApiKeyCredentialProvider, StaticApiKeyCredentialProviderOptions};
use cognitum_one::meta_llm::{MetaLlmClient, MetaLlmClientConfig};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Number of synthetic `content` delta chunks per stream, in addition to
/// the leading role chunk and the trailing finish/usage + `[DONE]` chunks.
/// Large enough to give a stable steady-state throughput estimate without
/// making each iteration slow.
const NUM_CONTENT_CHUNKS: usize = 300;
const ITERS: usize = 60;

fn build_sse_body() -> String {
    let mut body = String::new();
    body.push_str(concat!(
        "data: {\"id\":\"chatcmpl-bench\",\"object\":\"chat.completion.chunk\",\"created\":1,",
        "\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},",
        "\"finish_reason\":null}]}\n\n",
    ));
    for i in 0..NUM_CONTENT_CHUNKS {
        body.push_str(&format!(
            "data: {{\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"chunk-{i} \"}},\"finish_reason\":null}}]}}\n\n",
        ));
    }
    body.push_str(concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],",
        "\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":300,\"total_tokens\":310}}\n\n",
    ));
    body.push_str("data: [DONE]\n\n");
    body
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let server = MockServer::start().await;
    let body = build_sse_body();
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(body.into_bytes(), "text/event-stream"),
        )
        .mount(&server)
        .await;

    let uri = server.uri();
    let mut config = MetaLlmClientConfig::new(uri.clone());
    config.allow_insecure_http = true;
    config.credential_provider = Some(Arc::new(
        StaticApiKeyCredentialProvider::new(
            "meta-llm",
            uri.clone(),
            uri,
            StaticApiKeyCredentialProviderOptions {
                api_key: Some("sk-bench-canary".to_owned()),
                ..Default::default()
            },
        )
        .expect("provider should construct"),
    ));
    let client = MetaLlmClient::new(config).expect("client should construct");

    let request = cognitum_one::meta_llm::types::ChatCompletionRequest {
        model: "meta-llm-large".into(),
        messages: vec![cognitum_one::meta_llm::types::ChatMessage {
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
    };

    // Warmup.
    for _ in 0..5 {
        let mut stream = client
            .chat_completions_stream(&request, None, None)
            .await
            .expect("stream should open");
        while stream.next_envelope().await.expect("event should decode").is_some() {}
    }

    let mut first_event_samples = Vec::with_capacity(ITERS);
    let mut events_per_sec_samples = Vec::with_capacity(ITERS);
    let mut event_counts = Vec::with_capacity(ITERS);

    for _ in 0..ITERS {
        let t_start = Instant::now();
        let mut stream = client
            .chat_completions_stream(&request, None, None)
            .await
            .expect("stream should open");

        let mut count: usize = 0;
        let mut first_event: Option<Duration> = None;
        let mut last = t_start;
        while let Some(_envelope) = stream.next_envelope().await.expect("event should decode") {
            count += 1;
            let now = Instant::now();
            if first_event.is_none() {
                first_event = Some(now - t_start);
            }
            last = now;
        }

        let first_event = first_event.unwrap_or_default();
        let steady_state_duration = (last - t_start).saturating_sub(first_event);
        let steady_state_events = count.saturating_sub(1);
        let events_per_sec = if steady_state_duration.as_secs_f64() > 0.0 {
            steady_state_events as f64 / steady_state_duration.as_secs_f64()
        } else {
            f64::INFINITY
        };

        first_event_samples.push(first_event);
        events_per_sec_samples.push(events_per_sec);
        event_counts.push(count);
    }

    first_event_samples.sort();
    let p50_first_event = first_event_samples[ITERS / 2];
    let p95_first_event = first_event_samples[(ITERS * 95) / 100];
    let mean_first_event: Duration =
        first_event_samples.iter().sum::<Duration>() / ITERS as u32;

    let mut sorted_eps = events_per_sec_samples.clone();
    sorted_eps.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median_eps = sorted_eps[ITERS / 2];
    let mean_eps: f64 = events_per_sec_samples.iter().sum::<f64>() / ITERS as f64;

    println!("chat_completions_stream() — {NUM_CONTENT_CHUNKS} content chunks/iteration, {ITERS} iterations");
    println!(
        "events per stream (incl. role/finish/done): min={} max={}",
        event_counts.iter().min().unwrap(),
        event_counts.iter().max().unwrap()
    );
    println!(
        "time-to-first-event  mean={:>7.3}ms  p50={:>7.3}ms  p95={:>7.3}ms",
        mean_first_event.as_secs_f64() * 1000.0,
        p50_first_event.as_secs_f64() * 1000.0,
        p95_first_event.as_secs_f64() * 1000.0,
    );
    println!(
        "steady-state throughput  mean={mean_eps:>10.1} events/sec  median={median_eps:>10.1} events/sec  ({:.3} µs/event)",
        1_000_000.0 / median_eps,
    );

    println!(
        "\n{}",
        if p50_first_event < Duration::from_millis(5) {
            "PASS: time-to-first-event p50 < 5ms"
        } else {
            "WARN: time-to-first-event p50 >= 5ms"
        }
    );
    println!(
        "{}",
        if median_eps > 20_000.0 {
            "PASS: steady-state throughput > 20,000 events/sec"
        } else {
            "WARN: steady-state throughput <= 20,000 events/sec"
        }
    );
}
