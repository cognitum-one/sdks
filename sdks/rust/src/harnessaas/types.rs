//! Wire types for the real, deployed, SYNCHRONOUS HarnessaaS surface (issue
//! #67/#68 / M5 start).
//!
//! Verified directly against `cognitum-one/harnessaas@908e4a99`
//! (`src/types.ts:557-573,728-799,786-870`, README.md's documented
//! `POST /solve` example) — not against ADR-0027a's D3 `SolveSubmissionV1`/
//! `SolveJob` proposal, which does not correspond to any deployed route yet.
//!
//! Deliberately OUT of scope this pass: the vertical-specific compound
//! request fields (`finding`/`scanner_command`, `migration`/`build_command`,
//! `test_generation`/`coverage_command`).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `SolveRequest.vertical` (ADR-0011). Defaults server-side to `code-repair`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessaaSVertical {
    CodeRepair,
    SecurityRemediation,
    DependencyMigration,
    TestGeneration,
}

/// A single solve request (`src/types.ts:572-624`'s `SolveRequest`, core
/// `code-repair` fields only this pass — see module doc comment).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarnessaaSSolveRequest {
    /// Repo identifier — a git URL. A local filesystem path is rejected by the API (issue #56).
    pub repo: String,
    /// The customer's OWN test command, e.g. `"pytest -k test_thing"`.
    pub test_command: String,
    /// Natural-language description of the issue to repair.
    pub issue: String,
    /// Cost x quality slider, 0..1. Soft signal only — `src/cascade.ts`
    /// does NOT read it (ADR-0027a Context).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub w: Option<f64>,
    /// Which vertical this request rides. Defaults server-side to `code-repair`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vertical: Option<HarnessaaSVertical>,
}

impl HarnessaaSSolveRequest {
    /// Minimal request with only the required fields set.
    pub fn new(repo: impl Into<String>, test_command: impl Into<String>, issue: impl Into<String>) -> Self {
        Self {
            repo: repo.into(),
            test_command: test_command.into(),
            issue: issue.into(),
            w: None,
            vertical: None,
        }
    }
}

/// `CostReceipt` (`src/types.ts:728-761`). Core fields modeled directly;
/// vertical-specific `field_coverage`/`compliance_scope` manifests are
/// folded into `raw` (out of scope this pass).
#[derive(Debug, Clone)]
pub struct HarnessaaSCostReceipt {
    pub request_id: String,
    pub model: String,
    pub mode: String,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub cost_usd: f64,
    pub route: String,
    pub escalated: bool,
    pub ledger_refs: Option<Vec<String>>,
    pub cache_hits: Option<i64>,
    pub cached_read_tokens: Option<i64>,
    pub batched: Option<i64>,
    pub raw: HashMap<String, Value>,
}

/// Conformance attestation (`src/types.ts:786-799`). `used_oracle_during_solve`
/// MUST be `false` for a leaderboard/grading-clean solve — enforced
/// architecturally server-side, not by this client.
#[derive(Debug, Clone)]
pub struct HarnessaaSConformanceAttestation {
    pub used_oracle_during_solve: bool,
    pub statement: String,
    pub visible_inputs_digest: String,
}

/// The full response from a solve (`src/types.ts:862-870`'s `SolveResponse`).
#[derive(Debug, Clone)]
pub struct HarnessaaSSolveResponse {
    pub request_id: String,
    /// The unified-diff patch, or empty string if no fix was found.
    pub patch: String,
    /// `true` iff the customer's `test_command` passed AFTER applying the patch.
    pub resolved: bool,
    pub cost_receipt: HarnessaaSCostReceipt,
    /// Pointer to retrieve the lineage record via `lineage(request_id)`.
    pub lineage_ref: String,
    pub conformance: HarnessaaSConformanceAttestation,
}

fn as_object(value: &Value) -> HashMap<String, Value> {
    value.as_object().map(|m| m.clone().into_iter().collect()).unwrap_or_default()
}

fn take_string(map: &mut HashMap<String, Value>, key: &str) -> Option<String> {
    map.remove(key).and_then(|v| v.as_str().map(str::to_owned))
}

