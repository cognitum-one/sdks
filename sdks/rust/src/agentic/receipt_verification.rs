//! `ExecutionReceipt` / `LineageReference` construction + verification
//! (issue #56, building out the ADR-0028 §D7-§D9 type-only stubs from #79).
//!
//! Deliberate scope limits (documented rather than silently skipped):
//! - Signatures are HMAC-SHA256 (symmetric, caller-supplied key resolver),
//!   not asymmetric Ed25519. ADR-0028 §D7 asks for "a discoverable, rotatable
//!   verification key" without mandating an algorithm; a full asymmetric PKI
//!   (key discovery/rotation service) is out of scope for this pass.
//! - `anchored` (§D8) requires an externally durable checkpoint/proof. This
//!   module only calls an optional caller-supplied `check_anchor` callback;
//!   it does not implement or assume any specific anchor/ledger service.
//! - Timestamp parsing accepts only UTC `Z`-suffixed RFC3339 (no numeric
//!   zone offsets) to avoid pulling in a `chrono` dependency for this pass.
//!   Every timestamp this module produces is `Z`-suffixed.
//!
//! Split across files to stay under the repo's 500-line-per-file rule:
//! this file holds shared primitives (timestamps, canonical bytes/digests)
//! plus construction and shape checks; [`verify`] holds the two public
//! verification entry points; `tests.rs` holds the test suite.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::agentic::receipts::{
    CostObservation, ExecutionReceipt, LineageReference, ReceiptSubject, VerificationLevel,
    VerificationResult,
};
use crate::retry_hint::civil_to_unix_seconds;

mod verify;
pub use verify::{
    verify_execution_receipt, verify_lineage_chain, KeyResolver, LineageChainVerification,
    VerifyLineageChainOptions, VerifyReceiptOptions,
};

#[cfg(test)]
#[path = "receipt_verification/tests.rs"]
mod tests;

const CANONICALIZATION_VERSION: &str = "cognitum-canonical-json-v1";

fn level_label(level: VerificationLevel) -> &'static str {
    match level {
        VerificationLevel::None => "none",
        VerificationLevel::Shape => "shape",
        VerificationLevel::Digest => "digest",
        VerificationLevel::Cryptographic => "cryptographic",
        VerificationLevel::Anchored => "anchored",
    }
}

fn ok_result(level: VerificationLevel, checked_at: String) -> VerificationResult {
    VerificationResult {
        level,
        valid: true,
        algorithm: None,
        key_id: None,
        checked_at,
        subject_digest: None,
        warnings: None,
        failure: None,
    }
}

fn fail_result(checked_at: String, failure: String) -> VerificationResult {
    VerificationResult {
        level: VerificationLevel::None,
        valid: false,
        algorithm: None,
        key_id: None,
        checked_at,
        subject_digest: None,
        warnings: None,
        failure: Some(failure),
    }
}

// ---------------------------------------------------------------------------
// Timestamps (minimal RFC3339 subset; see module docs for scope limit)
// ---------------------------------------------------------------------------

fn parse_rfc3339_unix(s: &str) -> Option<i64> {
    if s.len() < 20 || !(s.ends_with('Z') || s.ends_with('z')) {
        return None;
    }
    let year: i32 = s.get(0..4)?.parse().ok()?;
    if s.as_bytes().get(4).copied() != Some(b'-') {
        return None;
    }
    let month: u32 = s.get(5..7)?.parse().ok()?;
    if s.as_bytes().get(7).copied() != Some(b'-') {
        return None;
    }
    let day: u32 = s.get(8..10)?.parse().ok()?;
    match s.as_bytes().get(10).copied() {
        Some(b'T') | Some(b't') | Some(b' ') => {}
        _ => return None,
    }
    let hour: u32 = s.get(11..13)?.parse().ok()?;
    if s.as_bytes().get(13).copied() != Some(b':') {
        return None;
    }
    let minute: u32 = s.get(14..16)?.parse().ok()?;
    if s.as_bytes().get(16).copied() != Some(b':') {
        return None;
    }
    let second: u32 = s.get(17..19)?.parse().ok()?;
    civil_to_unix_seconds(year, month, day, hour, minute, second)
}

