//! ADR-0024b §D3's `MetaLlmReceipt`. Replaces the `serde_json::Value`
//! alias that shipped with ADR-0024a's envelope (`super::super::envelope`)
//! -- this is the concrete shape issue #59 reserved that placeholder for.
//!
//! Every field here is server-authoritative evidence, not something this
//! SDK computes or backfills -- a missing cost/price/savings field stays
//! missing rather than being reconstructed from token counts (§D3:
//! "Missing cost is not reconstructed from tokens"). Parsing never panics:
//! an unrecognized shape yields `None` (for the whole receipt) or a
//! preserved-but-untyped `raw` entry (for individual unknown fields),
//! never a panic -- response parsing must not reject evidence just
//! because this SDK's enum set has not caught up yet (§D2).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::agentic::{CostFinality, CostObservation};

use super::money::{parse_money, Money};

/// `resolved_tier` can widen beyond this SDK's known `ModelTier` set as
/// the server evolves -- typed as plain `String` (not the closed
/// `super::routing::ModelTier` enum) so the value is preserved rather than
/// dropped or rejected (§D2: "Unknown received values are preserved").
pub type ReceiptModelTier = String;

/// Same unknown-preserving treatment as [`ReceiptModelTier`], for `cache_result`.
pub type ReceiptCacheResult = String;

/// Only contract-safe detector classes and counts are exposed here (§D4:
/// "Warn and redact expose only contract-safe detector classes and
/// counts. Prompts, matches, secrets, and unredacted content are
/// excluded").
// `Serialize`/`Deserialize` are derived only because this type is
// embedded in `MetaLlmReceipt` below, which is in turn embedded in
// `crate::meta_llm::envelope::MetaLlmResponseMeta` (a struct that itself
// derives `Serialize`/`Deserialize`) -- `parse_safety_summary` is the
// only decode path that actually runs. The wire contract is snake_case
// (string-literal `"detector_classes"`/`"blocked"` keys below), so the
// rename matches `MetaLlmRoutingControls`'s convention (`super::routing`)
// rather than the inert-but-mismatched `camelCase` this previously
// carried (issue #90).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SafetySummary {
    pub mode: Option<String>,
    pub detector_classes: Option<Vec<String>>,
    pub blocked: Option<bool>,
    /// Unrecognized fields from the server response, preserved verbatim.
    pub raw: Option<Map<String, Value>>,
}

/// ADR-0024b §D3's `MetaLlmReceipt`.
///
/// Same rationale as [`SafetySummary`] above: `Serialize`/`Deserialize`
/// are derived only because `crate::meta_llm::envelope::MetaLlmResponseMeta`
/// embeds this type and itself derives them; every actual decode path
/// uses `parse_meta_llm_receipt` below, never this derive. The rename
/// is snake_case to match the hand-written parser's string-literal keys
/// (`"request_id"`, `"resolved_tier"`, ...) and `MetaLlmRoutingControls`'s
/// convention, replacing the previously inert-but-mismatched `camelCase`
/// (issue #90).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct MetaLlmReceipt {
    pub request_id: String,
    pub resolved_tier: Option<ReceiptModelTier>,
    pub resolved_model: Option<String>,
    pub escalated: Option<bool>,
    pub cap_degraded: Option<bool>,
    pub routing_reason: Option<String>,
    pub price: Option<Money>,
    pub cache_result: Option<ReceiptCacheResult>,
    pub cache_savings: Option<Money>,
    pub prompt_cache_savings: Option<Money>,
    pub fallback_used: Option<bool>,
    pub breaker_counts: Option<HashMap<String, i64>>,
    pub sub_tenant_id: Option<String>,
    pub safety_summary: Option<SafetySummary>,
    pub usage: Option<Map<String, Value>>,
    #[serde(default)]
    pub costs: Vec<CostObservation>,
    /// Fields present on the wire this decoder does not recognize, preserved verbatim (never dropped).
    pub raw: Option<Map<String, Value>>,
}

const KNOWN_RECEIPT_KEYS: &[&str] = &[
    "request_id",
    "resolved_tier",
    "resolved_model",
    "escalated",
    "cap_degraded",
    "routing_reason",
    "price",
    "cache_result",
    "cache_savings",
    "prompt_cache_savings",
    "fallback_used",
    "breaker_counts",
    "sub_tenant_id",
    "safety_summary",
    "usage",
    "costs",
];

