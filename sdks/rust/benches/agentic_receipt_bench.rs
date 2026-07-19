//! Micro-benchmark: receipt/lineage emission overhead (ADR-0028 §D7-§D9,
//! issue #56 / PR #84) — the canonicalization + digest + parse path that
//! runs on every Meta LLM response carrying a `cognitum_receipt` field
//! (ADR-0024b §D3), and on every locally-constructed `ExecutionReceipt`.
//!
//! Three real, already-shipped functions are exercised:
//!   1. `meta_llm::parse_meta_llm_receipt` — decodes the wire
//!      `cognitum_receipt` payload into a typed `MetaLlmReceipt` on every
//!      nonstream/stream response (`meta_llm::types::receipt`'s doc
//!      comment).
//!   2. `agentic::build_execution_receipt` — constructs an
//!      `ExecutionReceipt`, which internally canonicalizes (JSON, sorted
//!      keys, JS-compatible number formatting) and SHA-256-digests the
//!      signable payload.
//!   3. `agentic::verify_execution_receipt` — re-canonicalizes and
//!      re-digests the receipt to verify it (shape + digest levels here;
//!      the `cryptographic` HMAC-signature branch is exercised by the
//!      SDK's own test suite, not this bench, to avoid adding `hmac`/`sha2`
//!      as bench-only dev-dependencies when they're already fully covered
//!      by `agentic::receipt_verification`'s own unit tests).
//!
//! The fixture receipt shape matches
//! `sdks/fixtures/receipt-canonicalization/execution-receipt-v1.json` (the
//! cross-SDK canonicalization conformance fixture from PR #84's review
//! fix), so the input size/shape here is representative of a real
//! receipt, not a toy one.
//!
//! Target (engineering estimate, NOT ADR-mandated — no ADR cites a
//! receipt-canonicalization latency number): p50 < 50 µs per operation.
//! This is a synchronous, allocation-heavy but otherwise CPU-only path (JSON
//! serialize + string sort + SHA-256 over a ~600-800 byte canonical
//! payload) — no I/O, so it should be at least an order of magnitude
//! cheaper than the seed client's ADR-0005 <1ms-p50 network-overhead
//! budget.
//!
//! Run it as an example:
//!
//! ```bash
//! cargo run --release --features meta-llm --example agentic_receipt_bench
//! # or, registered as a bench target:
//! cargo bench --features meta-llm --bench agentic_receipt_bench
//! ```

#![cfg(feature = "meta-llm")]

use std::time::{Duration, Instant};

use cognitum_one::agentic::{
    build_execution_receipt, canonical_json, sha256_hex, verify_execution_receipt,
    BuildExecutionReceiptInput, CostFinality, CostObservation, VerificationLevel,
    VerifyReceiptOptions,
};
use cognitum_one::meta_llm::parse_meta_llm_receipt;
use serde_json::json;

const ITERS: usize = 20_000;

fn measure<F: FnMut()>(label: &str, iters: usize, mut f: F) -> Duration {
    for _ in 0..200 {
        f();
    }
    let mut samples = Vec::with_capacity(iters);
    for _ in 0..iters {
        let t0 = Instant::now();
        f();
        samples.push(t0.elapsed());
    }
    samples.sort();
    let p50 = samples[iters / 2];
    let p95 = samples[(iters * 95) / 100];
    let mean: Duration = samples.iter().sum::<Duration>() / iters as u32;
    println!(
        "{label:55}  mean={:>9.3}µs  p50={:>9.3}µs  p95={:>9.3}µs",
        mean.as_secs_f64() * 1_000_000.0,
        p50.as_secs_f64() * 1_000_000.0,
        p95.as_secs_f64() * 1_000_000.0,
    );
    p50
}

