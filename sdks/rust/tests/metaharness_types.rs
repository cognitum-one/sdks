#![cfg(feature = "metaharness")]

use cognitum_one::agentic::VerificationLevel;
use cognitum_one::metaharness::{
    parse_harness_manifest, parse_witness_verification, RepositorySource, SCAFFOLD_PLAN_SCHEMA_V1,
    SCAFFOLD_REQUEST_SCHEMA_V1, SCAFFOLD_RESULT_SCHEMA_V1,
};
use serde_json::json;

#[test]
fn exact_schema_string_literals() {
    assert_eq!(
        SCAFFOLD_REQUEST_SCHEMA_V1,
        "cognitum.metaharness.scaffold-request.v1"
    );
    assert_eq!(
        SCAFFOLD_PLAN_SCHEMA_V1,
        "cognitum.metaharness.scaffold-plan.v1"
    );
    assert_eq!(
        SCAFFOLD_RESULT_SCHEMA_V1,
        "cognitum.metaharness.scaffold-result.v1"
    );
}

#[test]
fn repository_source_local_variant() {
    let source = RepositorySource::Local(cognitum_one::metaharness::LocalRepository {
        canonical_path: "/tmp/repo".to_owned(),
        expected_tree_digest: Some("sha256:abc123".to_owned()),
    });
    match source {
        RepositorySource::Local(local) => {
            assert_eq!(local.canonical_path, "/tmp/repo");
            assert_eq!(local.expected_tree_digest.as_deref(), Some("sha256:abc123"));
        }
        RepositorySource::Git(_) => panic!("expected Local variant"),
    }
}

#[test]
fn repository_source_git_variant() {
    let source = RepositorySource::Git(cognitum_one::metaharness::GitRepository {
        url: "https://github.com/ruvnet/metaharness.git".to_owned(),
        requested_ref: Some("main".to_owned()),
        resolved_commit_sha: "072b95c0a74610de008dca5473343a81619cef20".to_owned(),
        credential_reference: None,
    });
    match source {
        RepositorySource::Git(git) => {
            assert_eq!(
                git.resolved_commit_sha,
                "072b95c0a74610de008dca5473343a81619cef20"
            );
        }
        RepositorySource::Local(_) => panic!("expected Git variant"),
    }
}

#[test]
fn parse_harness_manifest_parses_every_documented_field() {
    let wire = json!({
        "schema": "cognitum.metaharness.manifest.v1",
        "generator": "metaharness-oss",
        "template": "default",
        "template_version": "0.0.0",
        "vars": { "projectName": "demo" },
        "hosts": ["claude-code"],
        "files": ["CLAUDE.md", ".claude/settings.json"],
        "generated_at": "2026-07-18T00:00:00Z",
        "meta": { "note": "generated" }
    });
    let manifest = parse_harness_manifest(&wire);
    assert_eq!(manifest.schema, "cognitum.metaharness.manifest.v1");
    assert_eq!(manifest.generator, "metaharness-oss");
    assert_eq!(manifest.template_version, "0.0.0");
    assert_eq!(manifest.hosts, vec!["claude-code".to_owned()]);
    assert_eq!(
        manifest.files,
        vec!["CLAUDE.md".to_owned(), ".claude/settings.json".to_owned()]
    );
    assert_eq!(manifest.generated_at, "2026-07-18T00:00:00Z");
    assert!(manifest.raw.is_empty());
}

#[test]
fn parse_harness_manifest_preserves_unknown_additive_fields() {
    let wire = json!({
        "schema": "cognitum.metaharness.manifest.v1",
        "generator": "metaharness-oss",
        "template": "default",
        "template_version": "0.0.0",
        "vars": {},
        "hosts": [],
        "files": [],
        "generated_at": "2026-07-18T00:00:00Z",
        "signing_key_id": "kid-123",
        "extension_block": { "future": true }
    });
    let manifest = parse_harness_manifest(&wire);
    assert_eq!(manifest.raw.len(), 2);
    assert_eq!(manifest.raw.get("signing_key_id").unwrap(), "kid-123");
    assert_eq!(
        manifest.raw.get("extension_block").unwrap(),
        &json!({ "future": true })
    );
}

#[test]
fn parse_witness_verification_parses_shape_level() {
    let wire = json!({
        "verification": {
            "level": "shape",
            "valid": true,
            "checked_at": "2026-07-18T00:00:00Z"
        },
        "witness_schema": "metaharness.witness.v1",
        "manifest_digest": "sha256:deadbeef",
        "entry_digests": ["sha256:aaa", "sha256:bbb"]
    });
    let result = parse_witness_verification(&wire);
    assert_eq!(result.verification.level, VerificationLevel::Shape);
    assert!(result.verification.valid);
    assert_eq!(
        result.witness_schema.as_deref(),
        Some("metaharness.witness.v1")
    );
    assert_eq!(result.manifest_digest.as_deref(), Some("sha256:deadbeef"));
    assert_eq!(
        result.entry_digests,
        Some(vec!["sha256:aaa".to_owned(), "sha256:bbb".to_owned()])
    );
}

#[test]
fn parse_witness_verification_shape_is_never_silently_escalated() {
    let wire = json!({
        "verification": {
            "level": "shape",
            "valid": true,
            "checked_at": "2026-07-18T00:00:00Z"
        }
    });
    let result = parse_witness_verification(&wire);
    assert_eq!(result.verification.level, VerificationLevel::Shape);
    assert_ne!(result.verification.level, VerificationLevel::Cryptographic);
    assert_ne!(result.verification.level, VerificationLevel::Anchored);
}

#[test]
fn parse_witness_verification_fails_closed_on_unrecognized_level() {
    let wire = json!({
        "verification": {
            "level": "MetaHarness-ADR-011-alternate-shape",
            "valid": true,
            "checked_at": "2026-07-18T00:00:00Z"
        }
    });
    let result = parse_witness_verification(&wire);
    assert_eq!(result.verification.level, VerificationLevel::None);
    assert!(!result.verification.valid);
    let warnings = result
        .verification
        .warnings
        .expect("should carry a warning");
    assert!(warnings[0]
        .to_lowercase()
        .contains("unknown verification level"));
}

#[test]
fn parse_witness_verification_preserves_unknown_top_level_fields() {
    let wire = json!({
        "verification": {
            "level": "digest",
            "valid": true,
            "checked_at": "2026-07-18T00:00:00Z"
        },
        "future_witness_extension": { "anchor_proof": "opaque-blob" }
    });
    let result = parse_witness_verification(&wire);
    assert_eq!(result.raw_unknown.len(), 1);
    assert_eq!(
        result.raw_unknown.get("future_witness_extension").unwrap(),
        &json!({ "anchor_proof": "opaque-blob" })
    );
}
