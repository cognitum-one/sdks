//! `DiagnosticPolicy` / manifest-preview scaffolding (ADR-0028 §D10).
//! Tracking issue #70 (M6). This pass freezes the policy/manifest/bundle
//! shapes and implements the one piece of real logic §D10 actually
//! specifies at this layer -- "the SDK previews a manifest of categories
//! before capture" -- as a pure computation over a caller-supplied policy.
//!
//! Explicitly NOT in scope for this pass (matching the discipline already
//! established by `./telemetry.rs`'s `TelemetrySink` freeze and
//! `./receipts.rs`'s `ExecutionReceipt` freeze):
//! - no real capture/collection logic (no reading of prompts, source,
//!   patches, tool arguments, or environment values from anywhere);
//! - no upload logic -- per §D10, "Upload is a separate source-upload
//!   consent operation; capture never uploads automatically";
//! - no product client (`meta_llm`/`meta_proxy`/`metaharness`/`harnessaas`)
//!   references any symbol in this module yet.
//!
//! Sources: `docs/adr/0028-agentic-telemetry-usage-receipts-lineage-and-redaction.md`
//! §D10 (lines 325-343), reusing the §D12/§D13 `D12Category` taxonomy
//! already frozen in `./sentinel.rs`.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::agentic::sentinel::D12Category;

/// Where a captured diagnostic bundle is written (ADR-0028 §D10: "local
/// sink path or callback"). `Callback` is a marker discriminant only: this
/// pass has no real capture pipeline to invoke a callback from, so it does
/// not model an actual callback function type (design decision, not an ADR
/// quote) -- a future capture implementation attaches a real callback type
/// to this variant. Internally tagged on `kind` so the wire shape is
/// `{"kind":"local_path","path":"..."}` / `{"kind":"callback"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DiagnosticSink {
    LocalPath { path: String },
    Callback,
}

/// Retention/expiry policy for a captured diagnostic bundle (ADR-0028 §D10
/// "retention/expiry" bullet). `max_age_ms: None` means the caller has not
/// declared a retention bound in this pass -- no enforcement exists yet
/// (no capture pipeline exists to enforce it against).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionPolicy {
    pub max_age_ms: Option<u64>,
}

/// Caller-declared diagnostic-capture policy (ADR-0028 §D10). Every field
/// maps directly onto one bullet of the ADR's list:
/// - `included_fields` <- "included schema-classified fields". No
///   validation against a real field schema/registry exists in this pass
///   (design decision, not an ADR quote) -- this is a plain caller-supplied
///   list of field names the policy scopes capture to.
/// - `max_bytes` / `max_duration_ms` <- "maximum bytes and duration".
/// - `sink` <- "local sink path or callback".
/// - `encryption_required` / `access_expectation` <- "encryption and access
///   expectations". The ADR does not specify a structured shape here, so a
///   bool + free-text string is a deliberately simple, honest
///   simplification (design decision, not an ADR quote).
/// - `retention` <- "retention/expiry".
/// - `allowed_categories` <- "whether prompt, output, source, patch, tool,
///   and environment categories are individually allowed". Reuses the
///   existing [`D12Category`] taxonomy (`./sentinel.rs`) rather than a
///   parallel enum -- see [`D10_RELEVANT_CATEGORIES`] for the exact
///   6-of-11 mapping from §D10's prose names onto `D12Category` variants.
///
/// Constructing a `DiagnosticPolicy` performs no I/O, capture, or schema
/// validation -- it is a plain value type, mirroring how `TelemetrySink`
/// (`./telemetry.rs`) was frozen as an interface before any real emission
/// pipeline existed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticPolicy {
    pub included_fields: Vec<String>,
    pub max_bytes: u64,
    pub max_duration_ms: u64,
    pub sink: DiagnosticSink,
    pub encryption_required: bool,
    pub access_expectation: Option<String>,
    pub retention: RetentionPolicy,
    pub allowed_categories: HashSet<D12Category>,
}

/// The 6 of [`D12Category`]'s 11 variants that §D10 governs, in the ADR's
/// own prose order ("prompt, output, source, patch, tool, and environment
/// categories"). This mapping is a design decision, not a literal ADR
/// quote, since §D10 uses its own short names rather than the §D12/§D13
/// category names:
/// - prompt -> [`D12Category::Prompts`]
/// - output -> [`D12Category::Messages`]
/// - source -> [`D12Category::Source`]
/// - patch -> [`D12Category::Patches`]
/// - tool -> [`D12Category::ToolArgumentsResults`]
/// - environment -> [`D12Category::EnvironmentValues`]
pub const D10_RELEVANT_CATEGORIES: [D12Category; 6] = [
    D12Category::Prompts,
    D12Category::Messages,
    D12Category::Source,
    D12Category::Patches,
    D12Category::ToolArgumentsResults,
    D12Category::EnvironmentValues,
];