/// Wire `cognitum_receipt` payload — shape/size representative of a real
/// Meta LLM chat-completions response receipt (routing, price, cache,
/// safety, breaker-count evidence).
fn wire_receipt_payload() -> serde_json::Value {
    json!({
        "request_id": "req_bench_0001",
        "resolved_tier": "large",
        "resolved_model": "meta-llm-large",
        "escalated": false,
        "cap_degraded": false,
        "routing_reason": "primary_healthy",
        "price": {"amount": "12.34", "currency": "USD"},
        "cache_result": "miss",
        "cache_savings": {"amount": "0.00", "currency": "USD"},
        "fallback_used": false,
        "breaker_counts": {"primary": 0, "fallback": 0},
        "sub_tenant_id": "tenant-bench-0001",
        "safety_summary": {
            "mode": "warn",
            "detector_classes": ["pii", "secrets"],
            "blocked": false
        },
        "usage": {
            "prompt_tokens": 128,
            "completion_tokens": 64,
            "total_tokens": 192,
            "cache_hit_ratio": 0.0
        },
        "costs": [
            {"source": "openrouter", "amount": 100.0, "currency": "USD", "finality": "invoiced"},
            {"source": "meta-llm", "amount": 12.34, "currency": "USD", "finality": "estimate"}
        ]
    })
}

/// Matches `sdks/fixtures/receipt-canonicalization/execution-receipt-v1.json`'s
/// `logicalReceipt` shape/size (issue #56 / PR #84 cross-SDK conformance
/// fixture).
fn build_receipt_input() -> BuildExecutionReceiptInput<'static> {
    BuildExecutionReceiptInput {
        receipt_id: "rcpt_bench_0001".to_owned(),
        product: "meta-llm".to_owned(),
        contract_version: "1.0.0".to_owned(),
        request_id: "req_bench_abc123".to_owned(),
        operation_id: Some("op_bench_xyz789".to_owned()),
        tenant_hash: Some("th_bench_deadbeef".to_owned()),
        started_at: "2026-01-01T00:00:00.000Z".to_owned(),
        completed_at: Some("2026-01-01T00:00:05.250Z".to_owned()),
        usage: Some(json!({
            "prompt_tokens": 128,
            "completion_tokens": 64,
            "cacheHitRatio": 0.5
        })),
        costs: vec![
            CostObservation {
                source: "openrouter".to_owned(),
                amount: 100.0,
                currency: "USD".to_owned(),
                finality: CostFinality::Invoiced,
            },
            CostObservation {
                source: "meta-llm".to_owned(),
                amount: 12.34,
                currency: "USD".to_owned(),
                finality: CostFinality::Estimate,
            },
        ],
        outcome: "success".to_owned(),
        artifact_digests: Some(vec![
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
        ]),
        lineage_root: Some(
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".to_owned(),
        ),
        issuer: Some("cognitum-one/meta-llm".to_owned()),
        key_id: Some("key-2026-01".to_owned()),
        sign: None,
        now: None,
    }
}

fn main() {
    println!("Receipt/lineage emission overhead — {ITERS} iterations each\n");

    // 1. Wire-receipt parse (runs on every Meta LLM response carrying a
    // `cognitum_receipt` field).
    let raw_payload = wire_receipt_payload();
    measure("parse_meta_llm_receipt", ITERS, || {
        let receipt = parse_meta_llm_receipt(&raw_payload);
        assert!(receipt.is_some());
    });

    // 2. build_execution_receipt — construction + canonicalization + digest
    // (no signer configured; see module doc comment).
    measure("build_execution_receipt", ITERS, || {
        let receipt = build_execution_receipt(build_receipt_input());
        assert_eq!(receipt.verification.level, VerificationLevel::Shape);
    });

    // 3. verify_execution_receipt — re-canonicalize + re-digest an
    // already-built receipt (the read-side counterpart of #2).
    let sample_receipt = build_execution_receipt(build_receipt_input());
    measure("verify_execution_receipt (shape+digest)", ITERS, || {
        let result = verify_execution_receipt(
            &sample_receipt,
            &VerifyReceiptOptions {
                min_level: VerificationLevel::Digest,
                expected_digest: None,
                resolve_key: None,
                check_anchor: None,
                now: None,
            },
        );
        assert!(result.subject_digest.is_some());
    });

    // 4. canonical_json + sha256_hex alone (the shared primitive both (2)
    // and (3) call internally) — isolates the pure canonicalization/digest
    // cost from receipt-shape validation overhead.
    let value = serde_json::to_value(&sample_receipt).expect("receipt should serialize");
    measure("canonical_json + sha256_hex (primitive)", ITERS, || {
        let bytes = canonical_json(&value);
        let digest = sha256_hex(&bytes);
        assert_eq!(digest.len(), 64);
    });

    println!("\nAll four operations are expected to clear p50 < 50µs (engineering target, not ADR-mandated).");
}
