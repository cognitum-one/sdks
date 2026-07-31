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
///
/// `Serialize`/`Deserialize` are derived only because this type is
/// embedded in [`super::receipt::MetaLlmReceipt`], which is in turn
/// embedded in `crate::meta_llm::envelope::MetaLlmResponseMeta` (a struct
/// that itself derives `Serialize`/`Deserialize`) -- every decode path
/// that actually runs uses the hand-written `parse_money` below, never
/// this derive. The wire contract is snake_case (see `parse_money`'s
/// string-literal `"amount"`/`"currency"` keys), so the rename here
/// matches `MetaLlmRoutingControls`'s convention (`super::routing`)
/// rather than the inert-but-mismatched `camelCase` this previously
/// carried (issue #90).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The previously-only-tested case (see `meta_llm_routing_usage.rs`):
    /// a simple decimal string round-trips byte-for-byte.
    #[test]
    fn parses_simple_string_amount() {
        let money = parse_money(&json!({"amount": "0.0042", "currency": "USD"})).unwrap();
        assert_eq!(money.amount, "0.0042");
        assert_eq!(money.currency, "USD");
    }

    /// Issue #90: a JSON-number amount sitting exactly on the classic
    /// binary-floating-point boundary (`0.1 + 0.2` in IEEE-754 double
    /// precision is `0.30000000000000004`, not `0.3`). `serde_json` parses
    /// the literal into that same `f64`, and `Number::to_string()` uses the
    /// shortest round-tripping decimal representation -- so this must come
    /// back byte-for-byte as `"0.30000000000000004"`, proving `parse_money`
    /// performs no additional rounding/rescaling of its own on the number
    /// path.
    #[test]
    fn parses_number_amount_at_float_precision_boundary() {
        let money =
            parse_money(&json!({"amount": 0.30000000000000004, "currency": "USD"})).unwrap();
        assert_eq!(money.amount, "0.30000000000000004");
        assert_eq!(money.currency, "USD");
    }

    /// A high-precision decimal string beyond what any `f64` could
    /// represent exactly must survive untouched -- this is the entire
    /// reason `Money.amount` is a `String` and not a binary float.
    #[test]
    fn preserves_high_precision_string_amount_exactly() {
        let money = parse_money(
            &json!({"amount": "123.456789012345678901234567890", "currency": "USD"}),
        )
        .unwrap();
        assert_eq!(money.amount, "123.456789012345678901234567890");
    }

    /// `currency_code` is accepted as a fallback key for `currency`.
    #[test]
    fn accepts_currency_code_fallback_key() {
        let money = parse_money(&json!({"amount": "1.00", "currency_code": "EUR"})).unwrap();
        assert_eq!(money.currency, "EUR");
    }

    /// Round-trip through the (otherwise-inert) `Serialize`/`Deserialize`
    /// derive itself, snake_case per issue #90 -- guards against a future
    /// regression back to the mismatched `camelCase` rename.
    #[test]
    fn derive_round_trips_snake_case() {
        let money = Money {
            amount: "0.30000000000000004".to_owned(),
            currency: "USD".to_owned(),
        };
        let wire = serde_json::to_value(&money).unwrap();
        assert_eq!(wire["amount"], "0.30000000000000004");
        assert_eq!(wire["currency"], "USD");
        let round_tripped: Money = serde_json::from_value(wire).unwrap();
        assert_eq!(round_tripped, money);
    }
}
