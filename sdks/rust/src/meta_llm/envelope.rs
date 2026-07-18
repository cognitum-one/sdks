//! Result and metadata envelope (ADR-0024a §D4). The receipt/drift-
//! comparison logic described in §D4's "body and headers duplicate
//! receipt fields" paragraph remains deferred (still not implemented this
//! pass — only decoding a receipt already present on the response, not
//! comparing it against header/body duplicates), but `MetaLlmReceipt`
//! itself is now the concrete ADR-0024b §D3 shape (issue #59, D11
//! migration step 1) rather than the earlier `serde_json::Value` alias.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

pub use crate::meta_llm::types::MetaLlmReceipt;

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
