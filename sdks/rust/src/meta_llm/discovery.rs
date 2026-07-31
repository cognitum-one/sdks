//! Discovery wire types: health, models, whoami (ADR-0024a §D1, §D2).
//!
//! No service-owned OpenAPI contract exists yet (ADR-0024a §D9 gate #1), so
//! these stay intentionally permissive (`raw` passthrough) rather than
//! pretending to be the eventual GA contract.

use std::collections::HashMap;

use serde_json::Value;

/// `health()` response — process-level only, never identity or readiness.
#[derive(Debug, Clone)]
pub struct MetaLlmHealth {
    pub status: String,
    pub version: Option<String>,
    /// Unrecognized fields from the server response, preserved verbatim.
    pub raw: HashMap<String, Value>,
}

/// A single entry from `models()`. `/v1/models` may not list every accepted alias.
#[derive(Debug, Clone)]
pub struct MetaLlmModelInfo {
    pub id: String,
    pub object: Option<String>,
    pub owned_by: Option<String>,
    pub created: Option<i64>,
    pub raw: HashMap<String, Value>,
}

/// `models()` response.
#[derive(Debug, Clone)]
pub struct MetaLlmModelList {
    pub models: Vec<MetaLlmModelInfo>,
    pub object: Option<String>,
    pub raw: HashMap<String, Value>,
}

/// `whoami()` response — authenticated account and credential type only.
#[derive(Debug, Clone)]
pub struct MetaLlmWhoAmI {
    pub account_id: Option<String>,
    pub credential_type: Option<String>,
    pub scopes: Vec<String>,
    pub tenant_id: Option<String>,
    pub raw: HashMap<String, Value>,
}
