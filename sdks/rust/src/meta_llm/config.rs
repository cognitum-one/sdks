//! MetaLlmClient construction and deployment ownership (ADR-0024a §D1).
//!
//! Type-only scaffolding plus construction-time validation for issue #58 /
//! M2. Construction performs NO I/O — see `super::client` for the first
//! real HTTP-backed operations (`health`, `whoami`, `models`).

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::agentic::{
    AgenticError, AgenticErrorKind, BudgetPolicy, CapabilitySet, CredentialProvider, RequestContext,
};

/// ADR-0024b product-specific routing controls. Frozen as an opaque
/// placeholder here — the concrete shape lands with issue #59 (ADR-0024b:
/// Meta LLM platform resources, routing, and usage).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MetaLlmRoutingControls(pub HashMap<String, serde_json::Value>);

/// ADR-0024b product-specific safety control. See
/// [`MetaLlmRoutingControls`] for the same issue #59 deferral note.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MetaLlmSafetyControl(pub HashMap<String, serde_json::Value>);

/// A single telemetry observation emitted around one MetaLlmClient operation.
#[derive(Debug, Clone)]
pub struct MetaLlmTelemetryEvent {
    pub operation: String,
    pub request_id: String,
    pub http_status: Option<u16>,
    pub duration_ms: Option<u64>,
    pub retry_after_ms: Option<u64>,
    pub idempotent_replay: Option<bool>,
}

/// Caller-supplied telemetry hooks (ADR-0028). Deliberately minimal in this
/// pass — no cost/usage aggregation, no drift detection wiring yet. Hooks
/// MUST NOT receive secrets; callers wire redaction via `SecretRedactor`
/// from `crate::agentic` before logging anything derived from these events.
/// Default no-op methods so implementors override only what they need.
pub trait MetaLlmTelemetryHooks: fmt::Debug + Send + Sync {
    fn on_request_start(&self, _operation: &str, _request_id: &str) {}
    fn on_request_end(&self, _event: &MetaLlmTelemetryEvent) {}
}

/// Construction config for [`super::client::MetaLlmClient`] (ADR-0024a §D1).
#[derive(Clone)]
pub struct MetaLlmClientConfig {
    /// Explicit HTTPS origin. A production URL becomes a default only after
    /// publication in the contract bundle (ADR-0024a §D1) — there is no
    /// built-in default here, unlike the root `Client`.
    pub base_url: String,
    /// Opt out of the HTTPS-origin requirement for local development and
    /// tests only (e.g. a local mock server). Never set this against a real
    /// deployment.
    pub allow_insecure_http: bool,
    pub credential_provider: Option<Arc<dyn CredentialProvider>>,
    /// Injectable `reqwest::Client`, for tests. Defaults to a fresh client.
    pub transport: Option<reqwest::Client>,
    pub default_request_context: Option<RequestContext>,
    pub default_routing_controls: Option<MetaLlmRoutingControls>,
    pub default_safety_control: Option<MetaLlmSafetyControl>,
    pub budget_policy: Option<BudgetPolicy>,
    /// Static compatibility-table entry consulted by `capabilities()` until
    /// a runtime capabilities endpoint is published (ADR-0024a §D9 gate #3).
    pub capabilities_snapshot: Option<CapabilitySet>,
    pub telemetry: Option<Arc<dyn MetaLlmTelemetryHooks>>,
}

impl fmt::Debug for MetaLlmClientConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MetaLlmClientConfig")
            .field("base_url", &self.base_url)
            .field("allow_insecure_http", &self.allow_insecure_http)
            .field(
                "credential_provider",
                &self.credential_provider.as_ref().map(|p| p.identity()),
            )
            .field("default_request_context", &self.default_request_context)
            .field("budget_policy", &self.budget_policy)
            .field("capabilities_snapshot", &self.capabilities_snapshot)
            .finish_non_exhaustive()
    }
}

impl MetaLlmClientConfig {
    /// Minimal config with only the required `base_url` set.
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            allow_insecure_http: false,
            credential_provider: None,
            transport: None,
            default_request_context: None,
            default_routing_controls: None,
            default_safety_control: None,
            budget_policy: None,
            capabilities_snapshot: None,
            telemetry: None,
        }
    }
}

/// Validate and normalize a [`MetaLlmClientConfig`]. Pure function, no I/O —
/// construction MUST stay side-effect free (ADR-0024a §D1, ADR-0019 §D3).
#[allow(clippy::result_large_err)]
pub(crate) fn resolve_config(
    config: MetaLlmClientConfig,
) -> Result<MetaLlmClientConfig, AgenticError> {
    if config.base_url.is_empty() {
        return Err(AgenticError::new(
            AgenticErrorKind::Configuration,
            "MetaLlmClientConfig.base_url is required",
        ));
    }
    let trimmed = config.base_url.trim_end_matches('/').to_owned();
    let is_https = trimmed.to_ascii_lowercase().starts_with("https://");
    if !is_https && !config.allow_insecure_http {
        return Err(AgenticError::new(
            AgenticErrorKind::Configuration,
            format!(
                "MetaLlmClientConfig.base_url must be an explicit HTTPS origin \
                 (ADR-0024a §D1); got \"{}\". Set allow_insecure_http: true for \
                 local development only.",
                config.base_url
            ),
        ));
    }
    Ok(MetaLlmClientConfig {
        base_url: trimmed,
        ..config
    })
}
