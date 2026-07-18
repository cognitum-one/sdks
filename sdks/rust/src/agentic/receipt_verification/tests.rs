use super::*;
use crate::agentic::receipts::LineageSubject;

const KEY: &[u8] = b"test-signing-key";

fn resolve_key(issuer: &str, key_id: &str) -> Option<Vec<u8>> {
    if issuer == "cognitum-one" && key_id == "key-1" {
        Some(KEY.to_vec())
    } else {
        None
    }
}

fn sign(bytes: &str) -> String {
    hmac_sha256_hex(KEY, bytes)
}

fn make_receipt() -> ExecutionReceipt {
    build_execution_receipt(BuildExecutionReceiptInput {
        receipt_id: "rcpt_1".to_string(),
        product: "harnessaas".to_string(),
        contract_version: "1.0".to_string(),
        request_id: "req_1".to_string(),
        operation_id: Some("op_1".to_string()),
        started_at: "2026-07-18T00:00:00.000Z".to_string(),
        completed_at: Some("2026-07-18T00:00:05.000Z".to_string()),
        outcome: "succeeded".to_string(),
        costs: vec![CostObservation {
            source: "provider".to_string(),
            amount: 0.01,
            currency: "USD".to_string(),
            finality: crate::agentic::receipts::CostFinality::Estimate,
        }],
        issuer: Some("cognitum-one".to_string()),
        key_id: Some("key-1".to_string()),
        sign: Some(&sign),
        ..Default::default()
    })
}

#[test]
fn build_produces_shape_valid_receipt() {
    let receipt = make_receipt();
    assert_eq!(receipt.schema, "cognitum.execution-receipt.v1");
    assert_eq!(receipt.verification.level, VerificationLevel::Shape);
    assert!(receipt.verification.valid);
    assert_eq!(
        receipt.canonicalization.as_deref(),
        Some("cognitum-canonical-json-v1")
    );
}

#[test]
fn build_flags_structurally_incomplete_receipt() {
    let mut input = BuildExecutionReceiptInput {
        receipt_id: "rcpt_1".to_string(),
        product: "harnessaas".to_string(),
        contract_version: "1.0".to_string(),
        request_id: "req_1".to_string(),
        started_at: "2026-07-18T00:00:00.000Z".to_string(),
        outcome: String::new(),
        ..Default::default()
    };
    input.costs = vec![];
    let receipt = build_execution_receipt(input);
    assert_eq!(receipt.verification.level, VerificationLevel::None);
    assert!(!receipt.verification.valid);
    assert!(receipt.verification.failure.unwrap().contains("outcome"));
}

#[test]
fn verify_reaches_cryptographic_for_a_validly_signed_receipt() {
    let receipt = make_receipt();
    let opts = VerifyReceiptOptions {
        min_level: VerificationLevel::Cryptographic,
        resolve_key: Some(&resolve_key),
        ..Default::default()
    };
    let result = verify_execution_receipt(&receipt, &opts);
    assert!(result.valid);
    assert_eq!(result.level, VerificationLevel::Cryptographic);
    assert_eq!(result.algorithm.as_deref(), Some("hmac-sha256"));
}

#[test]
fn verify_rejects_a_tampered_receipt() {
    let mut receipt = make_receipt();
    receipt.outcome = "failed".to_string();
    let opts = VerifyReceiptOptions {
        min_level: VerificationLevel::Cryptographic,
        resolve_key: Some(&resolve_key),
        ..Default::default()
    };
    let result = verify_execution_receipt(&receipt, &opts);
    assert!(!result.valid);
    assert_eq!(result.level, VerificationLevel::None);
    assert!(result.failure.unwrap().contains("signature"));
}

