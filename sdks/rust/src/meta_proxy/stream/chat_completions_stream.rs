//! `chat_completions_stream` HTTP + SSE orchestration for `MetaProxyClient`
//! (ADR-0025a §D8, M3 continuation of issue #61).
//!
//! §D8: "Chat and Messages use ADR-0024a's lossless protocol streams and add
//! plane and Proxy version metadata." This module REUSES, rather than
//! reimplements:
//!  - PR #88's generic byte-level SSE parser (`crate::sse`);
//!  - PR #88/#93's OpenAI event decoder (`crate::meta_llm::stream`) — the
//!    byte-forwarded stream is decoded exactly like direct Meta LLM
//!    streaming (the Proxy forwards the same OpenAI wire shape verbatim,
//!    §D7: "reuse only the wire types and stream events");
//!  - `super::super::http`'s credential acquisition/bearer placement/error
//!    mapping and `super::super::forwarding`'s §D7 header allowlist, so a
//!    caller sees byte-for-byte identical forwarding behavior whether they
//!    call the streaming or non-streaming method.
//!
//! On top of the reused pieces, this module adds exactly what §D8 asks for
//! beyond ADR-0024a's stream contract:
//!  - `MetaProxyStreamEnvelope::proxy_meta` (plane/version metadata, `./envelope.rs`);
//!  - `ProxyTimeBudget`'s `connect_timeout_ms`/`overall_deadline_ms`
//!    (`../time_budget.rs`), raced around the pre-byte HTTP attempt(s) in
//!    addition to the first-byte/idle races PR #88 already proved correct
//!    for the post-byte read loop;
//!  - the §D5 rule 7 required-plane check
//!    (`super::super::routing::assert_routing_receipt_matches_intent`, the
//!    SAME function the non-streaming path uses), applied to the LAST
//!    routing receipt observed on the wire before the stream's native
//!    terminal event.
//!
//! Retry contract (ADR-0025a §D8, and the just-fixed eb553f7 bug this MUST
//! NOT reintroduce): the pre-byte phase performs at most one 401-triggered
//! credential refresh and NEVER bounded-retries a 429/502/503 — "No Proxy
//! POST is automatically retried while it drops `Idempotency-Key`" describes
//! the currently-deployed Proxy dropping the header server-side, not whether
//! the SDK attaches one; attaching one client-side does not make a retry
//! safe. A non-2xx pre-byte response is therefore always a single terminal,
//! non-retryable error (`err.retry_after_ms` lets the CALLER retry
//! manually). Once any response byte has been read, there is NO retry at
//! all, period — mirroring PR #88's
//! `crate::meta_llm::stream::chat_completions_stream` exactly.
//!
//! Sponsored streaming (`stream: true` on a sponsored-plane call) is
//! explicitly OUT of scope this pass — see `super::super::client`'s
//! `sponsored_chat_completions` for the fail-fast guard (§D8: "Sponsored
//! `stream = true` fails locally until an end-to-end stream capability
//! exists").

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::agentic::{AgenticError, AgenticErrorKind, CancellationToken};
use crate::meta_llm::stream::{decode_openai_sse_event, MetaLlmStreamEnvelope, OpenAiStreamEvent};
use crate::meta_llm::types::openai::ChatCompletionRequest;
use crate::sse::SseParser;

use super::super::client::MetaProxyClient;
use super::super::forwarding::{build_forward_headers, MetaProxyChatCallOptions};
use super::super::http::INFERENCE_SCOPE;
use super::super::routing::{assert_routing_receipt_matches_intent, RoutingIntent};
use super::super::status::{parse_routing_receipt, MetaProxyRoutingReceipt};
use super::super::time_budget::{
    resolve_proxy_time_budget, ProxyTimeBudget, ResolvedProxyTimeBudget,
};
use super::super::PRODUCT;
use super::envelope::{MetaProxyStreamEnvelope, MetaProxyStreamMeta};

const OPERATION: &str = "chat_completions_stream";
const CHAT_PATH: &str = "/v1/chat/completions";

