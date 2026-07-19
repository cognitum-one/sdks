//! OperationHandle / OperationState and transport-neutral pagination /
//! event-stream primitives (ADR-0019 §D5, ADR-0023 §D9), plus a shared
//! [`wait_for_operation`] polling-loop helper (ADR-0023 §D8/§D9, issue #55).
//!
//! The event-stream resumption behavior described in ADR-0023 §D6
//! (boundary-event dedup, gap/regression detection, `Last-Event-ID` replay)
//! deliberately does NOT ship here — every durable-operation client that
//! would consume it (HarnessaaS async jobs, Meta-LLM batches, Meta-Proxy
//! sponsor ops) is still blocked on its own upstream contract landing
//! (issues #59, #62, #68). Designing that resumption logic without a real
//! consumer to validate it against risks freezing the wrong contract — see
//! the M1 cross-language consistency review's fail-closed philosophy.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::agentic::errors::{
    equal_jitter_delay_ms, AgenticError, AgenticErrorKind, CancellationToken, RetryPolicy,
    UnsupportedCapabilityError,
};

/// Native lifecycle states for a durable remote operation (ADR-0023 §D9).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationState {
    Pending,
    Running,
    ApprovalRequired,
    Completed,
    Failed,
    Cancelled,
    CancellationRequested,
}

/// A point-in-time view of a durable operation, including terminal failures.
#[derive(Debug, Clone)]
pub struct OperationSnapshot<TResult> {
    pub id: String,
    pub state: OperationState,
    pub result: Option<TResult>,
    pub error: Option<AgenticError>,
    pub updated_at: String,
}

/// Options controlling [`OperationHandle::wait`].
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitOptions {
    pub wait_deadline_ms: Option<u64>,
    pub poll_interval_ms: Option<u64>,
}

/// Options controlling [`OperationHandle::events`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventStreamOptions {
    pub last_event_id: Option<String>,
    pub idle_timeout_ms: Option<u64>,
}

/// A single durable-operation event (ADR-0023 §D6).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationEvent<TPayload> {
    pub id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub sequence: Option<u64>,
    pub occurred_at: String,
    pub payload: TPayload,
}

/// Pull-based event stream returned by [`OperationHandle::events`]
/// (ADR-0023 §D6, FIX 1 of the M1 cross-language consistency review).
///
/// Mirrors the stateful `&mut self` async-trait pull pattern already
/// established by [`crate::mcp::Transport::recv`] (a `Box<dyn Transport>`
/// with an async `recv`/`send`/`close`) rather than adopting
/// `futures::Stream`/`tokio-stream`, so this dependency-light module
/// (ADR-0019 §D5) doesn't gain an unconditional streaming-crate dependency.
/// Equivalent to Node's `AsyncIterable<OperationEvent>` and Python's
/// `AsyncIterator[OperationEvent[Any]]`.
#[async_trait]
pub trait OperationEventStream: Send + Sync {
    /// Pull the next event. Returns `Ok(None)` once the stream is
    /// exhausted — a normal terminal state, not an error (mirrors
    /// `AsyncIterable`/`AsyncIterator` completion in Node/Python).
    async fn next(&mut self) -> Result<Option<OperationEvent<serde_json::Value>>, AgenticError>;
}

/// Common handle contract for remote batches, pods, and HarnessaaS jobs
/// (ADR-0023 §D9). `events` and `cancel` are only present in behavior when
/// the product capability set declares support (ADR-0019 §D6) — the
/// default `cancel` implementation fails closed with
/// [`UnsupportedCapabilityError`], and the default `events` implementation
/// returns `None` (equivalent to Node's optional `events?()` being absent
/// and Python's `events()` returning `None`).
#[async_trait]
pub trait OperationHandle: Send + Sync {
    type Result: Send + Sync;

    fn id(&self) -> &str;
    fn product(&self) -> &str;
    fn origin_binding(&self) -> &str;
    fn tenant_binding(&self) -> Option<&str>;
    fn created_at(&self) -> &str;

    async fn get(&self) -> Result<OperationSnapshot<Self::Result>, AgenticError>;
    async fn wait(
        &self,
        options: WaitOptions,
    ) -> Result<OperationSnapshot<Self::Result>, AgenticError>;

    /// Returns a pull-based event stream when this operation's product
    /// capability set declares event-stream support (ADR-0019 §D6);
    /// `None` when it doesn't. Equivalent to Node's optional
    /// `events?(options?): AsyncIterable<OperationEvent>` and Python's
    /// `events(self, options=None) -> AsyncIterator[OperationEvent[Any]] |
    /// None` (FIX 1 of the M1 cross-language consistency review — Rust
    /// previously had no equivalent method at all).
    fn events(&self, _options: EventStreamOptions) -> Option<Box<dyn OperationEventStream>> {
        None
    }

    /// Fails closed by default — a product implementation overrides this
    /// only once its capability set declares cancel support.
    async fn cancel(&self) -> Result<OperationSnapshot<Self::Result>, AgenticError> {
        Err(UnsupportedCapabilityError::new(self.product(), "cancel", "operation.cancel").into())
    }

    async fn result(&self) -> Result<Self::Result, AgenticError>;
}

/// Cursor-based page request, independent of transport (HTTP query, RPC
/// field, etc.).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRequest {
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

/// A single page of results.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

/// Minimal capability [`wait_for_operation`] needs — mirrors Node's
/// `Pick<OperationHandle, "get">` / Python's `_HasGet` protocol so a test
/// fake doesn't have to implement every [`OperationHandle`] method.
#[async_trait]
pub trait OperationSource: Send + Sync {
    type Result: Send + Sync;
    async fn get(&self) -> Result<OperationSnapshot<Self::Result>, AgenticError>;
}

