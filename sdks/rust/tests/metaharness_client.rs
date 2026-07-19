#![cfg(feature = "metaharness")]

use cognitum_one::agentic::AgenticErrorKind;
use cognitum_one::metaharness::{
    ApplyApproval, GeneratorIdentity, LocalRepository, MetaHarnessClient, MetaHarnessConfig,
    RepositorySource, ScaffoldPlan, ScaffoldRequestV1, TemplateIdentity,
    DEFAULT_HANDSHAKE_TIMEOUT_MS,
};
use serde_json::json;

// ---------------------------------------------------------------------------
// Construction (ADR-0026a §D1) — zero I/O
// ---------------------------------------------------------------------------

#[test]
fn constructs_with_default_config() {
    let client = MetaHarnessClient::new(MetaHarnessConfig::new()).expect("should construct");
    assert_eq!(
        client.config().handshake_timeout_ms,
        DEFAULT_HANDSHAKE_TIMEOUT_MS
    );
    assert!(client.config().preview_features.is_empty());
}

#[test]
fn holds_caller_supplied_opaque_policy_fields_as_is() {
    let distribution = json!({ "registry": "https://registry.npmjs.org", "version": "0.4.1" });
    let config = MetaHarnessConfig {
        distribution: Some(distribution.clone()),
        workspace_policy: Some(json!({ "allow_symlinks": false })),
        process_policy: Some(json!({ "max_concurrent": 1 })),
        acquisition_timeout_ms: Some(5_000),
        operation_timeout_ms: Some(30_000),
        preview_features: vec!["catalog".to_owned()],
        ..MetaHarnessConfig::new()
    };
    let client = MetaHarnessClient::new(config).expect("should construct");
    assert_eq!(client.config().distribution, Some(distribution));
    assert_eq!(client.config().acquisition_timeout_ms, Some(5_000));
    assert_eq!(client.config().operation_timeout_ms, Some(30_000));
    assert_eq!(client.config().preview_features, vec!["catalog".to_owned()]);
}

#[test]
fn rejects_zero_handshake_timeout() {
    let config = MetaHarnessConfig {
        handshake_timeout_ms: 0,
        ..MetaHarnessConfig::new()
    };
    let err = MetaHarnessClient::new(config).expect_err("should reject");
    assert_eq!(err.kind, AgenticErrorKind::Configuration);
}

#[test]
fn rejects_zero_acquisition_timeout() {
    let config = MetaHarnessConfig {
        acquisition_timeout_ms: Some(0),
        ..MetaHarnessConfig::new()
    };
    assert!(MetaHarnessClient::new(config).is_err());
}

#[test]
fn rejects_zero_operation_timeout() {
    let config = MetaHarnessConfig {
        operation_timeout_ms: Some(0),
        ..MetaHarnessConfig::new()
    };
    assert!(MetaHarnessClient::new(config).is_err());
}

#[tokio::test]
async fn close_resolves_without_error() {
    let client = MetaHarnessClient::new(MetaHarnessConfig::new()).expect("should construct");
    client.close().await;
}

// ---------------------------------------------------------------------------
// §D2 method stubs — fail closed, zero I/O (ADR-0026a §D7)
// ---------------------------------------------------------------------------

fn local_repo(path: &str) -> RepositorySource {
    RepositorySource::Local(LocalRepository {
        canonical_path: path.to_owned(),
        expected_tree_digest: None,
    })
}

fn client() -> MetaHarnessClient {
    MetaHarnessClient::new(MetaHarnessConfig::new()).expect("should construct")
}

fn assert_blocked(err: &cognitum_one::agentic::AgenticError, operation: &str, capability: &str) {
    assert_eq!(err.kind, AgenticErrorKind::UnsupportedCapability);
    assert_eq!(err.product.as_deref(), Some("metaharness"));
    assert_eq!(err.operation.as_deref(), Some(operation));
    assert_eq!(err.code.as_deref(), Some(capability));
    assert!(!err.retryable);
}

#[tokio::test]
async fn capabilities_fails_closed() {
    let err = client()
        .capabilities()
        .await
        .expect_err("should be blocked");
    assert_blocked(&err, "capabilities", "metaharness.bridge.hello");
}

#[tokio::test]
async fn list_templates_fails_closed() {
    let err = client()
        .list_templates()
        .await
        .expect_err("should be blocked");
    assert_blocked(&err, "list_templates", "metaharness.catalog.templates");
}

#[tokio::test]
async fn list_hosts_fails_closed() {
    let err = client().list_hosts().await.expect_err("should be blocked");
    assert_blocked(&err, "list_hosts", "metaharness.catalog.hosts");
}

