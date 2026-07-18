//! `chat_completions_stream` HTTP + SSE orchestration (ADR-0024a §D5).
//! Issue #58 / M2 continuation -- the first (and, this pass, only)
//! protocol wired onto the generic [`crate::sse`] parser. Anthropic
//! Messages streaming and Responses streaming are explicitly DEFERRED to
//! follow-up work; they reuse the same generic parser.
//!
//! Pre-byte behavior mirrors `super::super::nonstream::post_json_idempotent`
//! (credential acquisition, 401-refresh-once, bounded 429/502/503 retry)
//! with one deliberate difference: ADR-0024a §D7 generates an SDK
//! idempotency key only for "a direct nonstream call" -- streams are
//! excluded -- so no `Idempotency-Key` header is sent here.
//!
//! Post-byte behavior is the ADR-0023 §D6 / ADR-0024a §D5 contract: once
//! any response byte has been read, there is NO retry, period -- a
//! mid-stream disconnect, parse failure, cancellation, or timeout all
//! surface as a typed terminal error from [`ChatCompletionsStream::next_envelope`],
//! with whatever events were already returned standing as the partial
//! result (the SDK never synthesizes a fake terminal event or claims
//! rollback happened).
//!
//! Idle/first-byte/total-time budgets come from the frozen ADR-0023
//! [`TimeBudget`] type; cancellation from [`CancellationToken`].
//!
//! **Async-stream representation**: Rust has no stable async-generator
//! syntax, and adding `async-stream`/`tokio-stream` as a new dependency
//! just for this pass felt heavier than needed. [`ChatCompletionsStream`]
//! is therefore a manual pull-based async iterator: call
//! `next_envelope().await` in a `while let Some(envelope) = ...` loop,
//! the same shape as `futures::Stream::next()` from `StreamExt` without
//! requiring that crate. This is a deliberate, documented choice, not an
//! oversight.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::agentic::{
    equal_jitter_delay_ms, AgenticError, AgenticErrorKind, CancellationToken, RetryPolicy,
    TimeBudget,
};
use crate::sse::SseParser;

use super::super::client::MetaLlmClient;
use super::super::types::ChatCompletionRequest;
use super::super::PRODUCT;
use super::envelope::MetaLlmStreamEnvelope;
use super::openai_events::{decode_openai_sse_event, OpenAiStreamEvent};

const OPERATION: &str = "chat_completions_stream";