#[async_trait]
impl<T: OperationHandle> OperationSource for T {
    type Result = T::Result;
    async fn get(&self) -> Result<OperationSnapshot<Self::Result>, AgenticError> {
        OperationHandle::get(self).await
    }
}

/// Snapshot states that end a [`wait_for_operation`] poll loop (ADR-0023
/// §D9). `ApprovalRequired` is included per D9's "Approval-required is a
/// state, not an exception" — polling further can't resolve it without
/// out-of-band human action, so it's returned like any other terminal
/// snapshot rather than awaited through.
fn is_wait_terminal(state: OperationState) -> bool {
    matches!(
        state,
        OperationState::Completed
            | OperationState::Failed
            | OperationState::Cancelled
            | OperationState::ApprovalRequired
    )
}

/// Extra knobs for [`wait_for_operation`] beyond [`WaitOptions`]'
/// `wait_deadline_ms`/`poll_interval_ms`.
#[derive(Default)]
pub struct WaitForOperationExtras<'a> {
    /// Retry/backoff shape for the poll cadence (ADR-0023 §D4). Defaults
    /// to [`RetryPolicy::default`].
    pub retry_policy: Option<&'a RetryPolicy>,
    /// Local-only cancellation (ADR-0023 §D7) — never sends a remote
    /// cancel.
    pub cancellation: Option<Arc<dyn CancellationToken>>,
    /// Caller-injected jitter per attempt (ADR-0023 §D4's fixed-seed
    /// conformance-fixture pattern). Defaults to zero jitter.
    pub jitter_ms: Option<&'a dyn Fn(u32) -> u64>,
}

/// Product-agnostic polling loop implementing [`OperationHandle::wait`]'s
/// shared semantics (ADR-0023 §D8/§D9): bounded equal-jitter backoff (the
/// exact algorithm ADR-0005/ADR-0023 already freeze — see
/// [`equal_jitter_delay_ms`]), a `wait_deadline_ms` ceiling that raises a
/// `DeadlineExceeded` error with the latest known state attached (never
/// marks the remote operation itself failed or cancelled), and early
/// return on any terminal state (including `ApprovalRequired`, per D9).
/// Poll iterations are bounded only by the wait deadline, not
/// `retry_policy.max_attempts` — that field governs a single HTTP
/// request's retry budget, a distinct concern from "keep checking a
/// long-running job" (D9: "not counted as retrying the operation itself").
///
/// A concrete [`OperationHandle`] implementation's own `wait()` method is
/// expected to delegate to this helper rather than re-implementing
/// backoff by hand — this is the "same bounded jitter policy" D9 requires
/// every product client to share.
///
/// `details` on the returned `DeadlineExceeded`/`Cancelled` errors carries
/// only a JSON-safe summary (`id`/`state`/`updated_at`) of the latest
/// snapshot, not the full `OperationSnapshot<S::Result>` — `AgenticError`'s
/// `details` field is `serde_json::Value`, and `S::Result` isn't
/// guaranteed `Serialize` for an unconstrained generic. The caller already
/// holds the handle it passed in, so resuming the wait doesn't require it
/// to be re-attached to the error.
pub async fn wait_for_operation<S: OperationSource>(
    source: &S,
    options: WaitOptions,
    extras: WaitForOperationExtras<'_>,
) -> Result<OperationSnapshot<S::Result>, AgenticError> {
    let default_policy = RetryPolicy::default();
    let policy = extras.retry_policy.unwrap_or(&default_policy);
    let poll_policy = match options.poll_interval_ms {
        Some(base_ms) => RetryPolicy {
            base_ms,
            ..*policy
        },
        None => *policy,
    };
    let jitter_ms = extras.jitter_ms.unwrap_or(&|_attempt| 0);

    let started = tokio::time::Instant::now();
    let mut attempt: u32 = 0;
    let mut last_summary: Option<serde_json::Value> = None;

    loop {
        if let Some(cancellation) = &extras.cancellation {
            if cancellation.is_cancelled() {
                return Err(AgenticError {
                    details: last_summary.map(|s| serde_json::json!({ "snapshot": s })),
                    ..AgenticError::new(AgenticErrorKind::Cancelled, "wait_for_operation cancelled locally")
                });
            }
        }

        let snapshot = match source.get().await {
            Ok(snapshot) => snapshot,
            Err(cause) if cause.retryable => {
                // Poll transient failures consume the wait budget, not the
                // request's own HTTP retry budget (D9) — a non-retryable
                // failure propagates immediately below; a retryable one
                // falls through to the same backoff loop bounded by
                // wait_deadline_ms, without fabricating a snapshot.
                let delay_ms = equal_jitter_delay_ms(attempt, &poll_policy, 0, jitter_ms(attempt));
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                attempt += 1;
                continue;
            }
            Err(cause) => return Err(cause),
        };
        last_summary = Some(serde_json::json!({
            "id": snapshot.id,
            "state": snapshot.state,
            "updated_at": snapshot.updated_at,
        }));

        if is_wait_terminal(snapshot.state) {
            return Ok(snapshot);
        }

        if let Some(wait_deadline_ms) = options.wait_deadline_ms {
            if started.elapsed().as_millis() as u64 >= wait_deadline_ms {
                return Err(AgenticError {
                    details: last_summary.map(|s| serde_json::json!({ "snapshot": s })),
                    ..AgenticError::new(
                        AgenticErrorKind::DeadlineExceeded,
                        format!(
                            "wait_for_operation exceeded wait_deadline_ms={wait_deadline_ms} without reaching a terminal state"
                        ),
                    )
                });
            }
        }

        let delay_ms = equal_jitter_delay_ms(attempt, &poll_policy, 0, jitter_ms(attempt));
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        attempt += 1;
    }
}