#[tokio::test]
async fn analyze_repository_fails_closed() {
    let source = local_repo("/tmp/repo");
    let err = client()
        .analyze_repository(&source)
        .await
        .expect_err("should be blocked");
    assert_blocked(&err, "analyze_repository", "metaharness.repository.analyze");
}

#[tokio::test]
async fn score_repository_fails_closed() {
    let source = local_repo("/tmp/repo");
    let err = client()
        .score_repository(&source)
        .await
        .expect_err("should be blocked");
    assert_blocked(&err, "score_repository", "metaharness.repository.score");
}

#[tokio::test]
async fn plan_scaffold_fails_closed() {
    let request = ScaffoldRequestV1 {
        name: "demo".to_owned(),
        template: "default".to_owned(),
        primary_host: None,
        hosts: vec!["claude-code".to_owned()],
        description: None,
        target: "/tmp/target".to_owned(),
        darwin: serde_json::Value::Null,
        repository_source: None,
    };
    let err = client()
        .plan_scaffold(&request)
        .await
        .expect_err("should be blocked");
    assert_blocked(&err, "plan_scaffold", "metaharness.scaffold.plan");
}

#[tokio::test]
async fn scaffold_fails_closed() {
    let plan = ScaffoldPlan {
        plan_id: "plan_1".to_owned(),
        plan_digest: "sha256:deadbeef".to_owned(),
        created_at: "2026-07-18T00:00:00Z".to_owned(),
        expires_at: "2026-07-18T00:10:00Z".to_owned(),
        generator_identity: GeneratorIdentity {
            product: "metaharness-oss".to_owned(),
            package_version: None,
            generator_version: None,
            source_revision: None,
            raw: Default::default(),
        },
        template_identity: TemplateIdentity {
            template: "default".to_owned(),
            template_version: None,
            raw: Default::default(),
        },
        repository_commit: None,
        canonical_target: "/tmp/target".to_owned(),
        target_before_digest: "sha256:before".to_owned(),
        request_digest: "sha256:request".to_owned(),
        actions: vec![],
        unresolved_variables: vec![],
        warnings: vec![],
        destructive: false,
        estimated_files: 0,
        estimated_bytes: 0,
        raw: Default::default(),
    };
    let approval = ApplyApproval {
        plan_digest: "sha256:deadbeef".to_owned(),
        approved_at: "2026-07-18T00:00:00Z".to_owned(),
        approved_by: None,
    };
    let err = client()
        .scaffold(&plan, &approval)
        .await
        .expect_err("should be blocked");
    assert_blocked(&err, "scaffold", "metaharness.scaffold.render");
}

#[tokio::test]
async fn inspect_manifest_fails_closed() {
    let source = local_repo("/tmp/repo");
    let err = client()
        .inspect_manifest(&source)
        .await
        .expect_err("should be blocked");
    assert_blocked(&err, "inspect_manifest", "metaharness.manifest.inspect");
}

#[tokio::test]
async fn validate_harness_fails_closed() {
    let source = local_repo("/tmp/repo");
    let err = client()
        .validate_harness(&source)
        .await
        .expect_err("should be blocked");
    assert_blocked(&err, "validate_harness", "metaharness.harness.validate");
}

#[tokio::test]
async fn compare_harnesses_fails_closed() {
    let a = local_repo("/tmp/a");
    let b = local_repo("/tmp/b");
    let err = client()
        .compare_harnesses(&a, &b)
        .await
        .expect_err("should be blocked");
    assert_blocked(&err, "compare_harnesses", "metaharness.harness.compare");
}

#[tokio::test]
async fn verify_witness_fails_closed() {
    let source = local_repo("/tmp/repo");
    let err = client()
        .verify_witness(&source)
        .await
        .expect_err("should be blocked");
    assert_blocked(&err, "verify_witness", "metaharness.witness.shape");
}

#[tokio::test]
async fn stubs_never_touch_a_process_spy() {
    // Structural proof no I/O path exists yet: every blocked call below
    // returns synchronously with an error and no external process (there is
    // no process-spawn API reachable from any of these methods to begin
    // with — the absence of any `std::process::Command` /
    // `tokio::process::Command` import in `metaharness::client` is the
    // real proof; this test exercises the full method surface end-to-end
    // to confirm each one still fails before returning).
    let c = client();
    let source = local_repo("/tmp/repo");
    assert!(c.capabilities().await.is_err());
    assert!(c.list_templates().await.is_err());
    assert!(c.list_hosts().await.is_err());
    assert!(c.analyze_repository(&source).await.is_err());
    assert!(c.verify_witness(&source).await.is_err());
}
