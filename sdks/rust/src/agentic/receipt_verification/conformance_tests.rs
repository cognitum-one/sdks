//! Cross-language canonicalization conformance tests (issue #56 / PR #84
//! review fix).
//!
//! Independent review of PR #84 found that Node/Rust canonicalize the
//! signable receipt payload as camelCase, while Python's
//! `dataclasses.asdict(r)` emitted snake_case with no rename step --
//! identical logical receipts canonicalized to different bytes, so
//! cross-SDK SHA-256 digest / HMAC-SHA256 signature verification silently
//! failed 100% of the time. A second, independent mismatch was found in the
//! same pass: `serde_json` (like Python's `json` module) preserves the
//! float/int distinction and renders a whole-valued cost amount as `10.0`,
//! while JavaScript's single `number` type makes `JSON.stringify` render it
//! as `10`.
//!
//! These tests load the language-neutral golden fixture shared with the
//! Node and Python suites (`sdks/fixtures/receipt-canonicalization/`),
//! build a native `ExecutionReceipt`/`LineageReference` from its logical
//! data, and assert this crate's own canonicalization produces byte-for-byte
//! the SAME pinned canonical JSON / SHA-256 digest / HMAC-SHA256 signature
//! that Node and Python are independently asserting too. A regression that
//! reintroduces snake_case keys, unsorted keys, or inconsistent number
//! formatting fails here without needing to run another language at all.

use serde::Deserialize;

use super::*;
use crate::agentic::receipts::{CostObservation, LineageSubject, ReceiptSubject};

const FIXTURE_JSON: &str =
    include_str!("../../../../fixtures/receipt-canonicalization/execution-receipt-v1.json");

/// Mirrors `ExecutionReceipt` minus `signature`/`verification` (which are
/// never part of the signable payload and are therefore absent from the
/// fixture's `logicalReceipt`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureReceiptShape {
    schema: String,
    receipt_id: String,
    product: String,
    contract_version: String,
    subject: ReceiptSubject,
    started_at: String,
    completed_at: Option<String>,
    usage: Option<serde_json::Value>,
    costs: Vec<CostObservation>,
    outcome: String,
    artifact_digests: Option<Vec<String>>,
    lineage_root: Option<String>,
    canonicalization: Option<String>,
    issuer: Option<String>,
    key_id: Option<String>,
}

/// Mirrors `LineageReference` minus `signature`/`verification`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureLineageShape {
    schema: String,
    subject: LineageSubject,
    leaf: Option<String>,
    root: Option<String>,
    sequence: Option<u64>,
    previous_checkpoint: Option<String>,
    checkpoint_time: Option<String>,
    canonicalization: Option<String>,
    issuer: Option<String>,
    key_id: Option<String>,
}

fn dummy_verification() -> VerificationResult {
    VerificationResult {
        level: VerificationLevel::None,
        valid: false,
        algorithm: None,
        key_id: None,
        checked_at: String::new(),
        subject_digest: None,
        warnings: None,
        failure: None,
    }
}

fn fixture() -> serde_json::Value {
    serde_json::from_str(FIXTURE_JSON).expect("fixture is valid JSON")
}

fn fixture_receipt() -> ExecutionReceipt {
    let shape: FixtureReceiptShape =
        serde_json::from_value(fixture()["logicalReceipt"].clone()).expect("matches shape");
    ExecutionReceipt {
        schema: shape.schema,
        receipt_id: shape.receipt_id,
        product: shape.product,
        contract_version: shape.contract_version,
        subject: shape.subject,
        started_at: shape.started_at,
        completed_at: shape.completed_at,
        usage: shape.usage,
        costs: shape.costs,
        outcome: shape.outcome,
        artifact_digests: shape.artifact_digests,
        lineage_root: shape.lineage_root,
        canonicalization: shape.canonicalization,
        issuer: shape.issuer,
        key_id: shape.key_id,
        signature: None,
        verification: dummy_verification(),
    }
}

fn fixture_lineage_entry() -> LineageReference {
    let shape: FixtureLineageShape =
        serde_json::from_value(fixture()["logicalLineageEntry"].clone()).expect("matches shape");
    LineageReference {
        schema: shape.schema,
        subject: shape.subject,
        leaf: shape.leaf,
        root: shape.root,
        sequence: shape.sequence,
        previous_checkpoint: shape.previous_checkpoint,
        checkpoint_time: shape.checkpoint_time,
        canonicalization: shape.canonicalization,
        issuer: shape.issuer,
        key_id: shape.key_id,
        signature: None,
        verification: dummy_verification(),
    }
}

fn fixture_str(key: &str) -> String {
    fixture()[key].as_str().expect("string field").to_string()
}

#[test]
fn receipt_canonical_bytes_match_the_cross_language_golden_fixture() {
    let receipt = fixture_receipt();
    let canonical = canonical_json(&receipt_signable_value(&receipt));

    assert_eq!(canonical, fixture_str("expectedCanonicalJson"));
    assert_eq!(sha256_hex(&canonical), fixture_str("expectedSha256Hex"));

    let key = fixture_str("hmacKeyUtf8").into_bytes();
    assert_eq!(
        hmac_sha256_hex(&key, &canonical),
        fixture_str("expectedHmacSha256Hex")
    );
}

#[test]
fn lineage_entry_canonical_bytes_match_the_cross_language_golden_fixture() {
    let entry = fixture_lineage_entry();
    let canonical = canonical_json(&lineage_signable_value(&entry));

    assert_eq!(canonical, fixture_str("expectedLineageCanonicalJson"));
    assert_eq!(
        sha256_hex(&canonical),
        fixture_str("expectedLineageSha256Hex")
    );

    let key = fixture_str("hmacKeyUtf8").into_bytes();
    assert_eq!(
        hmac_sha256_hex(&key, &canonical),
        fixture_str("expectedLineageHmacSha256Hex")
    );
}

/// Regression guard for the casing bug specifically: the signable value
/// MUST use camelCase keys (receiptId, contractVersion, subject.requestId),
/// never snake_case, and MUST NOT rename the opaque `usage` blob's keys.
#[test]
fn receipt_signable_value_uses_camel_case_and_leaves_opaque_usage_untouched() {
    let receipt = fixture_receipt();
    let value = receipt_signable_value(&receipt);
    let obj = value.as_object().expect("object");

    assert!(obj.contains_key("receiptId"));
    assert!(obj.contains_key("contractVersion"));
    assert!(!obj.contains_key("receipt_id"));
    assert!(!obj.contains_key("contract_version"));
    assert_eq!(
        obj["subject"]["requestId"],
        serde_json::json!("req_conformance_abc123")
    );
    assert!(obj["subject"].get("request_id").is_none());

    // Opaque blob: mixed-case keys pass through verbatim, unrenamed.
    let usage = &obj["usage"];
    assert_eq!(usage["prompt_tokens"], serde_json::json!(128));
    assert_eq!(usage["completion_tokens"], serde_json::json!(64));
    assert_eq!(usage["cacheHitRatio"], serde_json::json!(0.5));
}