/// Parse a raw JSON `CostReceipt` body into [`HarnessaaSCostReceipt`].
pub fn parse_cost_receipt(value: &Value) -> HarnessaaSCostReceipt {
    let mut raw = as_object(value);
    let request_id = take_string(&mut raw, "request_id").unwrap_or_default();
    let model = take_string(&mut raw, "model").unwrap_or_default();
    let mode = take_string(&mut raw, "mode").unwrap_or_default();
    let tokens_in = raw.remove("tokens_in").and_then(|v| v.as_i64()).unwrap_or(0);
    let tokens_out = raw.remove("tokens_out").and_then(|v| v.as_i64()).unwrap_or(0);
    let cost_usd = raw.remove("cost_usd").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let route = take_string(&mut raw, "route").unwrap_or_default();
    let escalated = raw.remove("escalated").and_then(|v| v.as_bool()).unwrap_or(false);
    let ledger_refs = raw.remove("ledger_refs").and_then(|v| v.as_array().cloned()).map(|items| {
        items.into_iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()
    });
    let cache_hits = raw.remove("cache_hits").and_then(|v| v.as_i64());
    let cached_read_tokens = raw.remove("cached_read_tokens").and_then(|v| v.as_i64());
    let batched = raw.remove("batched").and_then(|v| v.as_i64());
    HarnessaaSCostReceipt {
        request_id,
        model,
        mode,
        tokens_in,
        tokens_out,
        cost_usd,
        route,
        escalated,
        ledger_refs,
        cache_hits,
        cached_read_tokens,
        batched,
        raw,
    }
}

/// Parse a raw JSON `ConformanceAttestation` body into [`HarnessaaSConformanceAttestation`].
pub fn parse_conformance_attestation(value: &Value) -> HarnessaaSConformanceAttestation {
    let mut raw = as_object(value);
    let statement = take_string(&mut raw, "statement").unwrap_or_default();
    let visible_inputs_digest = take_string(&mut raw, "visibleInputsDigest")
        .or_else(|| take_string(&mut raw, "visible_inputs_digest"))
        .unwrap_or_default();
    HarnessaaSConformanceAttestation {
        used_oracle_during_solve: false,
        statement,
        visible_inputs_digest,
    }
}

/// Parse a raw `POST /solve` JSON body into [`HarnessaaSSolveResponse`].
pub fn parse_solve_response(value: &Value) -> HarnessaaSSolveResponse {
    let mut raw = as_object(value);
    let request_id = take_string(&mut raw, "request_id").unwrap_or_default();
    let patch = take_string(&mut raw, "patch").unwrap_or_default();
    let resolved = raw.remove("resolved").and_then(|v| v.as_bool()).unwrap_or(false);
    let cost_receipt = raw.remove("cost_receipt").map(|v| parse_cost_receipt(&v)).unwrap_or_else(|| parse_cost_receipt(&Value::Null));
    let lineage_ref = take_string(&mut raw, "lineage_ref").unwrap_or_default();
    let conformance = raw.remove("conformance").map(|v| parse_conformance_attestation(&v)).unwrap_or_else(|| parse_conformance_attestation(&Value::Null));
    HarnessaaSSolveResponse {
        request_id,
        patch,
        resolved,
        cost_receipt,
        lineage_ref,
        conformance,
    }
}

/// A single lineage entry (`src/types.ts:799-825`'s `LineageRecord`). Kept
/// permissive (`raw` passthrough for genome/route/vertical-specific fields)
/// rather than a full 1:1 model — no OpenAPI/JSON-Schema contract is
/// published for this shape yet (ADR-0027a §D11 blocker #1).
#[derive(Debug, Clone)]
pub struct HarnessaaSLineageRecord {
    pub request_id: String,
    pub account_id: Option<String>,
    /// ISO timestamp.
    pub ts: String,
    /// Hash chain: hash of the PREVIOUS record, for tamper-evidence.
    pub prev_hash: String,
    /// SHA-256 of this record's canonical content (excluding `hash` itself).
    pub hash: String,
    pub raw: HashMap<String, Value>,
}

/// `GET /lineage/:id` response (`src/server.ts`'s `{ request_id, records }` shape).
#[derive(Debug, Clone)]
pub struct HarnessaaSLineageResult {
    pub request_id: String,
    pub records: Vec<HarnessaaSLineageRecord>,
}

fn parse_lineage_record(value: &Value) -> HarnessaaSLineageRecord {
    let mut raw = as_object(value);
    let request_id = take_string(&mut raw, "request_id").unwrap_or_default();
    let account_id = take_string(&mut raw, "account_id");
    let ts = take_string(&mut raw, "ts").unwrap_or_default();
    let prev_hash = take_string(&mut raw, "prev_hash").unwrap_or_default();
    let hash = take_string(&mut raw, "hash").unwrap_or_default();
    HarnessaaSLineageRecord {
        request_id,
        account_id,
        ts,
        prev_hash,
        hash,
        raw,
    }
}

/// Parse a raw `GET /lineage/:id` JSON body into [`HarnessaaSLineageResult`].
pub fn parse_lineage_result(value: &Value) -> HarnessaaSLineageResult {
    let raw = as_object(value);
    let request_id = raw.get("request_id").and_then(|v| v.as_str()).unwrap_or_default().to_owned();
    let records = raw
        .get("records")
        .and_then(|v| v.as_array())
        .map(|items| items.iter().map(parse_lineage_record).collect())
        .unwrap_or_default();
    HarnessaaSLineageResult { request_id, records }
}
