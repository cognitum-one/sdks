//! ADR-0024b §D3's `UsageSummary`/`BudgetView`, plus the bounded query the
//! read-only `MetaLlmClient::usage` method (`super::super::client`)
//! accepts.
//!
//! Usage is strictly authenticated-account scoped (§D3) -- every query is
//! bound to the caller's own credential; there is no cross-tenant or
//! cross-account parameter anywhere in [`UsageQuery`]. An empty
//! `UsageSummary` is not reinterpreted as "no usage anywhere" vs. "this
//! account genuinely has none" (§D3) -- `usage()` returns whatever the
//! server reports as-is, with no speculative fallback logic layered on
//! top.

use std::collections::HashMap;

use serde_json::{Map, Value};

use super::money::{parse_money, Money};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CacheStats {
    pub hit_rate: Option<f64>,
    pub savings: Option<Money>,
    pub raw: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct UsageTotals {
    pub requests: Option<u64>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cost: Option<Money>,
    pub raw: Option<Map<String, Value>>,
}

/// Plan degradation and reset information are preserved as reported
/// (§D4) -- this SDK never recomputes `status`/`headroom` from the other
/// fields.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BudgetView {
    pub serving: Option<Money>,
    pub hard_limit: Option<Money>,
    pub committed: Option<Money>,
    pub reserved: Option<Money>,
    pub headroom: Option<Money>,
    pub status: Option<String>,
    pub resets_at: Option<String>,
    pub raw: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct UsageBreakdownEntry {
    pub requests: Option<u64>,
    pub cost: Option<Money>,
    pub raw: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct UsagePeriodEntry {
    pub period: String,
    pub requests: Option<u64>,
    pub cost: Option<Money>,
    pub raw: Option<Map<String, Value>>,
}

/// ADR-0024b §D3's `UsageSummary`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UsageSummary {
    pub totals: UsageTotals,
    pub tier_mix: Option<HashMap<String, f64>>,
    pub escalation_rate: Option<f64>,
    pub cache: Option<CacheStats>,
    pub fallback_rate: Option<f64>,
    pub empty_billed_rate: Option<f64>,
    pub by_model: Option<HashMap<String, UsageBreakdownEntry>>,
    pub by_provider: Option<HashMap<String, UsageBreakdownEntry>>,
    pub by_period: Option<Vec<UsagePeriodEntry>>,
    pub budget: Option<BudgetView>,
    /// Fields present on the wire this decoder does not recognize, preserved verbatim (never dropped).
    pub raw: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageGroupBy {
    Model,
    Provider,
    Period,
}

impl UsageGroupBy {
    pub fn as_query_str(self) -> &'static str {
        match self {
            UsageGroupBy::Model => "model",
            UsageGroupBy::Provider => "provider",
            UsageGroupBy::Period => "period",
        }
    }
}

/// Bounded `YYYY-MM` query window plus optional grouping (ADR-0024b §D3).
#[derive(Debug, Clone)]
pub struct UsageQuery {
    /// Inclusive `YYYY-MM` start of the query range.
    pub from: String,
    /// Inclusive `YYYY-MM` end of the query range.
    pub to: String,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub group_by: Option<UsageGroupBy>,
}

impl UsageQuery {
    pub fn new(from: impl Into<String>, to: impl Into<String>) -> Self {
        Self {
            from: from.into(),
            to: to.into(),
            model: None,
            provider: None,
            group_by: None,
        }
    }
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct InvalidUsageQueryError(pub String);

fn is_valid_yyyy_mm(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 7 {
        return false;
    }
    if !bytes[..4].iter().all(u8::is_ascii_digit) {
        return false;
    }
    if bytes[4] != b'-' {
        return false;
    }
    if !bytes[5..7].iter().all(u8::is_ascii_digit) {
        return false;
    }
    s[5..7].parse::<u8>().map(|m| (1..=12).contains(&m)).unwrap_or(false)
}

/// Validates the bounded `YYYY-MM` range required by §D3 before any request is sent.
pub fn assert_valid_usage_query(query: &UsageQuery) -> Result<(), InvalidUsageQueryError> {
    if !is_valid_yyyy_mm(&query.from) {
        return Err(InvalidUsageQueryError(format!(
            "UsageQuery.from must match YYYY-MM; got {:?}",
            query.from
        )));
    }
    if !is_valid_yyyy_mm(&query.to) {
        return Err(InvalidUsageQueryError(format!(
            "UsageQuery.to must match YYYY-MM; got {:?}",
            query.to
        )));
    }
    if query.from > query.to {
        return Err(InvalidUsageQueryError(format!(
            "UsageQuery.from ({:?}) must not be after .to ({:?})",
            query.from, query.to
        )));
    }
    Ok(())
}

fn num_field(obj: &Map<String, Value>, key: &str) -> Option<f64> {
    obj.get(key).and_then(Value::as_f64)
}

fn u64_field(obj: &Map<String, Value>, key: &str) -> Option<u64> {
    obj.get(key).and_then(Value::as_u64)
}

fn raw_remainder(obj: &Map<String, Value>, known: &[&str]) -> Option<Map<String, Value>> {
    let out: Map<String, Value> = obj
        .iter()
        .filter(|(k, _)| !known.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn parse_cache_stats(raw: &Value) -> Option<CacheStats> {
    let obj = raw.as_object()?;
    let known = ["hit_rate", "savings"];
    Some(CacheStats {
        hit_rate: num_field(obj, "hit_rate"),
        savings: obj.get("savings").and_then(parse_money),
        raw: raw_remainder(obj, &known),
    })
}

fn parse_usage_totals(raw: Option<&Value>) -> UsageTotals {
    let Some(obj) = raw.and_then(Value::as_object) else {
        return UsageTotals::default();
    };
    let known = [
        "requests",
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "cost",
    ];
    UsageTotals {
        requests: u64_field(obj, "requests"),
        prompt_tokens: u64_field(obj, "prompt_tokens"),
        completion_tokens: u64_field(obj, "completion_tokens"),
        total_tokens: u64_field(obj, "total_tokens"),
        cost: obj.get("cost").and_then(parse_money),
        raw: raw_remainder(obj, &known),
    }
}

fn parse_budget_view(raw: &Value) -> Option<BudgetView> {
    let obj = raw.as_object()?;
    let known = [
        "serving",
        "hard_limit",
        "committed",
        "reserved",
        "headroom",
        "status",
        "resets_at",
    ];
    Some(BudgetView {
        serving: obj.get("serving").and_then(parse_money),
        hard_limit: obj.get("hard_limit").and_then(parse_money),
        committed: obj.get("committed").and_then(parse_money),
        reserved: obj.get("reserved").and_then(parse_money),
        headroom: obj.get("headroom").and_then(parse_money),
        status: obj.get("status").and_then(|v| v.as_str()).map(str::to_owned),
        resets_at: obj.get("resets_at").and_then(|v| v.as_str()).map(str::to_owned),
        raw: raw_remainder(obj, &known),
    })
}

fn parse_breakdown_entry(raw: &Value) -> UsageBreakdownEntry {
    let Some(obj) = raw.as_object() else {
        return UsageBreakdownEntry::default();
    };
    let known = ["requests", "cost"];
    UsageBreakdownEntry {
        requests: u64_field(obj, "requests"),
        cost: obj.get("cost").and_then(parse_money),
        raw: raw_remainder(obj, &known),
    }
}

fn parse_breakdown_map(raw: Option<&Value>) -> Option<HashMap<String, UsageBreakdownEntry>> {
    let obj = raw.and_then(Value::as_object)?;
    Some(
        obj.iter()
            .map(|(k, v)| (k.clone(), parse_breakdown_entry(v)))
            .collect(),
    )
}

fn parse_period_entries(raw: Option<&Value>) -> Option<Vec<UsagePeriodEntry>> {
    let arr = raw.and_then(Value::as_array)?;
    Some(
        arr.iter()
            .filter_map(|item| {
                let period = item.as_object()?.get("period")?.as_str()?.to_owned();
                let entry = parse_breakdown_entry(item);
                Some(UsagePeriodEntry {
                    period,
                    requests: entry.requests,
                    cost: entry.cost,
                    raw: entry.raw,
                })
            })
            .collect(),
    )
}

const KNOWN_USAGE_KEYS: &[&str] = &[
    "totals",
    "tier_mix",
    "escalation_rate",
    "cache",
    "fallback_rate",
    "empty_billed_rate",
    "by_model",
    "by_provider",
    "by_period",
    "budget",
];

/// Parse a raw `/v1/usage` JSON body into a typed [`UsageSummary`]. Never
/// panics -- an entirely empty/malformed body decodes to a `UsageSummary`
/// with empty `totals` rather than an error, since an empty result is
/// itself meaningful account-scoped evidence (§D3), not a parse failure.
pub fn parse_usage_summary(raw: &Value) -> UsageSummary {
    let Some(obj) = raw.as_object() else {
        return UsageSummary::default();
    };

    let tier_mix = obj.get("tier_mix").and_then(Value::as_object).map(|m| {
        m.iter()
            .filter_map(|(k, v)| v.as_f64().map(|n| (k.clone(), n)))
            .collect()
    });

    UsageSummary {
        totals: parse_usage_totals(obj.get("totals")),
        tier_mix,
        escalation_rate: num_field(obj, "escalation_rate"),
        cache: obj.get("cache").and_then(parse_cache_stats),
        fallback_rate: num_field(obj, "fallback_rate"),
        empty_billed_rate: num_field(obj, "empty_billed_rate"),
        by_model: parse_breakdown_map(obj.get("by_model")),
        by_provider: parse_breakdown_map(obj.get("by_provider")),
        by_period: parse_period_entries(obj.get("by_period")),
        budget: obj.get("budget").and_then(parse_budget_view),
        raw: raw_remainder(obj, KNOWN_USAGE_KEYS),
    }
}
