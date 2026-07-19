//! Discovery wire type: health (ADR-0027a, issue #67/#68 / M5 start).
//!
//! Verified against `cognitum-one/harnessaas@908e4a99:src/server.ts:286-304`.
//! `/health` is served WITHOUT authentication — matching
//! `MetaLlmClient::health()`'s "process-level response only" contract.
//!
//! IMPORTANT (2026-07-19 reconciliation audit, issue #67): the service also
//! answers on `/healthz` and `/status`, but `src/server.ts:290-292`'s own
//! comment documents that Cloud Run's frontend (GFE) RESERVES `/healthz`
//! and answers it with the platform's own 404 to EXTERNAL callers — so
//! `/healthz` is NOT reliably reachable from outside the container. This
//! client therefore calls `GET /health` as the canonical route.

use std::collections::HashMap;

use serde_json::Value;

/// `health()` response. No OpenAPI/JSON-Schema contract is published for
/// this shape yet (ADR-0027a §D11 blocker #1), so only the fields verified
/// directly against `src/server.ts:293-303` are typed; everything else
/// (`genome`, `sandbox_caps`, ...) is preserved in `raw`.
#[derive(Debug, Clone)]
pub struct HarnessaaSHealth {
    pub status: String,
    /// `"mock"` ($0, no network) or `"live"`.
    pub mode: Option<String>,
    pub backend: Option<String>,
    /// Always `"per-account"` at HEAD.
    pub tenancy: Option<String>,
    /// `"firestore"` (shared/consistent across instances) or `"memory"` (per-instance).
    pub store_backend: Option<String>,
    /// Always `true` at HEAD.
    pub lineage_chain_ok: Option<bool>,
    pub raw: HashMap<String, Value>,
}

/// Parse a raw `GET /health` JSON body into [`HarnessaaSHealth`].
pub fn parse_harnessaas_health(value: &Value) -> HarnessaaSHealth {
    let mut raw: HashMap<String, Value> = value.as_object().map(|m| m.clone().into_iter().collect()).unwrap_or_default();
    let status = raw
        .remove("status")
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown".to_owned());
    let mode = raw.remove("mode").and_then(|v| v.as_str().map(str::to_owned));
    let backend = raw.remove("backend").and_then(|v| v.as_str().map(str::to_owned));
    let tenancy = raw.remove("tenancy").and_then(|v| v.as_str().map(str::to_owned));
    let store_backend = raw.remove("store_backend").and_then(|v| v.as_str().map(str::to_owned));
    let lineage_chain_ok = raw.remove("lineageChainOk").and_then(|v| v.as_bool());
    HarnessaaSHealth {
        status,
        mode,
        backend,
        tenancy,
        store_backend,
        lineage_chain_ok,
        raw,
    }
}
