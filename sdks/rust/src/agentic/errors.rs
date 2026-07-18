//! Shared agentic error taxonomy and retry classification (ADR-0023 §D1, §D3).
//! Type-only scaffolding — issue #52 / M1. No retry loop implementation
//! ships here; concrete HTTP mapping lands with each product client.

use std::fmt;

use serde::{Deserialize, Serialize};

/// Agentic extension of the ADR-0004 base error kind enumeration
/// (ADR-0023 §D1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum AgenticErrorKind {
    Configuration,
    Authentication,
    PermissionDenied,
    NotFound,
    Validation,
    Conflict,
    RateLimited,
    BudgetExceeded,
    SafetyBlocked,
    ConsentRequired,
    UnsupportedCapability,
    Protocol,
    Integrity,
    IsolationUnavailable,
    Transport,
    DeadlineExceeded,
    Cancelled,
    ProcessFailed,
    OperationFailed,
    Unknown,
}

/// Operation retry classification (ADR-0023 §D3). A status code alone is
/// never sufficient to decide retry safety.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationRetryClass {
    SafeRead,
    IdempotentMutation,
    IdempotentWithKey,
    NonIdempotent,
    Streaming,
    LocalProcess,
}

/// Common failure shape shared by every agentic product (ADR-0023 §D1).
///
/// `message`, `details`, and `cause` MUST be redacted by the caller before
/// this type is constructed for exposure — this base type does not perform
/// redaction itself (see [`crate::agentic::credentials::SecretRedactor`]
/// for that contract).
///
/// `#[non_exhaustive]` per ADR-0023 §D1: Rust error enums/variants MUST be
/// future-proof before release.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{kind:?}: {message}")]
#[non_exhaustive]
pub struct AgenticError {
    pub kind: AgenticErrorKind,
    pub message: String,
    pub product: Option<String>,
    pub operation: Option<String>,
    pub status: Option<u16>,
    pub code: Option<String>,
    pub request_id: Option<String>,
    pub correlation_id: Option<String>,
    pub protocol_version: Option<String>,
    pub retryable: bool,
    pub retry_after_ms: Option<u64>,
    pub attempt_count: Option<u32>,
    pub details: Option<serde_json::Value>,
    /// Redacted string representation of the underlying cause, if any.
    /// Not a `Box<dyn Error>` chain — keeping this type-only avoids forcing
    /// every product's transport error into one trait-object shape before
    /// the product clients exist.
    pub cause: Option<String>,
}

impl AgenticError {
    /// Construct a minimal [`AgenticError`] with only the required fields set.
    pub fn new(kind: AgenticErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            product: None,
            operation: None,
            status: None,
            code: None,
            request_id: None,
            correlation_id: None,
            protocol_version: None,
            retryable: false,
            retry_after_ms: None,
            attempt_count: None,
            details: None,
            cause: None,
        }
    }
}

/// Fail-closed error raised when a required capability is absent or unknown
/// (ADR-0019 §D6). MUST be raised before any spend, mutation, consent, or
/// code-execution side effect.
///
/// Node and Python model this as a subclass of their base agentic error
/// (`UnsupportedCapabilityError extends AgenticError` /
/// `class UnsupportedCapabilityError(AgenticError)`). Rust has no class
/// inheritance, so this is a separate struct with a `From<UnsupportedCapabilityError>
/// for AgenticError` conversion below — the Rust-idiomatic equivalent of
/// that "is-a" relationship, not an oversight.
#[derive(Debug, Clone, thiserror::Error)]
#[error("capability \"{capability}\" is unsupported or unknown for {product}/{operation}")]
pub struct UnsupportedCapabilityError {
    pub product: String,
    pub operation: String,
    pub capability: String,
}

impl UnsupportedCapabilityError {
    pub fn new(
        product: impl Into<String>,
        operation: impl Into<String>,
        capability: impl Into<String>,
    ) -> Self {
        Self {
            product: product.into(),
            operation: operation.into(),
            capability: capability.into(),
        }
    }
}

