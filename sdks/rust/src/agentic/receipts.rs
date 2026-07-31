//! ExecutionReceipt / LineageReference type-only stubs (ADR-0028 §D7, §D9).
//! Tracking issue #56 builds these out further (verification, canonical
//! bytes, signature checks). This pass only freezes the field shapes.

use serde::{Deserialize, Serialize};

/// Ordered guarantee levels for any artifact/witness/receipt/lineage check
/// (ADR-0028 §D8). Declaration order is the guarantee order (`None` weakest,
/// `Anchored` strongest); `PartialOrd`/`Ord` derive from that order so
/// `receipt_verification` can compare achieved-vs-required levels directly.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationLevel {
    #[default]
    None,
    Shape,
    Digest,
    Cryptographic,
    Anchored,
}

/// Tagged verification outcome. `valid=true` at `shape` MUST NOT satisfy a
/// `cryptographic` requirement.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationResult {
    pub level: VerificationLevel,
    pub valid: bool,
    pub algorithm: Option<String>,
    pub key_id: Option<String>,
    pub checked_at: String,
    pub subject_digest: Option<String>,
    pub warnings: Option<Vec<String>>,
    pub failure: Option<String>,
}

/// Finality of a single cost observation within a receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CostFinality {
    Estimate,
    Reserved,
    Committed,
    ProviderReported,
    Invoiced,
}

/// A single labeled cost observation (ADR-0022 §D6 distinct-fields rule).
// `PartialEq` added by ADR-0024b D11 migration step 1 (issue #59) so
// `meta_llm::types::MetaLlmReceipt` (which embeds `Vec<CostObservation>`)
// and, transitively, `meta_llm::stream::OpenAiStreamEvent` can keep
// deriving `PartialEq` for their own equality checks/tests.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostObservation {
    pub source: String,
    pub amount: f64,
    pub currency: String,
    pub finality: CostFinality,
}

/// Receipt subject binding — binds to the operation and tenant without
/// exposing raw tenant credentials.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptSubject {
    pub request_id: String,
    pub operation_id: Option<String>,
    pub tenant_hash: Option<String>,
}

/// Verifiable common receipt envelope, v1 (ADR-0028 §D7). Type-only stub —
/// issue #56.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionReceipt {
    pub schema: String,
    pub receipt_id: String,
    pub product: String,
    pub contract_version: String,
    pub subject: ReceiptSubject,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub usage: Option<serde_json::Value>,
    pub costs: Vec<CostObservation>,
    pub outcome: String,
    pub artifact_digests: Option<Vec<String>>,
    pub lineage_root: Option<String>,
    pub canonicalization: Option<String>,
    pub issuer: Option<String>,
    pub key_id: Option<String>,
    pub signature: Option<String>,
    pub verification: VerificationResult,
}

/// Lineage subject binding.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineageSubject {
    pub request_id: String,
    pub operation_id: Option<String>,
}

/// Verifiable lineage proof reference, v1 (ADR-0028 §D9). Type-only stub —
/// issue #56.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineageReference {
    pub schema: String,
    pub subject: LineageSubject,
    pub leaf: Option<String>,
    pub root: Option<String>,
    pub sequence: Option<u64>,
    pub previous_checkpoint: Option<String>,
    pub checkpoint_time: Option<String>,
    pub canonicalization: Option<String>,
    pub issuer: Option<String>,
    pub key_id: Option<String>,
    pub signature: Option<String>,
    pub verification: VerificationResult,
}