/// Hard-coded, policy-independent never-capturable set (ADR-0028 §D10):
/// "Credentials, signing private keys, proxy tokens, cookies, repository
/// credentials, and pre-signed URLs are never capturable." `D12Category`
/// has no finer split than [`D12Category::Credentials`] for signing keys,
/// proxy tokens, cookies, and repository credentials -- all are
/// secret-bearing authentication material, matching §D13's own key-name
/// rule, which already classifies "secret", "token", "password",
/// "accesskey" fields as `Credentials` regardless of which specific kind of
/// credential they hold; there is no separate `SigningKeys`/`ProxyTokens`/
/// `Cookies` category to map onto. [`D12Category::SignedUrls`] covers
/// pre-signed URLs directly. This mapping is a design decision, not a
/// literal ADR quote: it resolves the ADR's six-item prose list onto
/// exactly 2 `D12Category` variants, not 6, because the ADR's own taxonomy
/// is coarser than its prose list.
pub const NEVER_CAPTURABLE_CATEGORIES: [D12Category; 2] =
    [D12Category::Credentials, D12Category::SignedUrls];

/// Whether `category` is unconditionally excluded from capture, regardless
/// of what any [`DiagnosticPolicy::allowed_categories`] claims. This is the
/// real, enforced check backing [`preview_diagnostic_manifest`]'s hard
/// block -- not merely documentation.
pub fn is_never_capturable(category: D12Category) -> bool {
    NEVER_CAPTURABLE_CATEGORIES.contains(&category)
}

/// A preview of which §D10-relevant categories a policy would and would not
/// capture (ADR-0028 §D10: "The SDK previews a manifest of categories
/// before capture").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticManifest {
    pub would_capture: Vec<D12Category>,
    pub blocked_by_policy: Vec<D12Category>,
}

/// Computes the manifest a caller would see before capture starts. Pure
/// computation over `policy` -- performs no I/O and does not read, touch,
/// or capture any real prompt/source/patch/tool/environment content.
///
/// `would_capture` is the intersection of `policy.allowed_categories`
/// (restricted to [`D10_RELEVANT_CATEGORIES`]) minus
/// [`NEVER_CAPTURABLE_CATEGORIES`]. The hard block applies even if a
/// caller's policy explicitly lists [`D12Category::Credentials`] or
/// [`D12Category::SignedUrls`] in `allowed_categories` -- a policy can
/// never override it, which is why the loop below only ever iterates the
/// 6 §D10-relevant categories (neither hard-blocked category is a member of
/// that set, so neither can ever reach `would_capture` through this
/// function, no matter what the policy claims).
///
/// `blocked_by_policy` lists the §D10-relevant categories the policy did
/// NOT allow -- distinct from the hard-blocked categories, which never
/// appear in either list returned here since they are outside
/// [`D10_RELEVANT_CATEGORIES`] entirely.
pub fn preview_diagnostic_manifest(policy: &DiagnosticPolicy) -> DiagnosticManifest {
    let mut would_capture = Vec::new();
    let mut blocked_by_policy = Vec::new();
    for category in D10_RELEVANT_CATEGORIES {
        // Defensive re-check: D10_RELEVANT_CATEGORIES never contains a
        // hard-blocked category today, but this keeps the hard-block
        // invariant enforced in code (not just by the const's current
        // contents) if that set is ever edited in a future pass.
        if is_never_capturable(category) {
            continue;
        }
        if policy.allowed_categories.contains(&category) {
            would_capture.push(category);
        } else {
            blocked_by_policy.push(category);
        }
    }
    DiagnosticManifest { would_capture, blocked_by_policy }
}

/// Minimal redaction-report shape (ADR-0028 §D10: "Diagnostic bundles
/// include a redaction report..."). `SentinelSecretRedactor`
/// (`./sentinel.rs`) does not currently return a report-shaped value --
/// `redact`/`redact_value` return the redacted value itself, not a summary
/// of what was redacted -- so this is a new minimal type, matching the
/// "shape freeze" convention already used by `ExecutionReceipt`
/// (`./receipts.rs`): no bundle-construction pipeline computes a real value
/// for this type in this pass.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactionReport {
    pub redaction_count: u64,
    pub categories_redacted: Vec<D12Category>,
}