/// Inverse of [`civil_to_unix_seconds`] (Howard Hinnant's `civil_from_days`).
fn unix_to_iso(unix_secs: i64, millis: u32) -> String {
    let z = unix_secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    let secs_of_day = unix_secs.rem_euclid(86_400);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn now_iso() -> String {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    unix_to_iso(dur.as_secs() as i64, dur.subsec_millis())
}

// ---------------------------------------------------------------------------
// Canonical bytes + digests
// ---------------------------------------------------------------------------

/// Deterministic JSON: `serde_json`'s default `Map` is a `BTreeMap` (this
/// crate does not enable the `preserve_order` feature), so `to_string`
/// already emits recursively sorted object keys with no whitespace.
pub fn canonical_json(value: &serde_json::Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

pub fn sha256_hex(bytes: &str) -> String {
    hex_encode(&Sha256::digest(bytes.as_bytes()))
}

type HmacSha256 = Hmac<Sha256>;

fn hmac_sha256_hex(key: &[u8], bytes: &str) -> String {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(bytes.as_bytes());
    hex_encode(&mac.finalize().into_bytes())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

/// Constant-time-for-equal-length hex comparison (no early bit-level exit).
fn constant_time_hex_eq(a: &str, b: &str) -> bool {
    let (Some(ba), Some(bb)) = (hex_decode(a), hex_decode(b)) else {
        return false;
    };
    if ba.is_empty() || ba.len() != bb.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in ba.iter().zip(bb.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn receipt_signable_value(r: &ExecutionReceipt) -> serde_json::Value {
    let mut v = serde_json::to_value(r).expect("ExecutionReceipt always serializes");
    if let Some(obj) = v.as_object_mut() {
        obj.remove("signature");
        obj.remove("verification");
    }
    v
}

fn lineage_signable_value(l: &LineageReference) -> serde_json::Value {
    let mut v = serde_json::to_value(l).expect("LineageReference always serializes");
    if let Some(obj) = v.as_object_mut() {
        obj.remove("signature");
        obj.remove("verification");
    }
    v
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/// Inputs to [`build_execution_receipt`]. Closures are borrowed only for the
/// duration of the call (not stored on the resulting receipt).
#[derive(Default)]
pub struct BuildExecutionReceiptInput<'a> {
    pub receipt_id: String,
    pub product: String,
    pub contract_version: String,
    pub request_id: String,
    pub operation_id: Option<String>,
    pub tenant_hash: Option<String>,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub usage: Option<serde_json::Value>,
    pub costs: Vec<CostObservation>,
    pub outcome: String,
    pub artifact_digests: Option<Vec<String>>,
    pub lineage_root: Option<String>,
    pub issuer: Option<String>,
    pub key_id: Option<String>,
    /// Optional signer; if supplied, signs the canonical (unsigned) payload.
    pub sign: Option<&'a dyn Fn(&str) -> String>,
    pub now: Option<&'a dyn Fn() -> String>,
}

/// Builds an `ExecutionReceiptV1` from operation metadata, usage/cost, and
/// timestamps (ADR-0028 §D7).
pub fn build_execution_receipt(input: BuildExecutionReceiptInput<'_>) -> ExecutionReceipt {
    let checked_at = input.now.map_or_else(now_iso, |f| f());

    let mut receipt = ExecutionReceipt {
        schema: "cognitum.execution-receipt.v1".to_string(),
        receipt_id: input.receipt_id,
        product: input.product,
        contract_version: input.contract_version,
        subject: ReceiptSubject {
            request_id: input.request_id,
            operation_id: input.operation_id,
            tenant_hash: input.tenant_hash,
        },
        started_at: input.started_at,
        completed_at: input.completed_at,
        usage: input.usage,
        costs: input.costs,
        outcome: input.outcome,
        artifact_digests: input.artifact_digests,
        lineage_root: input.lineage_root,
        canonicalization: Some(CANONICALIZATION_VERSION.to_string()),
        issuer: input.issuer,
        key_id: input.key_id,
        signature: None,
        verification: fail_result(checked_at.clone(), String::new()),
    };

    if let Some(sign) = input.sign {
        let canonical = canonical_json(&receipt_signable_value(&receipt));
        receipt.signature = Some(sign(&canonical));
    }

    receipt.verification = match shape_check_execution_receipt(&receipt) {
        Some(failure) => fail_result(checked_at, failure),
        None => ok_result(VerificationLevel::Shape, checked_at),
    };

    receipt
}

// ---------------------------------------------------------------------------
// Shape checks (structural completeness only — §D8 `shape`)
// ---------------------------------------------------------------------------

pub fn shape_check_execution_receipt(r: &ExecutionReceipt) -> Option<String> {
    if r.schema != "cognitum.execution-receipt.v1" {
        return Some("unexpected schema tag".to_string());
    }
    if r.receipt_id.is_empty() {
        return Some("receipt_id is required".to_string());
    }
    if r.product.is_empty() {
        return Some("product is required".to_string());
    }
    if r.contract_version.is_empty() {
        return Some("contract_version is required".to_string());
    }
    if r.subject.request_id.is_empty() {
        return Some("subject.request_id is required".to_string());
    }
    let started = match parse_rfc3339_unix(&r.started_at) {
        Some(t) => t,
        None => return Some("started_at must be a parseable timestamp".to_string()),
    };
    if let Some(completed_at) = &r.completed_at {
        let completed = match parse_rfc3339_unix(completed_at) {
            Some(t) => t,
            None => return Some("completed_at must be a parseable timestamp".to_string()),
        };
        if completed < started {
            return Some("completed_at precedes started_at".to_string());
        }
    }
    if r.outcome.is_empty() {
        return Some("outcome is required".to_string());
    }
    for cost in &r.costs {
        if cost.source.is_empty() {
            return Some("cost.source is required".to_string());
        }
        if !cost.amount.is_finite() {
            return Some("cost.amount must be a finite number".to_string());
        }
        if cost.currency.is_empty() {
            return Some("cost.currency is required".to_string());
        }
    }
    None
}

pub fn shape_check_lineage_reference(l: &LineageReference) -> Option<String> {
    if l.schema != "cognitum.lineage-reference.v1" {
        return Some("unexpected schema tag".to_string());
    }
    if l.subject.request_id.is_empty() {
        return Some("subject.request_id is required".to_string());
    }
    None
}
