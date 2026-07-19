//! `MetaHarnessClient` construction and configuration (ADR-0026a §D1, §D3).
//!
//! Type-only scaffolding plus construction-time validation for issue #64 /
//! M4 start. Construction performs NO I/O — it "resolves configuration
//! only. [It performs] no npm access, process spawn, repository read,
//! filesystem write, capability probe, login, or prompt" (§D1). See
//! `super::client` for the fail-closed method stubs this pass ships
//! instead of any real bridge call.
//!
//! Mirrors `crate::meta_proxy::config`'s construction conventions exactly:
//! a resolved config struct and the same telemetry-hook shape. Unlike Meta
//! Proxy, there is no HTTP loopback origin here at all — the bridge is a
//! child process over stdio (ADR-0026a §D4) — so there is nothing
//! analogous to `origin` to default or validate. The §D1/§D10 "zero I/O"
//! requirement this module upholds instead is structural: `resolve_config`
//! only reads and defaults plain fields, never touching npm, a process, or
//! a filesystem path.
//!
//! §D3's `distribution`, `workspace_policy`, `process_policy`, and
//! `diagnostic_policy` sub-shapes are owned by ADR-0026b (process,
//! filesystem, and npm/npx supply chain) — that ADR is explicitly out of
//! scope for this pass (§D7 blocker #1: "reviewed 0.4.1 is not published at
//! the registry state"), so they are typed here as opaque `serde_json::Value`
//! maps rather than guessed at in detail.

use std::fmt;
use std::sync::Arc;

use serde_json::Value;

use crate::agentic::{AgenticError, AgenticErrorKind};

/// Default warm-bridge-handshake budget — matches §D4's default parser
/// limit table exactly.
pub const DEFAULT_HANDSHAKE_TIMEOUT_MS: u64 = 2_000;

/// A single telemetry observation emitted around one MetaHarnessClient operation.
#[derive(Debug, Clone)]
pub struct MetaHarnessTelemetryEvent {
    pub operation: String,
    pub request_id: String,
    pub duration_ms: Option<u64>,
}

/// Caller-supplied telemetry hooks (ADR-0028), matching
/// `crate::meta_proxy::config::MetaProxyTelemetryHooks`'s convention. Hooks
/// MUST NOT receive secrets. Default no-op methods so implementors override
/// only what they need.
pub trait MetaHarnessTelemetryHooks: fmt::Debug + Send + Sync {
    fn on_request_start(&self, _operation: &str, _request_id: &str) {}
    fn on_request_end(&self, _event: &MetaHarnessTelemetryEvent) {}
}

/// Construction config for [`super::client::MetaHarnessClient`] (ADR-0026a §D3).
///
/// Every field is resolved with zero I/O (§D1). None of `distribution`,
/// `workspace_policy`, or `process_policy` is read from disk, npm, or the
/// environment here — they are plain caller-supplied values, held as-is.
#[derive(Clone)]
pub struct MetaHarnessConfig {
    /// Locked OSS distribution identity (ADR-0026b, out of scope here).
    /// Opaque — its exact shape (registry, version pin, digest, Node
    /// version range, etc.) belongs to ADR-0026b's distribution manager,
    /// which cannot exist yet (ADR-0026a §D7 blocker #1).
    pub distribution: Option<Value>,
    /// Workspace containment policy (ADR-0026b, out of scope here).
    pub workspace_policy: Option<Value>,
    /// Child-process containment policy (ADR-0026b, out of scope here).
    pub process_policy: Option<Value>,
    /// Milliseconds. Budget for locating/validating the locked distribution
    /// before bridge acquisition (ADR-0026b).
    pub acquisition_timeout_ms: Option<u64>,
    /// Milliseconds. Defaults to [`DEFAULT_HANDSHAKE_TIMEOUT_MS`] (2000),
    /// matching §D4's "Warm bridge handshake | 2 seconds" default parser limit.
    pub handshake_timeout_ms: u64,
    /// Milliseconds. Per-operation budget once a bridge protocol exists (§D4).
    pub operation_timeout_ms: Option<u64>,
    /// Diagnostic redaction/retention policy (ADR-0026a §D5, ADR-0028).
    /// Opaque — the exact shape is bridge-defined and not yet published.
    pub diagnostic_policy: Option<Value>,
    /// Feature-flagged preview capabilities this caller opts into
    /// (ADR-0026a §D7: "a released SDK may offer only a feature-flagged,
    /// read-only development preview with the exact verified
    /// distribution"). Opting in to a name here never grants an operation
    /// that is otherwise blocked — every §D2 method still fails closed
    /// until its upstream capability exists.
    pub preview_features: Vec<String>,
    pub telemetry: Option<Arc<dyn MetaHarnessTelemetryHooks>>,
}

impl fmt::Debug for MetaHarnessConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MetaHarnessConfig")
            .field("distribution", &self.distribution)
            .field("workspace_policy", &self.workspace_policy)
            .field("process_policy", &self.process_policy)
            .field("acquisition_timeout_ms", &self.acquisition_timeout_ms)
            .field("handshake_timeout_ms", &self.handshake_timeout_ms)
            .field("operation_timeout_ms", &self.operation_timeout_ms)
            .field("diagnostic_policy", &self.diagnostic_policy)
            .field("preview_features", &self.preview_features)
            .finish_non_exhaustive()
    }
}

impl Default for MetaHarnessConfig {
    fn default() -> Self {
        Self {
            distribution: None,
            workspace_policy: None,
            process_policy: None,
            acquisition_timeout_ms: None,
            handshake_timeout_ms: DEFAULT_HANDSHAKE_TIMEOUT_MS,
            operation_timeout_ms: None,
            diagnostic_policy: None,
            preview_features: Vec::new(),
            telemetry: None,
        }
    }
}

impl MetaHarnessConfig {
    /// Config with every field at its documented default.
    pub fn new() -> Self {
        Self::default()
    }
}

/// Validate a [`MetaHarnessConfig`]. Pure function, no I/O — construction
/// MUST stay side-effect free (ADR-0026a §D1: "Constructors resolve
/// configuration only. They perform no npm access, process spawn,
/// repository read, filesystem write, capability probe, login, or prompt.").
#[allow(clippy::result_large_err)]
pub(crate) fn resolve_config(config: MetaHarnessConfig) -> Result<MetaHarnessConfig, AgenticError> {
    if config.handshake_timeout_ms == 0 {
        return Err(AgenticError::new(
            AgenticErrorKind::Configuration,
            "MetaHarnessConfig.handshake_timeout_ms must be a positive number",
        ));
    }
    if config.acquisition_timeout_ms == Some(0) {
        return Err(AgenticError::new(
            AgenticErrorKind::Configuration,
            "MetaHarnessConfig.acquisition_timeout_ms must be a positive number",
        ));
    }
    if config.operation_timeout_ms == Some(0) {
        return Err(AgenticError::new(
            AgenticErrorKind::Configuration,
            "MetaHarnessConfig.operation_timeout_ms must be a positive number",
        ));
    }
    Ok(config)
}
