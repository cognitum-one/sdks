//! `MetaProxyClient` construction and deployment ownership (ADR-0025a §D3).
//!
//! Type-only scaffolding plus construction-time validation for issue #61 /
//! M3 start. Construction performs NO I/O — see `super::client` for the
//! first real HTTP-backed operations (`status`, `capabilities`).
//!
//! Unlike `crate::meta_llm`'s client (ADR-0024a), which talks directly to
//! Cognitum's cloud service and therefore requires an explicit HTTPS origin
//! with no built-in default, `MetaProxyClient` talks to an ALREADY-RUNNING
//! local Meta Proxy sidecar process. Per ADR-0025a's Context section, the
//! Rust foreground binary "binds to `127.0.0.1:11435` by default" — so
//! this client's `origin` defaults to that literal loopback address, and
//! literal loopback is the only origin considered safe by default
//! (ADR-0025a §D10: "Literal loopback is the only stable origin"). This
//! module does NOT install, start, or reconfigure that process — see
//! ADR-0025b's `MetaProxyManager` for that (owned separately, and
//! independent of this client per §D1's decision).

use std::fmt;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::agentic::{
    AgenticError, AgenticErrorKind, BudgetPolicy, CapabilitySet, CredentialProvider, RequestContext,
};

/// Default loopback origin — matches the Rust proxy binary's default bind
/// (ADR-0025a Context).
pub const DEFAULT_META_PROXY_ORIGIN: &str = "http://127.0.0.1:11435";

/// A single telemetry observation emitted around one MetaProxyClient operation.
#[derive(Debug, Clone)]
pub struct MetaProxyTelemetryEvent {
    pub operation: String,
    pub request_id: String,
    pub http_status: Option<u16>,
    pub duration_ms: Option<u64>,
    pub retry_after_ms: Option<u64>,
}

/// Caller-supplied telemetry hooks (ADR-0028), matching
/// `crate::meta_llm::config::MetaLlmTelemetryHooks`'s convention. Hooks
/// MUST NOT receive secrets. Default no-op methods so implementors override
/// only what they need.
pub trait MetaProxyTelemetryHooks: fmt::Debug + Send + Sync {
    fn on_request_start(&self, _operation: &str, _request_id: &str) {}
    fn on_request_end(&self, _event: &MetaProxyTelemetryEvent) {}
}

/// Construction config for [`super::client::MetaProxyClient`] (ADR-0025a §D3).
///
/// D6 (authentication and workload capabilities) is explicitly deferred —
/// this pass accepts only the same shared `CredentialProvider` trait
/// (ADR-0022) that `MetaLlmClient` uses, standing in for D3's
/// `local_credential_provider` field. `ProxyCredential`'s
/// `LocalBearerToken | WorkloadCapability` discriminated union and
/// capability minting via an injected `MetaProxyLifecycleProvider` are
/// follow-up work (§D6, ADR-0025b, ADR-0026a).
#[derive(Clone)]
pub struct MetaProxyClientConfig {
    /// Loopback origin for the already-running Meta Proxy sidecar. Defaults
    /// to [`DEFAULT_META_PROXY_ORIGIN`] when omitted (ADR-0025a §D3, Context).
    pub origin: String,
    /// Opt out of the loopback-only requirement. Dangerous preview per
    /// ADR-0025a §D10 — never set this against a real deployment.
    pub allow_non_loopback: bool,
    /// Local credential provider (ADR-0025a §D3: "It receives its local
    /// credential from the typed provider in ADR-0022"). Required for
    /// `status()`/`capabilities()` — the Proxy's `/status` route is
    /// authenticated (ADR-0025a Context).
    pub local_credential_provider: Option<Arc<dyn CredentialProvider>>,
    /// Injectable `reqwest::Client`, for tests. Defaults to a fresh client.
    pub transport: Option<reqwest::Client>,
    pub default_request_context: Option<RequestContext>,
    pub budget_policy: Option<BudgetPolicy>,
    /// Expected Proxy product version, checked against `MetaProxyStatus`'s
    /// `compatible_sdk_range`/`product_version` (ADR-0025a §D2). A
    /// mismatch surfaces as a `MetaProxyResponseMeta.warnings` entry
    /// rather than a hard failure.
    pub expected_proxy_version: Option<String>,
    /// Static compatibility-table entry consulted by `capabilities()`
    /// alongside the real `/status` call (ADR-0025a §D4).
    pub capabilities_snapshot: Option<CapabilitySet>,
    pub telemetry: Option<Arc<dyn MetaProxyTelemetryHooks>>,
}

