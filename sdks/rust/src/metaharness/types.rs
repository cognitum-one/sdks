//! `MetaHarnessClient` domain types (ADR-0026a §D3). Pure data shapes — no
//! bridge I/O, no process spawn. See `super::client` for why every
//! operation that would use these types is currently a fail-closed stub
//! (ADR-0026a §D7: the upstream bridge protocol these types describe does
//! not exist yet).
//!
//! Unknown additive fields and unknown enum variants are preserved
//! verbatim wherever the ADR requires it (§D3: "Types preserve unknown
//! additive response fields and unknown event variants. Unknown
//! security-sensitive enums block the dependent mutation or trust
//! claim."), following the same `raw`-map preservation convention
//! `crate::meta_proxy::status` uses.

use std::collections::HashMap;

use serde_json::Value;

use crate::agentic::{VerificationLevel, VerificationResult};

// ---------------------------------------------------------------------------
// RepositorySource — §D3 tagged union
// ---------------------------------------------------------------------------

/// A repository already materialized on local disk (ADR-0026a §D3).
#[derive(Debug, Clone)]
pub struct LocalRepository {
    pub canonical_path: String,
    pub expected_tree_digest: Option<String>,
}

/// A repository resolved from a remote Git URL to one exact commit (ADR-0026a §D3).
#[derive(Debug, Clone)]
pub struct GitRepository {
    pub url: String,
    pub requested_ref: Option<String>,
    pub resolved_commit_sha: String,
    pub credential_reference: Option<String>,
}

/// `RepositorySource = LocalRepository | GitRepository` (ADR-0026a §D3).
/// Rust's idiomatic equivalent of the tagged union — a two-variant enum
/// rather than a `kind: String` discriminant field.
#[derive(Debug, Clone)]
pub enum RepositorySource {
    Local(LocalRepository),
    Git(GitRepository),
}

// ---------------------------------------------------------------------------
// ScaffoldRequestV1
// ---------------------------------------------------------------------------

/// Schema literal for [`ScaffoldRequestV1`] (ADR-0026a §D3, verbatim).
pub const SCAFFOLD_REQUEST_SCHEMA_V1: &str = "cognitum.metaharness.scaffold-request.v1";

/// A non-mutating request to plan a new harness scaffold (ADR-0026a §D2, §D3).
#[derive(Debug, Clone)]
pub struct ScaffoldRequestV1 {
    pub name: String,
    pub template: String,
    pub primary_host: Option<String>,
    pub hosts: Vec<String>,
    pub description: Option<String>,
    pub target: String,
    /// ADR-0026a §D3 names this field without further specifying its
    /// shape; the upstream OSS generator's exact `darwin` semantics belong
    /// to the bridge contract (ADR-0026b, blocked per §D7). Typed as
    /// `serde_json::Value` rather than guessed at — same convention as
    /// `MetaProxyUpstreamReceipt` (`crate::meta_proxy::envelope`).
    pub darwin: Value,
    pub repository_source: Option<RepositorySource>,
}

impl ScaffoldRequestV1 {
    /// The schema literal this type always carries on the wire (ADR-0026a §D3).
    pub fn schema(&self) -> &'static str {
        SCAFFOLD_REQUEST_SCHEMA_V1
    }
}

// ---------------------------------------------------------------------------
// ScaffoldPlan
// ---------------------------------------------------------------------------

/// Schema literal for [`ScaffoldPlan`] (ADR-0026a §D3, verbatim).
pub const SCAFFOLD_PLAN_SCHEMA_V1: &str = "cognitum.metaharness.scaffold-plan.v1";

/// One planned filesystem action (ADR-0026a §D3: "actions:
/// List<FileAction>"). The ADR does not enumerate `kind`'s exact values, so
/// unknown additive fields are preserved verbatim under `raw` rather than
/// dropped.
#[derive(Debug, Clone)]
pub struct FileAction {
    pub kind: String,
    pub path: String,
    pub content_digest: Option<String>,
    pub raw: HashMap<String, Value>,
}

/// Generator product identity captured in a `ScaffoldPlan` (ADR-0026a §D3, §D4 hello).
#[derive(Debug, Clone)]
pub struct GeneratorIdentity {
    pub product: String,
    pub package_version: Option<String>,
    pub generator_version: Option<String>,
    pub source_revision: Option<String>,
    pub raw: HashMap<String, Value>,
}

