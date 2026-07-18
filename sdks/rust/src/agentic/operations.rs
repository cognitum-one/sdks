//! OperationHandle / OperationState and transport-neutral pagination /
//! event-stream primitives (ADR-0019 §D5, ADR-0023 §D9). Type-only
//! scaffolding — issue #52 / M1. No polling loop or event-stream
//! implementation ships in this pass.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::agentic::errors::{AgenticError, UnsupportedCapabilityError};

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