fn now_iso() -> String {
    // No `time`/`chrono` dependency is pulled in for this -- a
    // seconds-since-epoch-based RFC 3339 UTC string is sufficient for a
    // locally-produced provenance timestamp (not parsed by the server).
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
    // Civil-from-days (Howard Hinnant's algorithm) to avoid a chrono dependency.
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
    format!(
        "{y:04}-{m_:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z",
        y = y,
        m_ = m_,
        d = d,
        h = h,
        m = m,
        s = s,
        millis = millis
    )
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
/// per the same bounded policy as `post_json_idempotent` for 401 (once)
/// and 429/502/503 (bounded) -- all BEFORE any response bytes are read. No
/// `Idempotency-Key` header (ADR-0024a §D7 excludes streams).
async fn open_stream_with_pre_byte_retry(
    client: &MetaLlmClient,
    request: &ChatCompletionRequest,
    request_id: &str,
) -> Result<reqwest::Response, AgenticError> {
    let mut credential = client.require_credential(OPERATION).await?;

    let mut streaming_request = request.clone();
    streaming_request.stream = Some(true);
    let body: Value = serde_json::to_value(&streaming_request).map_err(|cause| AgenticError {
        product: Some(PRODUCT.to_owned()),
        operation: Some(OPERATION.to_owned()),
        ..AgenticError::new(
            AgenticErrorKind::Validation,
            format!("{OPERATION} request failed to serialize: {cause}"),
        )
    })?;

    let retry_policy = RetryPolicy::default();
    let mut attempt: u32 = 0;
    let mut sleep_budget_used_ms: u64 = 0;
    let mut refreshed_once = false;

    loop {
        let mut headers = reqwest::header::HeaderMap::new();
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
        client.apply_auth(&mut headers, &credential);

        let url = format!("{}/v1/chat/completions", client.config().base_url);
        let response = client
            .http
            .post(&url)
            .headers(headers)
            .json(&body)
            .send()
            .await
            .map_err(|cause| AgenticError {
                product: Some(PRODUCT.to_owned()),
                operation: Some(OPERATION.to_owned()),
                request_id: Some(request_id.to_owned()),
                retryable: true,
                ..AgenticError::new(
                    AgenticErrorKind::Transport,
                    format!("{OPERATION} request failed: {cause}"),
                )
            })?;

        if response.status().is_success() {
            return Ok(response);
        }

        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        let err = MetaLlmClient::map_http_error(status, &body_text, OPERATION, request_id);

        if err.status == Some(401) && !refreshed_once {
            refreshed_once = true;
            if let Some(provider) = client.config().credential_provider.as_ref() {
                provider.invalidate("401 challenge from meta-llm").await;
            }
            credential = client.require_credential(OPERATION).await?;
            continue;
        }

        let is_bounded_retryable = matches!(err.status, Some(429) | Some(502) | Some(503));
        if is_bounded_retryable && attempt + 1 < retry_policy.max_attempts {
            let server_hint_ms = err.retry_after_ms.unwrap_or(0);
            let jitter_ms = super::super::nonstream::random_jitter_ms(retry_policy.base_ms);
            let delay_ms = equal_jitter_delay_ms(attempt, &retry_policy, server_hint_ms, jitter_ms);
            if sleep_budget_used_ms.saturating_add(delay_ms) > retry_policy.retry_sleep_budget_ms {
                return Err(err);
            }
            sleep_budget_used_ms += delay_ms;
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            attempt += 1;
            continue;
        }

        return Err(err);
    }
}

/// A live `chat.completions` stream. Pull with [`Self::next_envelope`] --
/// see the module docs for why this is not a `futures::Stream`.
pub struct ChatCompletionsStream {
    response: reqwest::Response,
    parser: SseParser,
    request_id: String,
    sequence: u64,
    saw_terminal: bool,
    time_budget: Option<TimeBudget>,
    cancellation: Option<Arc<dyn CancellationToken>>,
    stream_started_at: Instant,
    last_byte_at: Instant,
    received_first_byte: bool,
    /// Envelopes already decoded but not yet returned -- one `feed()` call
    /// (or the final `finish()` flush) can produce more than one envelope,
    /// but `next_envelope` only ever returns one at a time.
    pending: std::collections::VecDeque<MetaLlmStreamEnvelope<OpenAiStreamEvent>>,
    /// Set once the stream has reached ANY terminal condition (clean
    /// success, or one of the error cases). `next_envelope` drains
    /// `pending` first and only surfaces this once `pending` is empty, so
    /// no already-decoded envelope is ever dropped in favor of the
    /// terminal result.
    finished: Option<Result<(), AgenticError>>,
    /// `true` once the terminal result has been returned exactly once --
    /// every call after that is a harmless `Ok(None)` rather than touching
    /// `response`/`parser` again.
    done: bool,
}

impl ChatCompletionsStream {
    fn new(
        response: reqwest::Response,
        request_id: String,
        time_budget: Option<TimeBudget>,
        cancellation: Option<Arc<dyn CancellationToken>>,
    ) -> Self {
        let now = Instant::now();
        Self {
            response,
            parser: SseParser::new(),
            request_id,
            sequence: 0,
            saw_terminal: false,
            time_budget,
            cancellation,
            stream_started_at: now,
            last_byte_at: now,
            received_first_byte: false,
            pending: std::collections::VecDeque::new(),
            finished: None,
            done: false,
        }
    }

    fn push_envelopes(&mut self, raw_event: &crate::sse::SseEvent) {
        let decoded = decode_openai_sse_event(raw_event);
        for event in decoded.events {
            self.sequence += 1;
            if matches!(
                event,
                OpenAiStreamEvent::Done | OpenAiStreamEvent::FinishReason { .. }
            ) {
                self.saw_terminal = true;
            }
            self.pending.push_back(MetaLlmStreamEnvelope {
                event,
                sequence: self.sequence,
                received_at: now_iso(),
                request_id: self.request_id.clone(),
                raw_event_name: raw_event.event.clone(),
                unknown_fields: decoded.unknown_fields.clone(),
            });
        }
    }

    /// Pull the next envelope. Returns `Ok(None)` once the stream has ended
    /// AFTER observing its native terminal event (`[DONE]` or a
    /// `finish_reason`) -- success. Returns `Err(_)` for any other
    /// end-of-iteration (parse failure, disconnect, cancellation, timeout,
    /// or a clean close with no terminal event ever seen) -- whatever
    /// envelopes were already returned via prior `Ok(Some(_))` calls stand
    /// as the partial result; nothing is synthesized or rolled back.
    #[allow(clippy::result_large_err)]
    pub async fn next_envelope(
        &mut self,
    ) -> Result<Option<MetaLlmStreamEnvelope<OpenAiStreamEvent>>, AgenticError> {
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

            if let Some(budget) = self.time_budget.as_ref() {
                if let Some(deadline_ms) = budget.request_deadline_ms {
                    if self.stream_started_at.elapsed().as_millis() as u64 > deadline_ms {
                        self.finished = Some(Err(deadline_error(
                            &self.request_id,
                            "request_deadline_exceeded",
                            format!("{OPERATION} exceeded requestDeadlineMs ({deadline_ms}ms)"),
                            self.sequence,
                        )));
                        continue;
                    }
                }
                let idle_limit_ms = if self.received_first_byte {
                    budget.idle_timeout_ms
                } else {
                    budget.first_byte_timeout_ms
                };
                if let Some(idle_limit_ms) = idle_limit_ms {
                    if self.last_byte_at.elapsed().as_millis() as u64 > idle_limit_ms {
                        let code = if self.received_first_byte {
                            "idle_timeout"
                        } else {
                            "first_byte_timeout"
                        };
                        let field = if self.received_first_byte {
                            "idleTimeoutMs"
                        } else {
                            "firstByteTimeoutMs"
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
            }

            match self.response.chunk().await {
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
                Ok(None) => {
                    // Underlying source ended. Resolve the one ambiguity
                    // `feed()` cannot: a trailing lone CR (see `SseParser::finish`).
                    match self.parser.finish() {
                        Ok(finish_result) => {
                            for raw_event in &finish_result.events {
                                self.push_envelopes(raw_event);
                            }
                            self.finished = Some(if self.saw_terminal {
                                Ok(())
                            } else {
                                Err(AgenticError {
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
                                })
                            });
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
                                    format!(
                                        "{OPERATION} SSE parse failure at end of stream: {cause}"
                                    ),
                                )
                            }));
                        }
                    }
                }
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
}

/// `POST /v1/chat/completions` with `stream: true` (ADR-0024a §D5). Opens
/// the stream (performing the pre-byte credential/retry phase) and returns
/// a [`ChatCompletionsStream`] to pull events from.
#[allow(clippy::result_large_err)]
pub async fn chat_completions_stream(
    client: &MetaLlmClient,
    request: &ChatCompletionRequest,
    request_id: String,
    time_budget: Option<TimeBudget>,
    cancellation: Option<Arc<dyn CancellationToken>>,
) -> Result<ChatCompletionsStream, AgenticError> {
    let response = open_stream_with_pre_byte_retry(client, request, &request_id).await?;
    Ok(ChatCompletionsStream::new(
        response,
        request_id,
        time_budget,
        cancellation,
    ))
}
