//! Result and metadata envelope (ADR-0025a §D3).
//!
//! Deliberately its OWN shape rather than a reuse of `MetaLlmResult`
//! (`crate::meta_llm::envelope`) — ADR-0025a §D3 specifies distinct fields
//! (`product_version`, `routing_receipt`, `upstream_receipt`) that
//! `MetaLlmResult` does not have, reflecting that every Proxy response must
//! be able to carry plane-routing evidence (§D4) that a direct Meta LLM
//! response never needs.

use std::collections::HashMap;

use super::status::MetaProxyRoutingReceipt;

/// Placeholder for an upstream (Cognitum-cloud) receipt forwarded through
/// the Proxy (ADR-0025a §D7, deferred). Kept as an untyped
/// `serde_json::Value` rather than a shaped struct so callers cannot
/// accidentally treat an absent receipt as a shaped, empty value — same
/// rationale as `MetaLlmReceipt`.
pub type MetaProxyUpstreamReceipt = serde_json::Value;

/// Per-response metadata carried alongside every [`MetaProxyResult`] (ADR-0025a §D3).
#[derive(Debug, Clone)]
pub struct MetaProxyResponseMeta {
    pub request_id: String,
    pub product_version: Option<String>,
    pub protocol_version: Option<String>,
    pub http_status: u16,
    /// Seconds until retry is safe (standard `Retry-After` semantics) —
    /// note this is `retry_after`, NOT `retry_after_ms` like
    /// `MetaLlmResponseMeta` (ADR-0025a §D3 names the field `retry_after`,
    /// without an `_ms` suffix).
    pub retry_after: Option<f64>,
    /// Plane-routing evidence for this response (ADR-0025a §D4). Reserved
    /// for §D7 — `status()`/`capabilities()` this pass never populate it.
    pub routing_receipt: Option<MetaProxyRoutingReceipt>,
    pub upstream_receipt: Option<MetaProxyUpstreamReceipt>,
    pub warnings: Option<Vec<String>>,
    pub unknown_headers: Option<HashMap<String, String>>,
}

/// Envelope wrapping every MetaProxyClient operation result (ADR-0025a §D3).
#[derive(Debug, Clone)]
pub struct MetaProxyResult<T> {
    pub data: T,
    pub meta: MetaProxyResponseMeta,
}
