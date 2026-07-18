//! Result and metadata envelope (ADR-0024a §D4). Type-only this pass — the
//! receipt/drift-comparison logic described in §D4's "body and headers
//! duplicate receipt fields" paragraph is deferred to the follow-up issue
//! that lands ADR-0024b's `MetaLlmReceipt`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Placeholder for ADR-0024b's `MetaLlmReceipt`. Kept as an untyped
/// `serde_json::Value` rather than a shaped struct so callers cannot
/// accidentally treat an absent receipt as a shaped, empty value
/// (ADR-0024a §D4: "Missing metadata remains missing").
pub type MetaLlmReceipt = serde_json::Value;

/// Per-response metadata carried alongside every [`MetaLlmResult`] (ADR-0024a §D4).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaLlmResponseMeta {
    pub request_id: String,
    pub http_status: u16,
    pub protocol_version: Option<String>,
    pub retry_after_ms: Option<u64>,
    pub idempotent_replay: Option<bool>,
    pub receipt: Option<MetaLlmReceipt>,
    pub warnings: Option<Vec<String>>,
    pub unknown_headers: Option<HashMap<String, String>>,
}

/// Envelope wrapping every MetaLlmClient operation result (ADR-0024a §D4).
#[derive(Debug, Clone)]
pub struct MetaLlmResult<T> {
    pub data: T,
    pub meta: MetaLlmResponseMeta,
}