/// Template identity captured in a `ScaffoldPlan` (ADR-0026a §D3).
#[derive(Debug, Clone)]
pub struct TemplateIdentity {
    pub template: String,
    pub template_version: Option<String>,
    pub raw: HashMap<String, Value>,
}

/// A deterministic, non-mutating scaffold plan (ADR-0026a §D2, §D3).
#[derive(Debug, Clone)]
pub struct ScaffoldPlan {
    pub plan_id: String,
    pub plan_digest: String,
    pub created_at: String,
    pub expires_at: String,
    pub generator_identity: GeneratorIdentity,
    pub template_identity: TemplateIdentity,
    pub repository_commit: Option<String>,
    pub canonical_target: String,
    pub target_before_digest: String,
    pub request_digest: String,
    pub actions: Vec<FileAction>,
    pub unresolved_variables: Vec<String>,
    pub warnings: Vec<String>,
    pub destructive: bool,
    pub estimated_files: u64,
    pub estimated_bytes: u64,
    /// Unknown additive fields preserved verbatim (ADR-0026a §D3).
    pub raw: HashMap<String, Value>,
}

impl ScaffoldPlan {
    pub fn schema(&self) -> &'static str {
        SCAFFOLD_PLAN_SCHEMA_V1
    }
}

// ---------------------------------------------------------------------------
// ApplyApproval
// ---------------------------------------------------------------------------

/// Caller approval binding one `scaffold()` call to an unexpired `ScaffoldPlan` (ADR-0026a §D2, §D3).
#[derive(Debug, Clone)]
pub struct ApplyApproval {
    pub plan_digest: String,
    pub approved_at: String,
    /// Opaque label, not an identity assertion (ADR-0026a §D3).
    pub approved_by: Option<String>,
}

// ---------------------------------------------------------------------------
// ScaffoldResult
// ---------------------------------------------------------------------------

/// Schema literal for [`ScaffoldResult`] (ADR-0026a §D3, verbatim).
pub const SCAFFOLD_RESULT_SCHEMA_V1: &str = "cognitum.metaharness.scaffold-result.v1";

/// The one terminal process outcome (ADR-0026a §D5). `CancelledAfterCommit`
/// still returns the committed result plus a cancellation flag rather than
/// pretending rollback occurred; `IndeterminateMutation` is high-severity
/// and blocks automatic recovery.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessCommitOutcome {
    Succeeded,
    Failed,
    CancelledBeforeCommit,
    CancelledAfterCommit,
    IndeterminateMutation,
}

/// One file materialized by a completed `scaffold()` call (ADR-0026a §D3).
#[derive(Debug, Clone)]
pub struct GeneratedFile {
    pub path: String,
    pub content_digest: Option<String>,
    pub raw: HashMap<String, Value>,
}

/// The upstream harness manifest, fields preserved verbatim (ADR-0026a §D3:
/// "The actual manifest fields are preserved: `schema`, `generator`,
/// `template`, `template_version`, `vars`, `hosts`, `files`,
/// `generated_at`, and optional `meta`."). Package version, generator
/// version, template version, bridge protocol, and source revision are
/// independent — the SDK never infers one from another.
#[derive(Debug, Clone)]
pub struct HarnessManifest {
    pub schema: String,
    pub generator: String,
    pub template: String,
    pub template_version: String,
    pub vars: HashMap<String, Value>,
    pub hosts: Vec<String>,
    pub files: Vec<String>,
    pub generated_at: String,
    pub meta: Option<HashMap<String, Value>>,
    /// Unknown additive fields preserved verbatim (ADR-0026a §D3).
    pub raw: HashMap<String, Value>,
}

/// Witness verification result (ADR-0026a §D3, wrapping ADR-0028's
/// five-level `VerificationResult` from `crate::agentic` — never
/// duplicated). `WitnessVerification(verification.level=Shape, valid=true)`
/// is never logged or serialized as cryptographically verified (§D3).
#[derive(Debug, Clone)]
pub struct WitnessVerification {
    pub verification: VerificationResult,
    pub witness_schema: Option<String>,
    pub manifest_digest: Option<String>,
    pub entry_digests: Option<Vec<String>>,
    /// Unknown additive fields preserved verbatim, per §D3/§D6.
    pub raw_unknown: HashMap<String, Value>,
}

