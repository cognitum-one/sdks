//! ADR-0028's `Money`: an exact decimal amount + ISO-4217 currency, decoded
//! from wire USD decimal values so cost/price/savings fields never enter
//! the public domain model as binary floating point (ADR-0024b §D3: "Wire
//! fields such as current USD price values decode into ADR-0028 decimal
//! `Money`; they never enter the public domain model as binary floating
//! point").
//!
//! `rust_decimal` is not a dependency of this crate (checked `Cargo.toml`
//! before adding one, per this task's own instruction) -- this is a
//! minimal `String`-backed newtype rather than a new heavyweight decimal
//! dependency. `crate::agentic::CostObservation::amount` is still a plain
//! `f64` from the earlier ADR-0028 receipt/lineage stub -- an existing
//! gap, out of scope to fix here, not something this type inherits
//! (reused verbatim per the task's own instruction).
//!
//! Deliberately no arithmetic is implemented here -- this type exists to
//! prevent accidental floating-point ingestion of money values, not to be
//! a money-math library. Callers needing arithmetic should parse `amount`
//! with a decimal crate of their own choosing.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Exact decimal amount + ISO-4217 currency code (e.g. `"USD"`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Money {
    /// Exact decimal string, e.g. `"0.0123"`. Never a binary float.
    pub amount: String,
    pub currency: String,
}

/// Decode a wire money value into a [`Money`]. Accepts `amount` as either
/// a decimal string (preferred -- exact) or a JSON number (tolerated; a
/// JSON number has already lost the ability to represent arbitrary
/// decimal precision at the parse boundary, but this decoder performs no
/// further floating-point arithmetic on it -- it is converted with
/// `to_string()`/`Number::to_string()` only, never rounded or rescaled).
/// Returns `None` for a missing or malformed value rather than fabricating
/// a zero amount.
pub fn parse_money(raw: &Value) -> Option<Money> {
    let obj = raw.as_object()?;
    let currency = obj
        .get("currency")
        .or_else(|| obj.get("currency_code"))
        .and_then(|v| v.as_str())?
        .to_owned();
    let amount_raw = obj.get("amount")?;
    let amount = match amount_raw {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    Some(Money { amount, currency })
}