impl fmt::Debug for MetaProxyClientConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MetaProxyClientConfig")
            .field("origin", &self.origin)
            .field("allow_non_loopback", &self.allow_non_loopback)
            .field(
                "local_credential_provider",
                &self.local_credential_provider.as_ref().map(|p| p.identity()),
            )
            .field("default_request_context", &self.default_request_context)
            .field("budget_policy", &self.budget_policy)
            .field("expected_proxy_version", &self.expected_proxy_version)
            .field("capabilities_snapshot", &self.capabilities_snapshot)
            .finish_non_exhaustive()
    }
}

impl Default for MetaProxyClientConfig {
    fn default() -> Self {
        Self {
            origin: DEFAULT_META_PROXY_ORIGIN.to_owned(),
            allow_non_loopback: false,
            local_credential_provider: None,
            transport: None,
            default_request_context: None,
            budget_policy: None,
            expected_proxy_version: None,
            capabilities_snapshot: None,
            telemetry: None,
        }
    }
}

impl MetaProxyClientConfig {
    /// Config pointed at the documented default loopback origin.
    pub fn new() -> Self {
        Self::default()
    }

    /// Config pointed at an explicit origin (still validated as loopback
    /// unless `allow_non_loopback` is subsequently set).
    pub fn with_origin(origin: impl Into<String>) -> Self {
        Self {
            origin: origin.into(),
            ..Self::default()
        }
    }
}

/// One-shot latch so the `allow_non_loopback` escape hatch only ever warns
/// once per process, matching `crate::meta_llm::config`'s
/// `INSECURE_HTTP_WARNED` pattern.
static NON_LOOPBACK_WARNED: AtomicBool = AtomicBool::new(false);

/// Best-effort extraction of the host (no scheme, no port, no path) from an
/// already-trimmed `scheme://host[:port][/path]` URL. Deliberately does not
/// pull in the optional `url` crate (not available under the `meta-proxy`
/// feature) — this is a literal-string check, not general URL parsing.
fn extract_host(url: &str) -> Option<&str> {
    let after_scheme = url.split_once("://")?.1;
    let host_port = after_scheme.split('/').next().unwrap_or(after_scheme);
    if let Some(rest) = host_port.strip_prefix('[') {
        // IPv6 literal, e.g. "[::1]:11435".
        return rest.split(']').next();
    }
    Some(host_port.split(':').next().unwrap_or(host_port))
}

/// `true` only for a literal IPv4/IPv6 loopback address. Hostname
/// resolution (e.g. "localhost") is deliberately excluded — ADR-0025a §D10:
/// "Hostnames resolving to loopback are insufficient in default-safe mode."
fn is_loopback_host(host: &str) -> bool {
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return ip.is_loopback();
    }
    if let Ok(ip) = host.parse::<Ipv6Addr>() {
        return ip.is_loopback();
    }
    false
}

fn warn_non_loopback_once(origin: &str) {
    if !NON_LOOPBACK_WARNED.swap(true, Ordering::Relaxed) {
        eprintln!(
            "cognitum-rs meta-proxy: non-loopback origin \"{origin}\" is ENABLED via \
             allow_non_loopback. This is DANGEROUS PREVIEW (ADR-0025a §D10) — the current \
             Proxy has no separate TLS, remote identity, firewall, or restricted-CORS \
             contract for this mode. Never use this in production."
        );
    }
}

/// Validate and normalize a [`MetaProxyClientConfig`]. Pure function, no I/O
/// — construction MUST stay side-effect free (ADR-0025a §D1: "Construction
/// never starts, installs, authenticates, probes, or reconfigures a process.").
#[allow(clippy::result_large_err)]
pub(crate) fn resolve_config(
    config: MetaProxyClientConfig,
) -> Result<MetaProxyClientConfig, AgenticError> {
    let trimmed = config.origin.trim_end_matches('/').to_owned();
    if trimmed.is_empty() {
        return Err(AgenticError::new(
            AgenticErrorKind::Configuration,
            "MetaProxyClientConfig.origin must not be empty",
        ));
    }
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err(AgenticError::new(
            AgenticErrorKind::Configuration,
            format!("MetaProxyClientConfig.origin must be an http(s) URL; got \"{trimmed}\""),
        ));
    }
    let host = extract_host(&trimmed).unwrap_or("");
    if !is_loopback_host(host) {
        if !config.allow_non_loopback {
            return Err(AgenticError::new(
                AgenticErrorKind::Configuration,
                format!(
                    "MetaProxyClientConfig.origin must be a literal IPv4/IPv6 loopback \
                     address (ADR-0025a §D10); got \"{trimmed}\". Hostname resolution to \
                     loopback (e.g. \"localhost\") is insufficient. Set \
                     allow_non_loopback: true only for the dangerous-preview remote case \
                     described in §D10."
                ),
            ));
        }
        warn_non_loopback_once(&trimmed);
    }
    Ok(MetaProxyClientConfig {
        origin: trimmed,
        ..config
    })
}