/// `verifyWitness`'s input parameter (ADR-0026a §D2: `workspaceOrWitness:
/// RepositorySource | WitnessVerification`) — verify a fresh workspace from
/// scratch, or re-verify/upgrade an already-computed `WitnessVerification`
/// (e.g. escalating a prior `Shape`-level result to `Digest` or higher).
/// Node/Python express this as a union type; Rust's idiomatic equivalent is
/// this two-variant enum, matching the `RepositorySource` convention above.
/// Issue #102: this variant was previously missing from `verify_witness`'s
/// signature, which accepted only `&RepositorySource`.
#[derive(Debug, Clone)]
pub enum WorkspaceOrWitness {
    Workspace(RepositorySource),
    Witness(WitnessVerification),
}

impl From<RepositorySource> for WorkspaceOrWitness {
    fn from(source: RepositorySource) -> Self {
        Self::Workspace(source)
    }
}

impl From<WitnessVerification> for WorkspaceOrWitness {
    fn from(verification: WitnessVerification) -> Self {
        Self::Witness(verification)
    }
}

/// The result of a completed, committed (or cancelled) `scaffold()` call
/// (ADR-0026a §D2, §D3).
#[derive(Debug, Clone)]
pub struct ScaffoldResult {
    pub plan_digest: String,
    pub manifest: HarnessManifest,
    pub files: Vec<GeneratedFile>,
    pub target_after_digest: String,
    pub unresolved_variables: Vec<String>,
    pub commit_outcome: ProcessCommitOutcome,
    pub verification: WitnessVerification,
    /// Unknown additive fields preserved verbatim (ADR-0026a §D3).
    pub raw: HashMap<String, Value>,
}

impl ScaffoldResult {
    pub fn schema(&self) -> &'static str {
        SCAFFOLD_RESULT_SCHEMA_V1
    }
}

// ---------------------------------------------------------------------------
// Catalog descriptors and opaque operation results (§D2)
// ---------------------------------------------------------------------------

/// One entry of `list_templates()` (ADR-0026a §D2: "descriptor lists").
#[derive(Debug, Clone)]
pub struct TemplateDescriptor {
    pub id: String,
    pub raw: HashMap<String, Value>,
}

/// One entry of `list_hosts()` (ADR-0026a §D2: "descriptor lists").
#[derive(Debug, Clone)]
pub struct HostDescriptor {
    pub id: String,
    pub raw: HashMap<String, Value>,
}

/// Opaque payload type for operations whose result shape is entirely
/// bridge-defined and unpublished (ADR-0026a §D7 blockers #1-#3). A type
/// alias to `serde_json::Value` rather than a guessed-at struct, matching
/// `MetaProxyUpstreamReceipt`'s convention (`crate::meta_proxy::envelope`).
pub type RepositoryAnalysis = Value;
pub type RepositoryScore = Value;
pub type HarnessValidationResult = Value;
pub type HarnessComparisonResult = Value;

/// Lifecycle states for a locally owned process operation (ADR-0026a §D2,
/// §D5). Non-terminal states mirror `OperationState`
/// (`crate::agentic::operations`); terminal states are §D5's five
/// normative process outcomes verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessRunState {
    Pending,
    Running,
    Cancelling,
    Succeeded,
    Failed,
    CancelledBeforeCommit,
    CancelledAfterCommit,
    IndeterminateMutation,
}

/// `ProcessRun<T>` (ADR-0026a §D2): "a locally owned process operation ...
/// It is not a server-owned `OperationHandle`. Closing a client cancels
/// only processes owned by that client." No implementation of this trait
/// ships in this pass — every §D2 method fails closed (`super::client`)
/// before a bridge process, and therefore a `ProcessRun`, is ever created.
/// The trait exists so the declared method signatures are visible and
/// documented even while blocked.
pub trait ProcessRun<T> {
    fn id(&self) -> &str;
    fn state(&self) -> ProcessRunState;
}

// ---------------------------------------------------------------------------
// Wire parsing helpers — unknown-field / unknown-enum preservation (§D3, §D6)
// ---------------------------------------------------------------------------

fn known_manifest_keys() -> &'static [&'static str] {
    &[
        "schema",
        "generator",
        "template",
        "template_version",
        "vars",
        "hosts",
        "files",
        "generated_at",
        "meta",
    ]
}

