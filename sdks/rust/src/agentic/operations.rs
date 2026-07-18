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

/// Common handle contract for remote batches, pods, and HarnessaaS jobs
/// (ADR-0023 §D9). `events` and `cancel` are only present in behavior when
/// the product capability set declares support (ADR-0019 §D6) — the
/// default `cancel` implementation fails closed with
/// [`UnsupportedCapabilityError`].
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