/// Frozen diagnostic-bundle field shape (ADR-0028 §D10): "Diagnostic
/// bundles include a redaction report, SDK and contract versions, and
/// SHA-256 digest." Type-only stub, matching `ExecutionReceipt`
/// (`./receipts.rs`)'s freeze discipline -- no bundle-construction pipeline
/// exists in this pass; nothing populates a `DiagnosticBundle` from real
/// captured content, and no upload logic exists (§D10: "capture never
/// uploads automatically").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticBundle {
    pub redaction_report: RedactionReport,
    pub sdk_version: String,
    pub contract_version: String,
    pub sha256_digest: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy_with_allowed(allowed: &[D12Category]) -> DiagnosticPolicy {
        DiagnosticPolicy {
            included_fields: vec!["field.example".to_string()],
            max_bytes: 1_048_576,
            max_duration_ms: 5_000,
            sink: DiagnosticSink::LocalPath { path: "/tmp/diagnostics".to_string() },
            encryption_required: true,
            access_expectation: Some("operator-only".to_string()),
            retention: RetentionPolicy { max_age_ms: Some(86_400_000) },
            allowed_categories: allowed.iter().copied().collect(),
        }
    }

    #[test]
    fn all_six_relevant_categories_allowed_yields_full_would_capture() {
        let policy = policy_with_allowed(&D10_RELEVANT_CATEGORIES);
        let manifest = preview_diagnostic_manifest(&policy);
        assert_eq!(manifest.would_capture.len(), 6);
        for category in D10_RELEVANT_CATEGORIES {
            assert!(manifest.would_capture.contains(&category));
        }
        assert!(manifest.blocked_by_policy.is_empty());
    }

    #[test]
    fn only_some_categories_allowed_splits_would_capture_and_blocked() {
        let policy =
            policy_with_allowed(&[D12Category::Prompts, D12Category::EnvironmentValues]);
        let manifest = preview_diagnostic_manifest(&policy);
        assert!(manifest.would_capture.contains(&D12Category::Prompts));
        assert!(manifest.would_capture.contains(&D12Category::EnvironmentValues));
        assert_eq!(manifest.would_capture.len(), 2);
        assert!(manifest.blocked_by_policy.contains(&D12Category::Messages));
        assert!(manifest.blocked_by_policy.contains(&D12Category::Source));
        assert!(manifest.blocked_by_policy.contains(&D12Category::Patches));
        assert!(manifest.blocked_by_policy.contains(&D12Category::ToolArgumentsResults));
        // EnvironmentValues was allowed, so it must NOT be blocked.
        assert!(!manifest.blocked_by_policy.contains(&D12Category::EnvironmentValues));
        assert_eq!(manifest.would_capture.len() + manifest.blocked_by_policy.len(), 6);
    }

    #[test]
    fn hard_block_wins_even_when_policy_explicitly_allows_credentials_and_signed_urls() {
        // The single most important test in this module: a policy that
        // tries to "allow" Credentials/SignedUrls (plus every §D10-relevant
        // category, so the hard block is the only thing that could exclude
        // them) must never see them show up in would_capture. The hard
        // block is policy-independent, per ADR-0028 §D10.
        let mut allowed: Vec<D12Category> = D10_RELEVANT_CATEGORIES.to_vec();
        allowed.push(D12Category::Credentials);
        allowed.push(D12Category::SignedUrls);
        let policy = policy_with_allowed(&allowed);

        assert!(policy.allowed_categories.contains(&D12Category::Credentials));
        assert!(policy.allowed_categories.contains(&D12Category::SignedUrls));

        let manifest = preview_diagnostic_manifest(&policy);
        assert!(!manifest.would_capture.contains(&D12Category::Credentials));
        assert!(!manifest.would_capture.contains(&D12Category::SignedUrls));
        assert!(!manifest.blocked_by_policy.contains(&D12Category::Credentials));
        assert!(!manifest.blocked_by_policy.contains(&D12Category::SignedUrls));
        // The 6 §D10-relevant categories are still fully captured.
        assert_eq!(manifest.would_capture.len(), 6);
    }

    #[test]
    fn is_never_capturable_covers_exactly_credentials_and_signed_urls() {
        assert!(is_never_capturable(D12Category::Credentials));
        assert!(is_never_capturable(D12Category::SignedUrls));
        assert!(!is_never_capturable(D12Category::Prompts));
        assert!(!is_never_capturable(D12Category::Messages));
        assert!(!is_never_capturable(D12Category::Source));
        assert!(!is_never_capturable(D12Category::Patches));
        assert!(!is_never_capturable(D12Category::ToolArgumentsResults));
        assert!(!is_never_capturable(D12Category::EnvironmentValues));
        assert!(!is_never_capturable(D12Category::WebhookBodies));
        assert!(!is_never_capturable(D12Category::RepositoryUrls));
        assert!(!is_never_capturable(D12Category::RawTenantUserIdentifiers));
    }

    #[test]
    fn empty_allowed_categories_blocks_everything() {
        let policy = policy_with_allowed(&[]);
        let manifest = preview_diagnostic_manifest(&policy);
        assert!(manifest.would_capture.is_empty());
        assert_eq!(manifest.blocked_by_policy.len(), 6);
    }

    #[test]
    fn diagnostic_policy_serializes_camel_case_and_round_trips() {
        let policy = policy_with_allowed(&[D12Category::Prompts, D12Category::Source]);
        let json = serde_json::to_value(&policy).unwrap();
        assert_eq!(json["includedFields"], serde_json::json!(["field.example"]));
        assert_eq!(json["maxBytes"], serde_json::json!(1_048_576));
        assert_eq!(json["sink"]["kind"], serde_json::json!("local_path"));
        assert_eq!(json["sink"]["path"], serde_json::json!("/tmp/diagnostics"));
        assert_eq!(json["encryptionRequired"], serde_json::json!(true));
        assert_eq!(json["retention"]["maxAgeMs"], serde_json::json!(86_400_000));

        let round_tripped: DiagnosticPolicy = serde_json::from_value(json).unwrap();
        assert_eq!(round_tripped.max_bytes, 1_048_576);
        assert_eq!(round_tripped.allowed_categories.len(), 2);
        assert!(round_tripped.allowed_categories.contains(&D12Category::Prompts));
    }

    #[test]
    fn diagnostic_sink_callback_variant_serializes_without_path() {
        let sink = DiagnosticSink::Callback;
        let json = serde_json::to_value(&sink).unwrap();
        assert_eq!(json, serde_json::json!({ "kind": "callback" }));
        let round_tripped: DiagnosticSink = serde_json::from_value(json).unwrap();
        assert_eq!(round_tripped, DiagnosticSink::Callback);
    }

    #[test]
    fn diagnostic_manifest_round_trips_through_json() {
        let manifest = DiagnosticManifest {
            would_capture: vec![D12Category::Prompts],
            blocked_by_policy: vec![D12Category::Source],
        };
        let json = serde_json::to_value(&manifest).unwrap();
        assert_eq!(json["wouldCapture"], serde_json::json!(["prompts"]));
        assert_eq!(json["blockedByPolicy"], serde_json::json!(["source"]));

        let round_tripped: DiagnosticManifest = serde_json::from_value(json).unwrap();
        assert_eq!(round_tripped, manifest);
    }

    #[test]
    fn diagnostic_bundle_round_trips_through_json() {
        let bundle = DiagnosticBundle {
            redaction_report: RedactionReport {
                redaction_count: 3,
                categories_redacted: vec![D12Category::Credentials, D12Category::Prompts],
            },
            sdk_version: "0.1.0".to_string(),
            contract_version: "1.0".to_string(),
            sha256_digest: "a".repeat(64),
        };
        let json = serde_json::to_value(&bundle).unwrap();
        assert_eq!(json["redactionReport"]["redactionCount"], serde_json::json!(3));
        assert_eq!(json["sdkVersion"], serde_json::json!("0.1.0"));

        let round_tripped: DiagnosticBundle = serde_json::from_value(json).unwrap();
        assert_eq!(round_tripped, bundle);
    }

    #[test]
    fn d10_relevant_categories_has_no_duplicates_and_excludes_hard_blocked() {
        let set: HashSet<D12Category> = D10_RELEVANT_CATEGORIES.iter().copied().collect();
        assert_eq!(set.len(), 6);
        assert!(!set.contains(&D12Category::Credentials));
        assert!(!set.contains(&D12Category::SignedUrls));
    }
}