fn as_object(value: &Value) -> HashMap<String, Value> {
    value
        .as_object()
        .map(|m| m.clone().into_iter().collect())
        .unwrap_or_default()
}

fn as_string(map: &HashMap<String, Value>, key: &str) -> String {
    map.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned()
}

fn as_string_vec(map: &HashMap<String, Value>, key: &str) -> Vec<String> {
    map.get(key)
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Parse a raw wire manifest object into [`HarnessManifest`], preserving
/// every field not in the ADR-0026a §D3 known-fields list under `raw`
/// rather than dropping it.
pub fn parse_harness_manifest(data: &Value) -> HarnessManifest {
    let obj = as_object(data);
    let known = known_manifest_keys();
    let raw: HashMap<String, Value> = obj
        .iter()
        .filter(|(k, _)| !known.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    HarnessManifest {
        schema: as_string(&obj, "schema"),
        generator: as_string(&obj, "generator"),
        template: as_string(&obj, "template"),
        template_version: as_string(&obj, "template_version"),
        vars: obj
            .get("vars")
            .and_then(|v| v.as_object())
            .map(|m| m.clone().into_iter().collect())
            .unwrap_or_default(),
        hosts: as_string_vec(&obj, "hosts"),
        files: as_string_vec(&obj, "files"),
        generated_at: as_string(&obj, "generated_at"),
        meta: obj
            .get("meta")
            .and_then(|v| v.as_object())
            .map(|m| m.clone().into_iter().collect()),
        raw,
    }
}

const KNOWN_VERIFICATION_LEVELS: &[&str] =
    &["none", "shape", "digest", "cryptographic", "anchored"];

fn parse_verification_level(s: &str) -> Option<VerificationLevel> {
    match s {
        "none" => Some(VerificationLevel::None),
        "shape" => Some(VerificationLevel::Shape),
        "digest" => Some(VerificationLevel::Digest),
        "cryptographic" => Some(VerificationLevel::Cryptographic),
        "anchored" => Some(VerificationLevel::Anchored),
        _ => None,
    }
}

/// Parse a raw wire witness-verification object into
/// [`WitnessVerification`].
///
/// Fails closed on an unrecognized `verification.level` (ADR-0026a §D3/§D6:
/// "Unknown security-sensitive enums block the dependent mutation or trust
/// claim.") — an unknown level is coerced to `VerificationLevel::None`/
/// `valid: false` rather than passed through as a trust claim the rest of
/// this SDK does not recognize.
pub fn parse_witness_verification(data: &Value) -> WitnessVerification {
    let obj = as_object(data);
    let verification_obj = obj.get("verification").map(as_object).unwrap_or_default();
    let reported_level = verification_obj.get("level").and_then(|v| v.as_str());
    let level_known = reported_level
        .map(|s| KNOWN_VERIFICATION_LEVELS.contains(&s))
        .unwrap_or(false);
    let level = reported_level
        .and_then(parse_verification_level)
        .unwrap_or(VerificationLevel::None);

    let mut warnings: Vec<String> = verification_obj
        .get("warnings")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    if !level_known {
        warnings.push(format!(
            "unknown verification level \"{}\" fails closed to \"none\" (ADR-0026a §D3/§D6)",
            reported_level.unwrap_or("")
        ));
    }

    let verification = VerificationResult {
        level,
        valid: if level_known {
            verification_obj
                .get("valid")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        } else {
            false
        },
        algorithm: verification_obj
            .get("algorithm")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        key_id: verification_obj
            .get("key_id")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        checked_at: as_string(&verification_obj, "checked_at"),
        subject_digest: verification_obj
            .get("subject_digest")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        warnings: if warnings.is_empty() {
            None
        } else {
            Some(warnings)
        },
        failure: verification_obj
            .get("failure")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
    };

    let known_top = [
        "verification",
        "witness_schema",
        "manifest_digest",
        "entry_digests",
    ];
    let raw_unknown: HashMap<String, Value> = obj
        .iter()
        .filter(|(k, _)| !known_top.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    WitnessVerification {
        verification,
        witness_schema: obj
            .get("witness_schema")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        manifest_digest: obj
            .get("manifest_digest")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        entry_digests: obj
            .get("entry_digests")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            }),
        raw_unknown,
    }
}