impl From<UnsupportedCapabilityError> for AgenticError {
    fn from(e: UnsupportedCapabilityError) -> Self {
        let message = e.to_string();
        AgenticError {
            kind: AgenticErrorKind::UnsupportedCapability,
            message,
            product: Some(e.product),
            operation: Some(e.operation),
            retryable: false,
            status: None,
            code: None,
            request_id: None,
            correlation_id: None,
            protocol_version: None,
            retry_after_ms: None,
            attempt_count: None,
            details: None,
            cause: None,
        }
    }
}

/// Retry-policy shape (ADR-0023 §D4). Values MUST match ADR-0005's
/// equal-jitter formula verbatim; agentic modules MUST NOT diverge from it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryPolicy {
    pub base_ms: u64,
    pub cap_ms: u64,
    pub max_attempts: u32,
    pub retry_sleep_budget_ms: u64,
}

impl Default for RetryPolicy {
    /// Canonical defaults: 500 ms base, 30 s cap, 4 total attempts, 60 s
    /// sleep budget.
    fn default() -> Self {
        Self {
            base_ms: 500,
            cap_ms: 30_000,
            max_attempts: 4,
            retry_sleep_budget_ms: 60_000,
        }
    }
}

/// Pure equal-jitter backoff calculation, ADR-0005/ADR-0023 verbatim:
///
/// ```text
/// delay_ms(attempt) = min(cap_ms, max(server_hint_ms, base_ms * 2**attempt + jitter))
/// ```
///
/// `jitter_ms` is caller-injected (rather than internally randomized) so
/// cross-language conformance fixtures can assert exact values with a fixed
/// seed, per ADR-0023's compliance note on injected clocks/randomness.
pub fn equal_jitter_delay_ms(
    attempt: u32,
    policy: &RetryPolicy,
    server_hint_ms: u64,
    jitter_ms: u64,
) -> u64 {
    let expo = policy.base_ms.saturating_mul(1u64 << attempt.min(32));
    let clamped_jitter = jitter_ms.min(policy.base_ms);
    let computed = expo.saturating_add(clamped_jitter);
    let floor = server_hint_ms.max(computed);
    floor.min(policy.cap_ms)
}

/// Idempotency-key binding contract (ADR-0023 §D5).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdempotencyBindingV1 {
    pub authenticated_principal: String,
    #[serde(default)]
    pub tenant_context: Option<String>,
    #[serde(default)]
    pub delegated_subtenant_context: Option<String>,
    pub http_method: String,
    pub normalized_route_identity: String,
    pub canonical_request_sha256: String,
    pub idempotency_key: String,
    pub contract_major: u32,
}

/// Why a [`CancellationToken`] was cancelled (ADR-0023 §D7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancellationReason {
    Caller,
    Deadline,
    Shutdown,
}

/// Transport-neutral cancellation contract. Distinct from "cancel remote
/// operation" and "terminate local process" — see
/// [`crate::agentic::operations::OperationHandle`].
pub trait CancellationToken: fmt::Debug + Send + Sync {
    fn is_cancelled(&self) -> bool;
    fn reason(&self) -> Option<CancellationReason>;
}

/// A [`CancellationToken`] that is never cancelled — the default when no
/// cancellation source is wired up.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopCancellationToken;

impl CancellationToken for NoopCancellationToken {
    fn is_cancelled(&self) -> bool {
        false
    }

    fn reason(&self) -> Option<CancellationReason> {
        None
    }
}

/// Time-budget model (ADR-0023 §D8). Timeouts are separate values, never
/// one shared 30s default for streaming, inference, and long-running
/// operations.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeBudget {
    pub connect_timeout_ms: Option<u64>,
    pub first_byte_timeout_ms: Option<u64>,
    pub idle_timeout_ms: Option<u64>,
    pub request_deadline_ms: Option<u64>,
    pub wait_deadline_ms: Option<u64>,
    pub cancel_grace_ms: Option<u64>,
    pub retry_sleep_budget_ms: Option<u64>,
}
