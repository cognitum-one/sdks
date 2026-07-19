//! Per-call forwarding options and the §D7 header allowlist (ADR-0025a §D7).
//!
//! §D7: "supported headers are selected by the target contract, not forwarded
//! optimistically" (also ADR-0019 §D7). A caller may pass a bag of headers to
//! forward, but it is ALWAYS allowlist-filtered before it reaches the outgoing
//! request — never merged verbatim. "Authorization, local bearer, host, content
//! length, sponsor markers, installation identity, and training consent are
//! never caller-forwarded. The Proxy derives them from validated local state."

use std::collections::HashMap;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

use super::routing::RoutingIntent;

/// The §D7 cloud-forwarding allowlist. Any caller-supplied header NOT in this
/// set (compared case-insensitively) is dropped rather than forwarded — this
/// is what keeps `Authorization`, `Host`, `Content-Length`, sponsor/identity/
/// consent markers, etc. off the wire regardless of what the caller passes.
pub(crate) const FORWARDABLE_HEADER_ALLOWLIST: &[&str] = &[
    "idempotency-key",
    "x-request-id",
    "traceparent",
    "tracestate",
    "x-cognitum-fallback-policy",
    "x-cognitum-min-tier",
    "x-cognitum-max-tier",
    "x-cognitum-escalation",
    "x-cognitum-cache",
    "x-cognitum-safety",
    "x-cognitum-sub-tenant",
    "anthropic-version",
    "anthropic-beta",
];

/// `true` when `name` is on the §D7 forwarding allowlist (case-insensitive).
fn is_forwardable(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    FORWARDABLE_HEADER_ALLOWLIST.contains(&lower.as_str())
}

/// Options for [`super::client::MetaProxyClient::chat_completions`].
///
/// `forward_headers` is a caller-supplied bag that is ALLOWLIST-FILTERED (see
/// [`FORWARDABLE_HEADER_ALLOWLIST`]) before merging into the outgoing request —
/// never merged verbatim, so a forbidden header (e.g. `Authorization`) a caller
/// puts here is silently dropped, never sent.
#[derive(Debug, Clone, Default)]
pub struct MetaProxyChatCallOptions {
    /// Caller routing intent (ADR-0025a §D5). When its `required_plane` is set,
    /// the response's routing receipt is verified against it after decode.
    pub routing_intent: Option<RoutingIntent>,
    /// Optional stable idempotency key. When `None`, a fresh UUID is generated
    /// per logical call and held stable across retries (§D7/§D8).
    pub idempotency_key: Option<String>,
    /// Caller-supplied headers to forward. Allowlist-filtered before sending.
    pub forward_headers: Option<HashMap<String, String>>,
}

/// Build the outgoing forwarded-header map from the caller's bag, keeping ONLY
/// allowlisted entries (§D7). Invalid header names/values are skipped rather
/// than errored — a malformed caller header must never abort a valid call, and
/// certainly must never be forwarded.
pub(crate) fn build_forward_headers(bag: Option<&HashMap<String, String>>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    let Some(bag) = bag else {
        return headers;
    };
    for (name, value) in bag {
        if !is_forwardable(name) {
            continue;
        }
        if let (Ok(header_name), Ok(header_value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            headers.insert(header_name, header_value);
        }
    }
    headers
}
