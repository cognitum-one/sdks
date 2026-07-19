//! `HarnessaaSClient` construction and deployment ownership (ADR-0027a,
//! ADR-0019 §D1). Issue #67/#68 / M5 start.
//!
//! Type-only scaffolding plus construction-time validation. Construction
//! performs NO I/O — see `super::client` for the real HTTP-backed
//! operations (`health`, `solve`, `lineage`).

use std::fmt;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::agentic::{AgenticError, AgenticErrorKind, BudgetPolicy, CapabilitySet, CredentialProvider, RequestContext};

/// A single telemetry observation emitted around one HarnessaaSClient operation.
#[derive(Debug, Clone)]
pub struct HarnessaaSTelemetryEvent {
    pub operation: String,
    pub request_id: String,
    pub http_status: Option<u16>,
    pub duration_ms: Option<u64>,
    pub retry_after_ms: Option<u64>,
}

/// Caller-supplied telemetry hooks (ADR-0028). Hooks MUST NOT receive
/// secrets; callers wire redaction via `SecretRedactor` from
/// `crate::agentic` before logging anything derived from these events.
/// Default no-op methods so implementors override only what they need.
pub trait HarnessaaSTelemetryHooks: fmt::Debug + Send + Sync {
    fn on_request_start(&self, _operation: &str, _request_id: &str) {}
    fn on_request_end(&self, _event: &HarnessaaSTelemetryEvent) {}
}

/// Construction config for [`super::client::HarnessaaSClient`] (ADR-0027a, ADR-0019 §D1).
#[derive(Clone)]
pub struct HarnessaaSClientConfig {
    /// Explicit HTTPS origin. No built-in default here — no contract
    /// bundle is published for HarnessaaS yet (ADR-0027a §D11 blocker #1).
    pub base_url: String,
    /// Opt out of the HTTPS-origin requirement for local development and
    /// tests only. Never set this against a real deployment.
    pub allow_insecure_http: bool,
    pub credential_provider: Option<Arc<dyn CredentialProvider>>,
    /// Injectable `reqwest::Client`, for tests. Defaults to a fresh client.
    pub transport: Option<reqwest::Client>,
    pub default_request_context: Option<RequestContext>,
    pub budget_policy: Option<BudgetPolicy>,
    /// Static compatibility-table entry consulted by `capabilities()`. No
    /// runtime capabilities endpoint is published for HarnessaaS yet.
    pub capabilities_snapshot: Option<CapabilitySet>,
    pub telemetry: Option<Arc<dyn HarnessaaSTelemetryHooks>>,
}

impl fmt::Debug for HarnessaaSClientConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HarnessaaSClientConfig")
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

impl HarnessaaSClientConfig {
    /// Minimal config with only the required `base_url` set.
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            allow_insecure_http: false,
            credential_provider: None,
            transport: None,
            default_request_context: None,
            budget_policy: None,
            capabilities_snapshot: None,
            telemetry: None,
        }
    }
}

/// One-shot latch so the `allow_insecure_http` escape hatch only ever
/// warns once per process, matching `meta_llm::config`'s identical pattern.
static INSECURE_HTTP_WARNED: AtomicBool = AtomicBool::new(false);

/// Best-effort extraction of the host (no scheme, no port, no path) from an
/// already-trimmed `scheme://host[:port][/path]` URL. Deliberately does not
/// pull in the optional `url` crate (not available under the `harnessaas`
/// feature) — this is a literal-string check, not general URL parsing.
fn extract_host(url: &str) -> Option<&str> {
    let after_scheme = url.split_once("://")?.1;
    let host_port = after_scheme.split('/').next().unwrap_or(after_scheme);
    if let Some(rest) = host_port.strip_prefix('[') {
        // IPv6 literal, e.g. "[::1]:8443".
        return rest.split(']').next();
    }
    Some(host_port.split(':').next().unwrap_or(host_port))
}

/// `true` only for a literal IPv4/IPv6 loopback address. Hostname
/// resolution (e.g. "localhost") is deliberately excluded — ADR-0022 §D3.
fn is_loopback_host(host: &str) -> bool {
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return ip.is_loopback();
    }
    if let Ok(ip) = host.parse::<Ipv6Addr>() {
        return ip.is_loopback();
    }
    false
}

fn warn_insecure_http_once(base_url: &str) {
    if !INSECURE_HTTP_WARNED.swap(true, Ordering::Relaxed) {
        eprintln!(
            "cognitum-rs harnessaas: HTTP (non-TLS) transport is ENABLED via \
             allow_insecure_http for loopback base_url \"{base_url}\". Never use \
             this in production — see ADR-0022 §D3."
        );
    }
}

/// Validate and normalize a [`HarnessaaSClientConfig`]. Pure function, no
/// I/O — construction MUST stay side-effect free (ADR-0019 §D3).
#[allow(clippy::result_large_err)]
pub(crate) fn resolve_config(
    config: HarnessaaSClientConfig,
) -> Result<HarnessaaSClientConfig, AgenticError> {
    if config.base_url.is_empty() {
        return Err(AgenticError::new(
            AgenticErrorKind::Configuration,
            "HarnessaaSClientConfig.base_url is required",
        ));
    }
    let trimmed = config.base_url.trim_end_matches('/').to_owned();
    let is_https = trimmed.to_ascii_lowercase().starts_with("https://");
    if !is_https {
        if !config.allow_insecure_http {
            return Err(AgenticError::new(
                AgenticErrorKind::Configuration,
                format!(
                    "HarnessaaSClientConfig.base_url must be an explicit HTTPS origin \
                     (ADR-0027a); got \"{}\". Set allow_insecure_http: true for local \
                     development only.",
                    config.base_url
                ),
            ));
        }
        // ADR-0022 §D3: disabling TLS is allowed only for loopback
        // development, emits a local warning hook, and cannot be enabled
        // through a generic environment variable in production builds.
        let host = extract_host(&trimmed).unwrap_or("");
        if !is_loopback_host(host) {
            return Err(AgenticError::new(
                AgenticErrorKind::Configuration,
                format!(
                    "HarnessaaSClientConfig.allow_insecure_http is only permitted for \
                     literal IPv4/IPv6 loopback base URLs (ADR-0022 §D3); got \"{}\". \
                     Hostname resolution to loopback (e.g. \"localhost\") is \
                     insufficient.",
                    config.base_url
                ),
            ));
        }
        warn_insecure_http_once(&trimmed);
    }
    Ok(HarnessaaSClientConfig {
        base_url: trimmed,
        ..config
    })
}