fn now_iso() -> String {
    // No `time`/`chrono` dependency — matches `crate::meta_llm::stream`'s
    // own equivalent helper (a locally-produced provenance timestamp, not
    // parsed by the server).
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let (h, m, s) = (
        time_of_day / 3600,
        (time_of_day % 3600) / 60,
        time_of_day % 60,
    );
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m_ = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m_ <= 2 { y + 1 } else { y };
    format!("{y:04}-{m_:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

fn deadline_error(request_id: &str, code: &str, message: String, sequence: u64) -> AgenticError {
    AgenticError {
        product: Some(PRODUCT.to_owned()),
        operation: Some(OPERATION.to_owned()),
        request_id: Some(request_id.to_owned()),
        retryable: false,
        code: Some(code.to_owned()),
        details: Some(serde_json::json!({"partial": true, "eventsReceived": sequence})),
        ..AgenticError::new(AgenticErrorKind::DeadlineExceeded, message)
    }
}

/// The pre-byte phase: acquire a credential, send the request, and retry
/// ONLY on a verified 401 (once) — never on 429/502/503 (ADR-0025a §D8, the
/// just-fixed eb553f7 bug this must not reintroduce). Each attempt is raced
/// against `min(connect_timeout_ms, overall_deadline_ms remaining)`.
#[allow(clippy::too_many_arguments)]
async fn open_stream_with_pre_byte_retry(
    client: &MetaProxyClient,
    request: &ChatCompletionRequest,
    request_id: &str,
    idempotency_key: &str,
    forward_headers: Option<&std::collections::HashMap<String, String>>,
    budget: &ResolvedProxyTimeBudget,
    overall_started_at: Instant,
) -> Result<reqwest::Response, AgenticError> {
    let mut credential = client
        .resolve_credential(OPERATION, INFERENCE_SCOPE)
        .await?
        .ok_or_else(|| {
            AgenticError::new(
                AgenticErrorKind::Authentication,
                format!(
                    "MetaProxyClient::{OPERATION} requires a local_credential_provider \
                     (ADR-0025a §D6: the Proxy's /v1 forwarding routes are authenticated)"
                ),
            )
            .with_product_operation()
        })?;

    let mut streaming_request = serde_json::to_value(request).map_err(|cause| AgenticError {
        product: Some(PRODUCT.to_owned()),
        operation: Some(OPERATION.to_owned()),
        ..AgenticError::new(
            AgenticErrorKind::Validation,
            format!("{OPERATION} request failed to serialize: {cause}"),
        )
    })?;
    if let Value::Object(ref mut obj) = streaming_request {
        obj.insert("stream".to_owned(), Value::Bool(true));
    }

    let mut refreshed_once = false;

    loop {
        let now = Instant::now();
        let elapsed_ms = now.duration_since(overall_started_at).as_millis() as u64;
        if let Some(overall_deadline_ms) = budget.overall_deadline_ms {
            if elapsed_ms > overall_deadline_ms {
                return Err(deadline_error(
                    request_id,
                    "overall_deadline_exceeded",
                    format!(
                        "{OPERATION} exceeded overall_deadline_ms ({overall_deadline_ms}ms) \
                         before a response was received"
                    ),
                    0,
                ));
            }
        }
        let overall_remaining_ms = budget
            .overall_deadline_ms
            .map(|deadline| deadline.saturating_sub(elapsed_ms));
        let connect_remaining_ms = match overall_remaining_ms {
            Some(remaining) => budget.connect_timeout_ms.min(remaining),
            None => budget.connect_timeout_ms,
        };

        let mut headers = build_forward_headers(forward_headers);
        headers.insert(
            reqwest::header::ACCEPT,
            reqwest::header::HeaderValue::from_static("text/event-stream"),
        );
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        if let Ok(value) = reqwest::header::HeaderValue::from_str(request_id) {
            headers.insert("X-Cognitum-Request-Id", value);
        }
        if let Ok(value) = reqwest::header::HeaderValue::from_str(idempotency_key) {
            headers.insert("Idempotency-Key", value);
        }
        client.apply_auth(&mut headers, &credential);

        let url = format!("{}{}", client.config().origin, CHAT_PATH);
        let send_fut = client
            .http
            .post(&url)
            .headers(headers)
            .json(&streaming_request)
            .send();

        let response = match tokio::time::timeout(
            Duration::from_millis(connect_remaining_ms),
            send_fut,
        )
        .await
        {
            Ok(Ok(response)) => response,
            Ok(Err(cause)) => {
                return Err(AgenticError {
                    product: Some(PRODUCT.to_owned()),
                    operation: Some(OPERATION.to_owned()),
                    request_id: Some(request_id.to_owned()),
                    retryable: true,
                    ..AgenticError::new(
                        AgenticErrorKind::Transport,
                        format!("{OPERATION} request failed: {cause}"),
                    )
                });
            }
            Err(_elapsed) => {
                let overall_exceeded = budget.overall_deadline_ms.is_some_and(|deadline| {
                    Instant::now()
                        .duration_since(overall_started_at)
                        .as_millis() as u64
                        > deadline
                });
                return Err(deadline_error(
                    request_id,
                    if overall_exceeded {
                        "overall_deadline_exceeded"
                    } else {
                        "connect_timeout"
                    },
                    if overall_exceeded {
                        format!(
                            "{OPERATION} exceeded overall_deadline_ms ({:?}ms) before a response was received",
                            budget.overall_deadline_ms
                        )
                    } else {
                        format!(
                            "{OPERATION} exceeded connect_timeout_ms ({}ms) waiting for a response",
                            budget.connect_timeout_ms
                        )
                    },
                    0,
                ));
            }
        };

        if response.status().is_success() {
            return Ok(response);
        }

        let status = response.status();
        let retry_after_ms = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<f64>().ok())
            .map(|secs| (secs * 1000.0) as u64);
        let body_text = response.text().await.unwrap_or_default();
        let mut err = MetaProxyClient::map_http_error(status, &body_text, OPERATION, request_id);
        if err.status == Some(401) && !refreshed_once {
            refreshed_once = true;
            if let Some(provider) = client.config().local_credential_provider.as_ref() {
                provider.invalidate("401 challenge from meta-proxy").await;
            }
            credential = match client
                .resolve_credential(OPERATION, INFERENCE_SCOPE)
                .await?
            {
                Some(credential) => credential,
                None => return Err(err),
            };
            continue;
        }

        // ADR-0025a §D8 / eb553f7: NEVER bounded-retry 429/502/503 (or any
        // other status) here — a single terminal error, exactly matching
        // non-streaming `post_json_forwarding` in `super::super::http`.
        if err.retry_after_ms.is_none() {
            err.retry_after_ms = retry_after_ms;
        }
        return Err(err);
    }
}

trait WithProductOperation {
    fn with_product_operation(self) -> Self;
}

impl WithProductOperation for AgenticError {
    fn with_product_operation(mut self) -> Self {
        self.product = Some(PRODUCT.to_owned());
        self.operation = Some(OPERATION.to_owned());
        self
    }
}

/// A live `chat_completions` stream through the Proxy. Pull with
/// [`Self::next_envelope`] — see `crate::meta_llm::stream::ChatCompletionsStream`
/// for why this is not a `futures::Stream`.
pub struct MetaProxyChatCompletionsStream {
    response: reqwest::Response,
    parser: SseParser,
    request_id: String,
    sequence: u64,
    saw_native_terminal: bool,
    budget: ResolvedProxyTimeBudget,
    cancellation: Option<Arc<dyn CancellationToken>>,
    overall_started_at: Instant,
    last_byte_at: Instant,
    received_first_byte: bool,
    product_version: Option<String>,
    protocol_version: Option<String>,
    latest_routing_receipt: Option<MetaProxyRoutingReceipt>,
    latest_upstream_receipt: Option<Value>,
    routing_intent: Option<RoutingIntent>,
    pending: VecDeque<MetaProxyStreamEnvelope>,
    finished: Option<Result<(), AgenticError>>,
    done: bool,
}

impl MetaProxyChatCompletionsStream {
    #[allow(clippy::too_many_arguments)]
    fn new(
        response: reqwest::Response,
        request_id: String,
        budget: ResolvedProxyTimeBudget,
        overall_started_at: Instant,
        cancellation: Option<Arc<dyn CancellationToken>>,
        routing_intent: Option<RoutingIntent>,
    ) -> Self {
        let product_version = response
            .headers()
            .get("x-cognitum-product-version")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let protocol_version = response
            .headers()
            .get("x-cognitum-protocol-version")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        Self {
            response,
            parser: SseParser::new(),
            request_id,
            sequence: 0,
            saw_native_terminal: false,
            budget,
            cancellation,
            overall_started_at,
            last_byte_at: overall_started_at,
            received_first_byte: false,
            product_version,
            protocol_version,
            latest_routing_receipt: None,
            latest_upstream_receipt: None,
            routing_intent,
            pending: VecDeque::new(),
            finished: None,
            done: false,
        }
    }

    fn remaining_budget_ms(&self) -> Option<u64> {
        let mut candidates: Vec<u64> = Vec::new();
        if let Some(deadline_ms) = self.budget.overall_deadline_ms {
            let elapsed_ms = self.overall_started_at.elapsed().as_millis() as u64;
            candidates.push(deadline_ms.saturating_sub(elapsed_ms));
        }
        let idle_limit_ms = if self.received_first_byte {
            self.budget.idle_stream_timeout_ms
        } else {
            self.budget.first_byte_timeout_ms
        };
        if let Some(idle_limit_ms) = idle_limit_ms {
            let elapsed_ms = self.last_byte_at.elapsed().as_millis() as u64;
            candidates.push(idle_limit_ms.saturating_sub(elapsed_ms));
        }
        candidates.into_iter().min()
    }

    fn is_native_terminal(event: &OpenAiStreamEvent) -> bool {
        // A wire-level terminal error event is ALSO a valid stream terminus
        // (ADR-0025a §D8: "still requires ... terminal error") — not just
        // the clean done/finish_reason path.
        matches!(
            event,
            OpenAiStreamEvent::Done
                | OpenAiStreamEvent::FinishReason { .. }
                | OpenAiStreamEvent::Error { .. }
        )
    }

    fn push_envelopes(&mut self, raw_event: &crate::sse::SseEvent) {
        let decoded = decode_openai_sse_event(raw_event);
        if let Some(unknown) = decoded.unknown_fields.as_ref() {
            if let Some(receipt) = unknown
                .get("cognitum_routing_receipt")
                .and_then(parse_routing_receipt)
            {
                self.latest_routing_receipt = Some(receipt);
            }
            if let Some(upstream) = unknown.get("cognitum_upstream_receipt") {
                self.latest_upstream_receipt = Some(upstream.clone());
            }
        }
        for event in decoded.events {
            self.sequence += 1;
            if Self::is_native_terminal(&event) {
                self.saw_native_terminal = true;
            }
            let inner = MetaLlmStreamEnvelope {
                event,
                sequence: self.sequence,
                received_at: now_iso(),
                request_id: self.request_id.clone(),
                raw_event_name: raw_event.event.clone(),
                unknown_fields: decoded.unknown_fields.clone(),
            };
            let proxy_meta = MetaProxyStreamMeta {
                product_version: self.product_version.clone(),
                protocol_version: self.protocol_version.clone(),
                routing_receipt: self.latest_routing_receipt.clone(),
                upstream_receipt: self.latest_upstream_receipt.clone(),
            };
            self.pending
                .push_back(MetaProxyStreamEnvelope { inner, proxy_meta });
        }
    }

    /// Pull the next envelope. Returns `Ok(None)` once the stream has ended
    /// AFTER observing its native terminal event AND passing the §D5 rule 7
    /// required-plane check — success. Returns `Err(_)` for any other
    /// end-of-iteration (parse failure, disconnect, cancellation, timeout, a
    /// clean close with no terminal event ever seen, or a required-plane
    /// mismatch/absence) — whatever envelopes were already returned via
    /// prior `Ok(Some(_))` calls stand as the partial result.
    #[allow(clippy::result_large_err)]
    pub async fn next_envelope(&mut self) -> Result<Option<MetaProxyStreamEnvelope>, AgenticError> {
        loop {
            if self.done {
                return Ok(None);
            }
            if let Some(envelope) = self.pending.pop_front() {
                return Ok(Some(envelope));
            }
            if let Some(finished) = self.finished.take() {
                self.done = true;
                return finished.map(|()| None);
            }

            if let Some(cancellation) = self.cancellation.as_ref() {
                if cancellation.is_cancelled() {
                    self.finished = Some(Err(AgenticError {
                        product: Some(PRODUCT.to_owned()),
                        operation: Some(OPERATION.to_owned()),
                        request_id: Some(self.request_id.clone()),
                        retryable: false,
                        code: Some("local_cancellation".to_owned()),
                        details: Some(
                            serde_json::json!({"partial": true, "eventsReceived": self.sequence}),
                        ),
                        ..AgenticError::new(
                            AgenticErrorKind::Cancelled,
                            format!("{OPERATION} was cancelled locally"),
                        )
                    }));
                    continue;
                }
            }

            if let Some(deadline_ms) = self.budget.overall_deadline_ms {
                if self.overall_started_at.elapsed().as_millis() as u64 > deadline_ms {
                    self.finished = Some(Err(deadline_error(
                        &self.request_id,
                        "overall_deadline_exceeded",
                        format!("{OPERATION} exceeded overall_deadline_ms ({deadline_ms}ms)"),
                        self.sequence,
                    )));
                    continue;
                }
            }
            let idle_limit_ms = if self.received_first_byte {
                self.budget.idle_stream_timeout_ms
            } else {
                self.budget.first_byte_timeout_ms
            };
            if let Some(idle_limit_ms) = idle_limit_ms {
                if self.last_byte_at.elapsed().as_millis() as u64 > idle_limit_ms {
                    let code = if self.received_first_byte {
                        "idle_stream_timeout"
                    } else {
                        "first_byte_timeout"
                    };
                    let field = if self.received_first_byte {
                        "idle_stream_timeout_ms"
                    } else {
                        "first_byte_timeout_ms"
                    };
                    self.finished = Some(Err(deadline_error(
                        &self.request_id,
                        code,
                        format!("{OPERATION} exceeded {field} ({idle_limit_ms}ms)"),
                        self.sequence,
                    )));
                    continue;
                }
            }

            // Bound the otherwise-unbounded blocking read against whichever
            // budget is smallest, so a server that accepts the connection
            // and then goes silent without closing the socket cannot hang
            // this `next_envelope` call forever.
            let chunk_result = if let Some(remaining_ms) = self.remaining_budget_ms() {
                match tokio::time::timeout(
                    Duration::from_millis(remaining_ms),
                    self.response.chunk(),
                )
                .await
                {
                    Ok(inner) => inner,
                    Err(_elapsed) => continue,
                }
            } else {
                self.response.chunk().await
            };

            match chunk_result {
                Ok(Some(bytes)) => {
                    self.received_first_byte = true;
                    self.last_byte_at = Instant::now();

                    match self.parser.feed(&bytes) {
                        Ok(raw_events) => {
                            for raw_event in &raw_events {
                                self.push_envelopes(raw_event);
                            }
                        }
                        Err(cause) => {
                            self.finished = Some(Err(AgenticError {
                                product: Some(PRODUCT.to_owned()),
                                operation: Some(OPERATION.to_owned()),
                                request_id: Some(self.request_id.clone()),
                                retryable: false,
                                code: Some("sse_parse_error".to_owned()),
                                details: Some(
                                    serde_json::json!({"partial": true, "eventsReceived": self.sequence}),
                                ),
                                ..AgenticError::new(
                                    AgenticErrorKind::Protocol,
                                    format!("{OPERATION} SSE parse failure: {cause}"),
                                )
                            }));
                        }
                    }
                }
                Ok(None) => match self.parser.finish() {
                    Ok(finish_result) => {
                        for raw_event in &finish_result.events {
                            self.push_envelopes(raw_event);
                        }
                        self.finished = Some(self.finalize());
                    }
                    Err(cause) => {
                        self.finished = Some(Err(AgenticError {
                            product: Some(PRODUCT.to_owned()),
                            operation: Some(OPERATION.to_owned()),
                            request_id: Some(self.request_id.clone()),
                            retryable: false,
                            code: Some("sse_parse_error".to_owned()),
                            details: Some(
                                serde_json::json!({"partial": true, "eventsReceived": self.sequence}),
                            ),
                            ..AgenticError::new(
                                AgenticErrorKind::Protocol,
                                format!("{OPERATION} SSE parse failure at end of stream: {cause}"),
                            )
                        }));
                    }
                },
                Err(cause) => {
                    self.finished = Some(Err(AgenticError {
                        product: Some(PRODUCT.to_owned()),
                        operation: Some(OPERATION.to_owned()),
                        request_id: Some(self.request_id.clone()),
                        retryable: false,
                        code: Some("stream_disconnected".to_owned()),
                        details: Some(
                            serde_json::json!({"partial": true, "eventsReceived": self.sequence}),
                        ),
                        ..AgenticError::new(
                            AgenticErrorKind::Transport,
                            format!("{OPERATION} stream read failed: {cause}"),
                        )
                    }));
                }
            }
        }
    }

    /// Called exactly once, when the underlying source ends. Confirms the
    /// native terminal event was observed (ADR-0024a §D5) and, when a
    /// `routing_intent.required_plane` is set, applies the SAME §D5 rule 7
    /// check the non-streaming path uses to the LAST routing receipt
    /// observed on the wire.
    #[allow(clippy::result_large_err)]
    fn finalize(&self) -> Result<(), AgenticError> {
        if !self.saw_native_terminal {
            return Err(AgenticError {
                product: Some(PRODUCT.to_owned()),
                operation: Some(OPERATION.to_owned()),
                request_id: Some(self.request_id.clone()),
                retryable: false,
                code: Some("stream_ended_without_terminal_event".to_owned()),
                details: Some(
                    serde_json::json!({"partial": true, "eventsReceived": self.sequence}),
                ),
                ..AgenticError::new(
                    AgenticErrorKind::Protocol,
                    format!("{OPERATION} stream ended without ever observing a terminal event"),
                )
            });
        }

        if let Some(required) = self.routing_intent.as_ref().and_then(|i| i.required_plane) {
            match self.latest_routing_receipt.as_ref() {
                Some(receipt) => {
                    assert_routing_receipt_matches_intent(self.routing_intent.as_ref(), receipt)?
                }
                None => {
                    return Err(AgenticError {
                        product: Some(PRODUCT.to_owned()),
                        operation: Some(OPERATION.to_owned()),
                        request_id: Some(self.request_id.clone()),
                        ..AgenticError::new(
                            AgenticErrorKind::Protocol,
                            format!(
                                "{OPERATION} required_plane \"{}\" cannot be verified: the stream \
                                 never carried a routing receipt (ADR-0025a §D4: every inference \
                                 must return selected-plane evidence)",
                                required.wire_str()
                            ),
                        )
                    });
                }
            }
        }
        Ok(())
    }
}

/// `POST /v1/chat/completions` through the Proxy with `stream: true`
/// (ADR-0025a §D8). Opens the stream (performing the pre-byte credential/
/// retry phase) and returns a [`MetaProxyChatCompletionsStream`] to pull
/// events from.
#[allow(clippy::result_large_err)]
pub async fn chat_completions_stream(
    client: &MetaProxyClient,
    request: &ChatCompletionRequest,
    options: Option<MetaProxyChatCallOptions>,
    time_budget: Option<ProxyTimeBudget>,
    cancellation: Option<Arc<dyn CancellationToken>>,
) -> Result<MetaProxyChatCompletionsStream, AgenticError> {
    let options = options.unwrap_or_default();
    let idempotency_key = options
        .idempotency_key
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let request_id = uuid::Uuid::new_v4().to_string();
    let budget = resolve_proxy_time_budget(time_budget);
    let overall_started_at = Instant::now();

    let response = open_stream_with_pre_byte_retry(
        client,
        request,
        &request_id,
        &idempotency_key,
        options.forward_headers.as_ref(),
        &budget,
        overall_started_at,
    )
    .await?;

    Ok(MetaProxyChatCompletionsStream::new(
        response,
        request_id,
        budget,
        overall_started_at,
        cancellation,
        options.routing_intent,
    ))
}
