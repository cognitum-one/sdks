//! Parsing for the server's 402 upgrade affordance (ADR-0023 §D1).
//!
//! The gateway returns 402 for two unrelated situations and distinguishes
//! them with `code`:
//!
//! ```json
//! {"code": "upgrade_required", "required_tier": "mid", "held_tier": "low",
//!  "required_scope": "completions:mid", "upgrade_url": "...",
//!  "retry_with": {"fallback_policy": "best_effort"}}
//! ```
//!
//! versus a budget 402, which carries no such affordance. Status alone cannot
//! tell them apart, and the message text must never be used to try -- it is
//! prose, it is localisable, and it is redacted before callers see it.
//!
//! On the Responses and Anthropic Messages surfaces these keys ride at the
//! top level beside `error`, so one parser serves every surface.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The `code` value marking a 402 as a scope shortfall rather than a spend one.
pub const UPGRADE_REQUIRED_CODE: &str = "upgrade_required";

/// Server hint describing a retry that would be in scope.
///
/// Deliberately narrow. An earlier draft preserved every unrecognised
/// `retry_with` key verbatim for forward compatibility, which put unbounded,
/// server-controlled JSON onto an error object that callers routinely log.
/// ADR-0028 §D10 forbids capturing credentials, cookies and pre-signed URLs at
/// all, and nothing downstream redacts this field. A key no version of this
/// SDK understands is also a key no caller can act on, so the trade bought
/// nothing and cost a leak path. Add fields here as the server ships them.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[non_exhaustive]
pub struct UpgradeRetryHint {
    /// e.g. `"best_effort"`.
    pub fallback_policy: Option<String>,
}

/// What the server says would make the rejected call succeed.
///
/// Every field is optional on purpose: this is a server-supplied affordance,
/// and a caller that hard-requires any one of them would break the moment the
/// gateway omits it. Render what is present; never infer what is not.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[non_exhaustive]
pub struct UpgradeAffordance {
    /// Tier that would satisfy the request, e.g. `"mid"`.
    pub required_tier: Option<String>,
    /// Tier the credential currently holds, e.g. `"low"`.
    pub held_tier: Option<String>,
    /// Scope that was missing, e.g. `"completions:mid"`.
    pub required_scope: Option<String>,
    /// Where a human goes to change their plan.
    pub upgrade_url: Option<String>,
    /// Present only when the server can offer an in-scope retry (auto mode
    /// with `fail_fast`); an explicitly over-scope model alias omits it.
    /// Absence means "there is no way to retry this as asked" -- not an error.
    ///
    /// This SDK never acts on it automatically. `UpgradeRequired` is
    /// non-retryable, and silently downgrading someone's request to a cheaper
    /// tier is a decision only the caller can make.
    pub retry_with: Option<UpgradeRetryHint>,
}

fn string_or_none(value: Option<&Value>) -> Option<String> {
    match value.and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Some(s.to_owned()),
        _ => None,
    }
}

/// Parse an error body that may or may not be JSON.
///
/// Returns `None` rather than erroring: a 402 can arrive from a proxy or WAF
/// as HTML, and an error mapper that fails while mapping an error replaces a
/// useful failure with a confusing one.
pub fn parse_error_body(body_text: &str) -> Option<Map<String, Value>> {
    if body_text.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(body_text) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

fn parse_retry_hint(value: Option<&Value>) -> Option<UpgradeRetryHint> {
    // Only the fields this SDK understands are lifted out; unrecognised keys
    // are dropped -- see [`UpgradeRetryHint`] for why.
    let object = value?.as_object()?;
    let fallback_policy = string_or_none(object.get("fallback_policy"))?;
    Some(UpgradeRetryHint {
        fallback_policy: Some(fallback_policy),
    })
}

/// Extract the upgrade affordance from a parsed error body.
///
/// Returns `None` when the server sent none of the fields, so a caller can
/// treat "no affordance" and "no useful affordance" identically.
pub fn parse_upgrade_affordance(body: Option<&Map<String, Value>>) -> Option<UpgradeAffordance> {
    let body = body?;
    let affordance = UpgradeAffordance {
        required_tier: string_or_none(body.get("required_tier")),
        held_tier: string_or_none(body.get("held_tier")),
        required_scope: string_or_none(body.get("required_scope")),
        upgrade_url: string_or_none(body.get("upgrade_url")),
        retry_with: parse_retry_hint(body.get("retry_with")),
    };
    if affordance == UpgradeAffordance::default() {
        return None;
    }
    Some(affordance)
}

/// Is this 402 body a scope shortfall (as opposed to a budget one)?
pub fn is_upgrade_required(body: Option<&Map<String, Value>>) -> bool {
    body.and_then(|b| b.get("code"))
        .and_then(Value::as_str)
        .is_some_and(|code| code == UPGRADE_REQUIRED_CODE)
}