#[test]
fn shape_only_receipt_skips_crypto_checks_it_never_claimed() {
    let receipt = build_execution_receipt(BuildExecutionReceiptInput {
        receipt_id: "rcpt_2".to_string(),
        product: "meta-llm".to_string(),
        contract_version: "1.0".to_string(),
        request_id: "req_2".to_string(),
        started_at: "2026-07-18T00:00:00.000Z".to_string(),
        outcome: "succeeded".to_string(),
        ..Default::default()
    });
    assert!(receipt.signature.is_none());

    let shape_opts = VerifyReceiptOptions {
        min_level: VerificationLevel::Shape,
        ..Default::default()
    };
    let result = verify_execution_receipt(&receipt, &shape_opts);
    assert!(result.valid);
    assert_eq!(result.level, VerificationLevel::Shape);

    let strict_opts = VerifyReceiptOptions {
        min_level: VerificationLevel::Cryptographic,
        ..Default::default()
    };
    let strict = verify_execution_receipt(&receipt, &strict_opts);
    assert!(!strict.valid);
    assert!(strict
        .warnings
        .unwrap()
        .iter()
        .any(|w| w.contains("no signature/issuer/keyId claim")));
}

fn make_chain() -> Vec<LineageReference> {
    let entry = |i: u64, prev_root: Option<&str>| LineageReference {
        schema: "cognitum.lineage-reference.v1".to_string(),
        subject: LineageSubject {
            request_id: "req_1".to_string(),
            operation_id: None,
        },
        leaf: Some(format!("leaf-{i}")),
        root: Some(format!("root-{i}")),
        sequence: Some(i),
        previous_checkpoint: prev_root.map(str::to_string),
        checkpoint_time: Some("2026-07-18T00:00:00.000Z".to_string()),
        canonicalization: None,
        issuer: None,
        key_id: None,
        signature: None,
        verification: fail_result("2026-07-18T00:00:00.000Z".to_string(), String::new()),
    };
    vec![entry(0, None), entry(1, Some("root-0")), entry(2, Some("root-1"))]
}

#[test]
fn accepts_a_well_formed_chain() {
    let opts = VerifyLineageChainOptions {
        min_level: VerificationLevel::Digest,
        ..Default::default()
    };
    let result = verify_lineage_chain(&make_chain(), &opts);
    assert!(result.valid);
    assert_eq!(result.results.len(), 3);
}

#[test]
fn single_entry_chain_achieves_only_shape() {
    let chain = vec![make_chain().remove(0)];
    let opts = VerifyLineageChainOptions {
        min_level: VerificationLevel::Shape,
        ..Default::default()
    };
    let result = verify_lineage_chain(&chain, &opts);
    assert!(result.valid);
    assert_eq!(result.level, VerificationLevel::Shape);

    let strict_opts = VerifyLineageChainOptions {
        min_level: VerificationLevel::Digest,
        ..Default::default()
    };
    let strict = verify_lineage_chain(&chain, &strict_opts);
    assert!(!strict.valid);
}

#[test]
fn rejects_a_chain_with_a_broken_link() {
    let mut chain = make_chain();
    chain[2].previous_checkpoint = Some("root-999".to_string());
    let opts = VerifyLineageChainOptions {
        min_level: VerificationLevel::Digest,
        ..Default::default()
    };
    let result = verify_lineage_chain(&chain, &opts);
    assert!(!result.valid);
    assert_eq!(result.broken_at_index, Some(2));
    assert!(result.failure.unwrap().contains("previousCheckpoint"));
}

#[test]
fn rejects_a_chain_containing_a_cycle() {
    let mut chain = make_chain();
    chain[2].root = Some("root-0".to_string());
    let opts = VerifyLineageChainOptions {
        min_level: VerificationLevel::Shape,
        ..Default::default()
    };
    let result = verify_lineage_chain(&chain, &opts);
    assert!(!result.valid);
    assert!(result.failure.unwrap().contains("cycle"));
}

#[test]
fn rejects_a_chain_whose_sequence_does_not_strictly_increase() {
    let mut chain = make_chain();
    chain[2].sequence = Some(1);
    let opts = VerifyLineageChainOptions {
        min_level: VerificationLevel::Shape,
        ..Default::default()
    };
    let result = verify_lineage_chain(&chain, &opts);
    assert!(!result.valid);
    assert!(result.failure.unwrap().contains("sequence"));
}

#[test]
fn iso_round_trip_matches_civil_to_unix_seconds() {
    let known = civil_to_unix_seconds(2026, 7, 18, 0, 0, 5).unwrap();
    assert_eq!(unix_to_iso(known, 0), "2026-07-18T00:00:05.000Z");
    assert_eq!(parse_rfc3339_unix("2026-07-18T00:00:05.000Z"), Some(known));
}
