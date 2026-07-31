//! `messages_stream` HTTP + SSE orchestration (ADR-0024a §D5). Issue #58 /
//! M2 continuation, item 2 of the tracked "what's left" list -- Anthropic
//! Messages streaming on top of the same generic [`crate::sse`] parser
//! `chat_completions_stream` (PR #88) wired up. This file is intentionally
//! the exact same shape as `super::chat_completions_stream` -- only the URL
//! path, the event-decode call, and the terminal condition differ; see that
//! module's docs for the full retry/timeout/cancellation rationale, which
//! applies here unchanged.
//!
//! Pre-byte behavior mirrors `super::super::nonstream::post_json_idempotent`
//! (credential acquisition, 401-refresh-once, bounded 429/502/503 retry)
//! with the same deliberate difference as chat-completions streaming:
//! ADR-0024a §D7 generates an SDK idempotency key only for "a direct
//! nonstream call" -- streams are excluded -- so no `Idempotency-Key`
//! header is sent here either.
//!
//! Post-byte behavior is the ADR-0023 §D6 / ADR-0024a §D5 contract: once
//! any response byte has been read, there is NO retry, period.
//!
//! The wire terminal condition is `message_stop` (ADR-0024a §D5 ground
//! truth: "there is no `[DONE]` sentinel like OpenAI; `message_stop` is the
//! wire terminal condition") -- NOT `[DONE]`/`finish_reason`, which are
//! OpenAI-specific.
//!
//! **Async-stream representation**: same manual pull-based async iterator
//! as [`super::chat_completions_stream::ChatCompletionsStream`] -- call
//! `next_envelope().await` in a `while let Some(envelope) = ...` loop.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::agentic::{
    equal_jitter_delay_ms, AgenticError, AgenticErrorKind, CancellationToken, RetryPolicy,
    TimeBudget,
};
use crate::sse::SseParser;

use super::super::client::MetaLlmClient;
use super::super::types::AnthropicMessageRequest;
use super::super::PRODUCT;
use super::anthropic_events::{decode_anthropic_sse_event, AnthropicStreamEvent};
use super::envelope::MetaLlmStreamEnvelope;

const OPERATION: &str = "messages_create_stream";

fn now_iso() -> String {
    // Same self-contained RFC 3339 UTC formatter as
    // `chat_completions_stream::now_iso` -- no `time`/`chrono` dependency
    // for a locally-produced provenance timestamp not parsed by the server.
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
    request: &AnthropicMessageRequest,
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

        let url = format!("{}/v1/messages", client.config().base_url);
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
        // Read the header BEFORE consuming the response body: the streaming
        // paths previously dropped `Retry-After` on the floor entirely, so a
        // 429 mid-stream retried with no server hint (issue #75).
        let retry_after_ms = crate::meta_llm::http::retry_after_ms_of(&response);
        let body_text = response.text().await.unwrap_or_default();
        let mut err = MetaLlmClient::map_http_error(status, &body_text, OPERATION, request_id);
        if err.retry_after_ms.is_none() {
            err.retry_after_ms = retry_after_ms;
        }

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

/// A live `messages` stream. Pull with [`Self::next_envelope`] -- see the
/// module docs for why this is not a `futures::Stream`.
pub struct MessagesStream {
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
    pending: std::collections::VecDeque<MetaLlmStreamEnvelope<AnthropicStreamEvent>>,
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

impl MessagesStream {
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

    /// The smallest remaining budget (in ms) that must elapse before the
    /// NEXT chunk read is timed out, or `None` if no relevant budget is
    /// configured at all. See
    /// `chat_completions_stream::ChatCompletionsStream::remaining_budget_ms`
    /// for the full rationale -- identical logic.
    fn remaining_budget_ms(&self) -> Option<u64> {
        let budget = self.time_budget.as_ref()?;
        let mut candidates: Vec<u64> = Vec::new();
        if let Some(deadline_ms) = budget.request_deadline_ms {
            let elapsed_ms = self.stream_started_at.elapsed().as_millis() as u64;
            candidates.push(deadline_ms.saturating_sub(elapsed_ms));
        }
        let idle_limit_ms = if self.received_first_byte {
            budget.idle_timeout_ms
        } else {
            budget.first_byte_timeout_ms
        };
        if let Some(idle_limit_ms) = idle_limit_ms {
            let elapsed_ms = self.last_byte_at.elapsed().as_millis() as u64;
            candidates.push(idle_limit_ms.saturating_sub(elapsed_ms));
        }
        candidates.into_iter().min()
    }

    fn push_envelopes(&mut self, raw_event: &crate::sse::SseEvent) {
        let decoded = decode_anthropic_sse_event(raw_event);
        for event in decoded.events {
            self.sequence += 1;
            if matches!(event, AnthropicStreamEvent::MessageStop) {
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
    /// AFTER observing its native terminal event (`message_stop`) --
    /// success. Returns `Err(_)` for any other end-of-iteration (parse
    /// failure, disconnect, cancellation, timeout, or a clean close with no
    /// terminal event ever seen) -- whatever envelopes were already
    /// returned via prior `Ok(Some(_))` calls stand as the partial result;
    /// nothing is synthesized or rolled back.
    #[allow(clippy::result_large_err)]
    pub async fn next_envelope(
        &mut self,
    ) -> Result<Option<MetaLlmStreamEnvelope<AnthropicStreamEvent>>, AgenticError> {
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
                    Err(_elapsed) => {
                        // Timed out waiting for a chunk. Loop back to the
                        // top: the precise checks above (using a fresh
                        // `Instant::now()`) determine and set `self.finished`
                        // to the correctly-coded error.
                        continue;
                    }
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

/// `POST /v1/messages` with `stream: true` (ADR-0024a §D5). Opens the
/// stream (performing the pre-byte credential/retry phase) and returns a
/// [`MessagesStream`] to pull events from.
#[allow(clippy::result_large_err)]
pub async fn messages_create_stream(
    client: &MetaLlmClient,
    request: &AnthropicMessageRequest,
    request_id: String,
    time_budget: Option<TimeBudget>,
    cancellation: Option<Arc<dyn CancellationToken>>,
) -> Result<MessagesStream, AgenticError> {
    let response = open_stream_with_pre_byte_retry(client, request, &request_id).await?;
    Ok(MessagesStream::new(
        response,
        request_id,
        time_budget,
        cancellation,
    ))
}