fn str_field(obj: &Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key).and_then(|v| v.as_str()).map(str::to_owned)
}

fn bool_field(obj: &Map<String, Value>, key: &str) -> Option<bool> {
    obj.get(key).and_then(|v| v.as_bool())
}

fn parse_cost_finality(s: &str) -> Option<CostFinality> {
    match s {
        "estimate" => Some(CostFinality::Estimate),
        "reserved" => Some(CostFinality::Reserved),
        "committed" => Some(CostFinality::Committed),
        "provider_reported" => Some(CostFinality::ProviderReported),
        "invoiced" => Some(CostFinality::Invoiced),
        _ => None,
    }
}

fn parse_cost_observation(raw: &Value) -> Option<CostObservation> {
    let obj = raw.as_object()?;
    let source = str_field(obj, "source")?;
    let currency = str_field(obj, "currency")?;
    let finality = str_field(obj, "finality").and_then(|f| parse_cost_finality(&f))?;
    // NOTE: `CostObservation.amount` is still a plain `f64` from the
    // earlier ADR-0028 stub, not a `Money` -- an existing gap out of scope
    // to fix here (see `super::money`'s module docs).
    let amount = obj.get("amount")?.as_f64()?;
    Some(CostObservation {
        source,
        amount,
        currency,
        finality,
    })
}

fn parse_safety_summary(raw: &Value) -> Option<SafetySummary> {
    let obj = raw.as_object()?;
    let known = ["mode", "detector_classes", "blocked"];
    let detector_classes = obj.get("detector_classes").and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect()
    });
    let raw_remainder: Map<String, Value> = obj
        .iter()
        .filter(|(k, _)| !known.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    Some(SafetySummary {
        mode: str_field(obj, "mode"),
        detector_classes,
        blocked: bool_field(obj, "blocked"),
        raw: if raw_remainder.is_empty() {
            None
        } else {
            Some(raw_remainder)
        },
    })
}

/// Parse a raw wire `cognitum_receipt` payload into a typed
/// [`MetaLlmReceipt`]. Returns `None` for a missing/malformed receipt
/// (not an object) rather than a shaped empty value (ADR-0024a §D4:
/// "Missing metadata remains missing").
pub fn parse_meta_llm_receipt(raw: &Value) -> Option<MetaLlmReceipt> {
    let obj = raw.as_object()?;

    // A receipt missing `request_id` is anomalous but still preserved
    // rather than discarded wholesale -- every other field (including
    // `raw`) is still extracted below, just with `request_id` defaulted
    // to `""` instead of dropping the whole receipt (and, with it, cost/
    // routing evidence the server did send).
    let request_id = str_field(obj, "request_id").unwrap_or_default();

    let costs = obj
        .get("costs")
        .and_then(|v| v.as_array())
        .map(|items| items.iter().filter_map(parse_cost_observation).collect())
        .unwrap_or_default();

    let breaker_counts = obj.get("breaker_counts").and_then(|v| v.as_object()).map(|m| {
        m.iter()
            .filter_map(|(k, v)| v.as_i64().map(|n| (k.clone(), n)))
            .collect()
    });

    let raw_remainder: Map<String, Value> = obj
        .iter()
        .filter(|(k, _)| !KNOWN_RECEIPT_KEYS.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    Some(MetaLlmReceipt {
        request_id,
        resolved_tier: str_field(obj, "resolved_tier"),
        resolved_model: str_field(obj, "resolved_model"),
        escalated: bool_field(obj, "escalated"),
        cap_degraded: bool_field(obj, "cap_degraded"),
        routing_reason: str_field(obj, "routing_reason"),
        price: obj.get("price").and_then(parse_money),
        cache_result: str_field(obj, "cache_result"),
        cache_savings: obj.get("cache_savings").and_then(parse_money),
        prompt_cache_savings: obj.get("prompt_cache_savings").and_then(parse_money),
        fallback_used: bool_field(obj, "fallback_used"),
        breaker_counts,
        sub_tenant_id: str_field(obj, "sub_tenant_id"),
        safety_summary: obj.get("safety_summary").and_then(parse_safety_summary),
        usage: obj.get("usage").and_then(|v| v.as_object()).cloned(),
        costs,
        raw: if raw_remainder.is_empty() {
            None
        } else {
            Some(raw_remainder)
        },
    })
}
