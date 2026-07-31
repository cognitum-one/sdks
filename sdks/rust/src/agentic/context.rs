//! Shared per-call request context (ADR-0019 §D5) and budget policy
//! (ADR-0022 §D6). Type-only scaffolding — issue #52 / M1.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::agentic::credentials::CredentialProvider;
use crate::agentic::errors::{CancellationToken, TimeBudget};

/// How the SDK should treat an operation whose cost estimate is unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnUnknownEstimate {
    Reject,
    AllowServerEnforcement,
}

/// Client-side spend guard, not an accounting authority (ADR-0022 §D6).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetPolicy {
    pub on_unknown_estimate: OnUnknownEstimate,
    pub max_estimated_cost: Option<f64>,
    pub max_committed_cost: Option<f64>,
    pub currency: Option<String>,
    pub max_tier: Option<String>,
    pub allow_escalation: Option<bool>,
    pub reservation_ttl_ms: Option<u64>,
}

/// Resolved tenant binding for a request. Never a generic caller override
/// (ADR-0022 §D4).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TenantContext {
    pub tenant_id: Option<String>,
    pub delegated_subtenant_id: Option<String>,
}

/// Per-call request context shared across every agentic product client
/// (ADR-0019 §D5): identity, correlation, idempotency, budget, timeouts,
/// and cancellation. Product-specific fields (routing plane, safety mode,
/// solve input, etc.) do NOT belong here.
///
/// `Debug` is hand-implemented (rather than derived) because
/// `credential_provider` and `cancellation` are trait objects whose
/// concrete implementations may hold state that should not be printed
/// wholesale; this mirrors the ADR-0022 §D1 redaction posture even though
/// neither field is itself a secret.
#[derive(Clone)]
pub struct RequestContext {
    pub request_id: String,
    pub correlation_id: Option<String>,
    pub idempotency_key: Option<String>,
    pub tenant: Option<TenantContext>,
    pub normalized_origin: String,
    pub credential_provider: Option<Arc<dyn CredentialProvider>>,
    pub budget_policy: Option<BudgetPolicy>,
    pub time_budget: Option<TimeBudget>,
    pub cancellation: Option<Arc<dyn CancellationToken>>,
    /// Optional trace-context carrier (e.g. W3C `traceparent`/`tracestate`).
    pub tracing_carrier: Option<HashMap<String, String>>,
}

impl fmt::Debug for RequestContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RequestContext")
            .field("request_id", &self.request_id)
            .field("correlation_id", &self.correlation_id)
            .field("idempotency_key", &self.idempotency_key)
            .field("tenant", &self.tenant)
            .field("normalized_origin", &self.normalized_origin)
            .field(
                "credential_provider",
                &self.credential_provider.as_ref().map(|p| p.identity()),
            )
            .field("budget_policy", &self.budget_policy)
            .field("time_budget", &self.time_budget)
            .field("cancellation", &self.cancellation)
            .field("tracing_carrier", &self.tracing_carrier)
            .finish()
    }
}
