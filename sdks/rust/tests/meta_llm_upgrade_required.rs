//! 402 `upgrade_required` vs `budget_exceeded` (issue #128, ADR-0023 §D1).
//!
//! A 402 is either "you spent your budget" or "you never bought this tier",
//! and the two send a user to different places. These mirror the Node and
//! Python suites case for case -- the three SDKs must agree on the wire.

#![cfg(feature = "meta-llm")]

use cognitum_one::agentic::{is_upgrade_required, parse_error_body, parse_upgrade_affordance};

/// Not invented: the verbatim body returned by https://api.cognitum.one on
/// 2026-07-31 when a key holding `completions:low` requested `cognitum-high`.
const LIVE_TIER_SHORTFALL_BODY: &str = r#"{
  "error": "Model 'cognitum-high' requires the completions:high scope, which this API key does not hold.",
  "code": "upgrade_required",
  "requestId": "f892a402-f488-46b1-93d9-86ccdfcaf53b",
  "required_tier": "high",
  "held_tier": "low",
  "required_scope": "completions:high",
  "upgrade_url": "https://dashboard.cognitum.one/settings/billing"
}"#;

#[test]
fn live_tier_shortfall_is_recognised_as_upgrade_required() {
    let body = parse_error_body(LIVE_TIER_SHORTFALL_BODY);
    assert!(is_upgrade_required(body.as_ref()));
}

#[test]
fn affordance_is_exposed_not_dropped() {
    let body = parse_error_body(LIVE_TIER_SHORTFALL_BODY);
    let upgrade = parse_upgrade_affordance(body.as_ref()).expect("affordance present");

    assert_eq!(upgrade.required_tier.as_deref(), Some("high"));
    assert_eq!(upgrade.held_tier.as_deref(), Some("low"));
    assert_eq!(upgrade.required_scope.as_deref(), Some("completions:high"));
    assert_eq!(
        upgrade.upgrade_url.as_deref(),
        Some("https://dashboard.cognitum.one/settings/billing")
    );
    assert!(upgrade.retry_with.is_none());
}

#[test]
fn retry_with_is_surfaced() {
    let body = parse_error_body(
        r#"{"code":"upgrade_required","required_tier":"mid","retry_with":{"fallback_policy":"best_effort"}}"#,
    );
    let upgrade = parse_upgrade_affordance(body.as_ref()).expect("affordance present");
    let hint = upgrade.retry_with.expect("retry hint present");

    assert_eq!(hint.fallback_policy.as_deref(), Some("best_effort"));
}

#[test]
fn unrecognised_retry_with_keys_are_dropped() {
    // ADR-0028 §D10: credentials, cookies and pre-signed URLs are never
    // capturable, and nothing redacts this field.
    let body = parse_error_body(
        r#"{"code":"upgrade_required","retry_with":{"fallback_policy":"best_effort","authorization":"Bearer SECRET"}}"#,
    );
    let affordance = parse_upgrade_affordance(body.as_ref()).expect("affordance");
    let hint = affordance.retry_with.clone().expect("retry hint");

    assert_eq!(hint.fallback_policy.as_deref(), Some("best_effort"));
    assert!(!format!("{affordance:?}").contains("SECRET"));
}

#[test]
fn retry_with_is_omitted_when_nothing_is_understood() {
    let body = parse_error_body(r#"{"code":"upgrade_required","retry_with":{"future_key":null}}"#);

    // "No affordance" and "no usable affordance" must look identical.
    assert!(parse_upgrade_affordance(body.as_ref()).is_none());
}

#[test]
fn budget_402_is_not_an_upgrade() {
    // The regression that matters in the other direction: spend exhaustion
    // must not be reclassified.
    let body = parse_error_body(r#"{"error":"budget exhausted","code":"budget_exceeded"}"#);

    assert!(!is_upgrade_required(body.as_ref()));
    assert!(parse_upgrade_affordance(body.as_ref()).is_none());
}

#[test]
fn unrecognised_402_code_is_not_an_upgrade() {
    // Forward compatibility: a code this version has never heard of must not
    // become `UpgradeRequired` by accident.
    let body = parse_error_body(r#"{"code":"some_future_402_reason"}"#);
    assert!(!is_upgrade_required(body.as_ref()));
}

#[test]
fn non_json_body_does_not_panic() {
    // A WAF or proxy can answer 402 with HTML. A mapper that panics while
    // mapping an error replaces a useful failure with a confusing one.
    let body = parse_error_body("<html>Payment Required</html>");

    assert!(body.is_none());
    assert!(!is_upgrade_required(body.as_ref()));
    assert!(parse_upgrade_affordance(body.as_ref()).is_none());
}

#[test]
fn empty_body_does_not_panic() {
    assert!(parse_error_body("").is_none());
}

#[test]
fn json_that_is_not_an_object_is_rejected() {
    assert!(parse_error_body("[1,2,3]").is_none());
    assert!(parse_error_body("\"a string\"").is_none());
}

#[test]
fn code_without_fields_yields_no_affordance() {
    let body = parse_error_body(r#"{"code":"upgrade_required"}"#);

    assert!(is_upgrade_required(body.as_ref()));
    // Absent, not a struct of Nones -- a caller checks `if let Some(u)`.
    assert!(parse_upgrade_affordance(body.as_ref()).is_none());
}

#[test]
fn non_string_affordance_fields_are_ignored() {
    let body = parse_error_body(r#"{"code":"upgrade_required","required_tier":42,"held_tier":"low"}"#);
    let upgrade = parse_upgrade_affordance(body.as_ref()).expect("affordance");

    assert!(upgrade.required_tier.is_none());
    assert_eq!(upgrade.held_tier.as_deref(), Some("low"));
}

#[test]
fn empty_string_fields_are_treated_as_absent() {
    let body = parse_error_body(r#"{"code":"upgrade_required","required_tier":"","held_tier":"low"}"#);
    let upgrade = parse_upgrade_affordance(body.as_ref()).expect("affordance");

    assert!(upgrade.required_tier.is_none());
    assert_eq!(upgrade.held_tier.as_deref(), Some("low"));
}
