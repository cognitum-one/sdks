#![cfg(feature = "harnessaas")]

//! Tests for `HarnessaaSClient` construction and the real `health()`/
//! `solve()`/`lineage()` implementations (issue #67/#68 / M5 start).
//!
//! Scope note: this pass covers ONLY the real, deployed, synchronous
//! upstream surface -- no job/poll/SSE/approval/cancel method exists on
//! this client (ADR-0027a's async "Decision" section is a proposal, not a
//! description of the running service -- see
//! `cognitum_one::harnessaas::client`'s module doc comment).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use cognitum_one::agentic::static_api_key_provider::{
    StaticApiKeyCredentialProvider, StaticApiKeyCredentialProviderOptions,
};
use cognitum_one::agentic::{
    AgenticError, AgenticErrorKind, CapabilitySet, CapabilitySource, Credential,
    CredentialAuthority, CredentialProvider, CredentialRequest, RedactedSecret,
};
use cognitum_one::harnessaas::{
    HarnessaaSClient, HarnessaaSClientConfig, HarnessaaSSolveRequest, HarnessaaSVertical,
};
use serde_json::json;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn credential_provider(base_url: &str) -> Arc<StaticApiKeyCredentialProvider> {
    Arc::new(
        StaticApiKeyCredentialProvider::new(
            "harnessaas",
            base_url,
            base_url,
            StaticApiKeyCredentialProviderOptions {
                api_key: Some("cog_test_canary_1234".to_owned()),
                ..Default::default()
            },
        )
        .expect("provider should construct"),
    )
}

/// Credential provider that returns a fresh secret each `acquire()` call,
/// so the 401-refresh-once test can distinguish "first credential" from
/// "refreshed credential".
#[derive(Debug, Default)]
struct RefreshingCredentialProvider {
    acquire_calls: AtomicUsize,
    invalidate_calls: AtomicUsize,
}

#[async_trait]
impl CredentialProvider for RefreshingCredentialProvider {
    async fn describe_authority(
        &self,
        request: &CredentialRequest,
    ) -> Result<CredentialAuthority, AgenticError> {
        Ok(CredentialAuthority {
            provider_fingerprint: "refreshing".to_owned(),
            product: request.product.clone(),
            normalized_origin: request.normalized_origin.clone(),
            audience: request.audience.clone(),
            principal: None,
            tenant: None,
            delegated_subtenant: None,
            effective_scopes: None,
            plan: None,
        })
    }

    async fn acquire(&self, request: &CredentialRequest) -> Result<Credential, AgenticError> {
        let n = self.acquire_calls.fetch_add(1, Ordering::SeqCst);
        let secret = if n == 0 { "cog_v1" } else { "cog_v2" };
        Ok(Credential {
            scheme: "X-API-Key".to_owned(),
            secret: RedactedSecret::new(secret),
            expires_at: None,
            granted_scopes: None,
            audience: request.audience.clone(),
            source: "refreshing".to_owned(),
            authority: CredentialAuthority {
                provider_fingerprint: "refreshing".to_owned(),
                product: request.product.clone(),
                normalized_origin: request.normalized_origin.clone(),
                audience: request.audience.clone(),
                principal: None,
                tenant: None,
                delegated_subtenant: None,
                effective_scopes: None,
                plan: None,
            },
        })
    }

    fn identity(&self) -> String {
        "refreshing-credential-provider".to_owned()
    }

    async fn invalidate(&self, _reason: &str) {
        self.invalidate_calls.fetch_add(1, Ordering::SeqCst);
    }
}

fn insecure_config(base_url: impl Into<String>) -> HarnessaaSClientConfig {
    let mut config = HarnessaaSClientConfig::new(base_url);
    config.allow_insecure_http = true;
    config
}

fn solve_request() -> HarnessaaSSolveRequest {
    HarnessaaSSolveRequest::new(
        "https://github.com/acme/widget.git",
        "pytest -k test_widget",
        "Widget renders twice",
    )
}

fn solve_response_body() -> serde_json::Value {
    json!({
        "request_id": "req_abc123",
        "patch": "diff --git a/widget.py b/widget.py\n...",
        "resolved": true,
        "cost_receipt": {
            "request_id": "req_abc123",
            "model": "deepseek/deepseek-chat",
            "mode": "empty-patch-cascade",
            "tokens_in": 220,
            "tokens_out": 90,
            "cost_usd": 0.005,
            "route": "base",
            "escalated": false
        },
        "lineage_ref": "lineageOf:req_abc123",
        "conformance": {
            "usedOracleDuringSolve": false,
            "statement": "solver saw only the customer test_command output",
            "visibleInputsDigest": "sha256:deadbeef"
        }
    })
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

#[test]
fn construction_performs_no_io_and_requires_https() {
    let config = HarnessaaSClientConfig::new("https://harnessaas.test.cognitum.one");
    assert!(HarnessaaSClient::new(config).is_ok());
}

#[test]
fn rejects_non_https_base_url_by_default() {
    let config = HarnessaaSClientConfig::new("http://127.0.0.1:9999");
    let err = HarnessaaSClient::new(config).unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Configuration);
}

#[test]
fn allows_non_https_base_url_when_opted_in() {
    let config = insecure_config("http://127.0.0.1:9999");
    assert!(HarnessaaSClient::new(config).is_ok());
}

#[test]
fn rejects_missing_base_url() {
    let config = HarnessaaSClientConfig::new("");
    let err = HarnessaaSClient::new(config).unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Configuration);
}

#[test]
fn capabilities_returns_intersection_safe_default() {
    let config = HarnessaaSClientConfig::new("https://harnessaas.test.cognitum.one");
    let client = HarnessaaSClient::new(config).unwrap();
    let caps = client.capabilities();
    assert_eq!(caps.features.get("solve"), Some(&true));
    assert_eq!(caps.features.get("lineage"), Some(&true));
    assert_eq!(caps.features.get("solve.vertical.code-repair"), Some(&true));
    assert_eq!(caps.features.get("solve.vertical.security-remediation"), Some(&false));
    assert_eq!(caps.features.get("solve.vertical.dependency-migration"), Some(&false));
    assert_eq!(caps.features.get("solve.vertical.test-generation"), Some(&false));
    assert_eq!(caps.source, CapabilitySource::StaticCompatibilityTable);
}

fn unrecognized_version_snapshot() -> CapabilitySet {
    CapabilitySet {
        product: "harnessaas".to_owned(),
        product_version: "9.9.9-unknown".to_owned(),
        protocol: "cognitum.harnessaas.http".to_owned(),
        protocol_version: "1.0".to_owned(),
        features: std::collections::HashMap::new(),
        limitations: vec!["unrecognized server version — minimum-safe set".to_owned()],
        auth_methods: Vec::new(),
        source: CapabilitySource::StaticCompatibilityTable,
    }
}

#[test]
fn capabilities_snapshot_override_for_unrecognized_version_is_unsupported() {
    let mut config = HarnessaaSClientConfig::new("https://harnessaas.test.cognitum.one");
    config.capabilities_snapshot = Some(unrecognized_version_snapshot());
    let client = HarnessaaSClient::new(config).unwrap();
    assert!(client.capabilities().features.is_empty());
}

// ---------------------------------------------------------------------------
// solve() -- capability fail-closed (ADR-0019 §D6, issue #74)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn solve_fails_closed_for_unsupported_vertical_before_any_http() {
    let server = MockServer::start().await;
    // No mock mounted -- any HTTP request would be unmatched by wiremock.
    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = HarnessaaSClient::new(config).unwrap();

    let mut request = solve_request();
    request.vertical = Some(HarnessaaSVertical::SecurityRemediation);
    let err = client.solve(&request).await.expect_err("must fail closed");
    assert_eq!(err.kind, AgenticErrorKind::UnsupportedCapability);
    assert_eq!(server.received_requests().await.unwrap().len(), 0);
}

#[tokio::test]
async fn solve_fails_closed_for_every_unmodeled_vertical() {
    for vertical in [
        HarnessaaSVertical::SecurityRemediation,
        HarnessaaSVertical::DependencyMigration,
        HarnessaaSVertical::TestGeneration,
    ] {
        let server = MockServer::start().await;
        let mut config = insecure_config(server.uri());
        config.credential_provider = Some(credential_provider(&server.uri()));
        let client = HarnessaaSClient::new(config).unwrap();

        let mut request = solve_request();
        request.vertical = Some(vertical);
        let err = client.solve(&request).await.expect_err("must fail closed");
        assert_eq!(err.kind, AgenticErrorKind::UnsupportedCapability);
        assert_eq!(server.received_requests().await.unwrap().len(), 0);
    }
}

#[tokio::test]
async fn solve_fails_closed_when_snapshot_does_not_mark_solve_supported() {
    let server = MockServer::start().await;
    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    config.capabilities_snapshot = Some(unrecognized_version_snapshot());
    let client = HarnessaaSClient::new(config).unwrap();

    let err = client.solve(&solve_request()).await.expect_err("must fail closed");
    assert_eq!(err.kind, AgenticErrorKind::UnsupportedCapability);
    assert_eq!(server.received_requests().await.unwrap().len(), 0);
}

#[tokio::test]
async fn solve_allows_default_and_explicit_code_repair_vertical() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/solve"))
        .respond_with(ResponseTemplate::new(200).set_body_json(solve_response_body()))
        .expect(2)
        .mount(&server)
        .await;
    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = HarnessaaSClient::new(config).unwrap();

    client.solve(&solve_request()).await.expect("code-repair default should succeed");
    let mut explicit_request = solve_request();
    explicit_request.vertical = Some(HarnessaaSVertical::CodeRepair);
    client.solve(&explicit_request).await.expect("explicit code-repair should succeed");
}

// ---------------------------------------------------------------------------
// health()
// ---------------------------------------------------------------------------

#[tokio::test]
async fn health_calls_health_not_healthz_without_credential() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/health"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "status": "ok",
            "mode": "mock",
            "backend": "mock"
        })))
        .mount(&server)
        .await;

    let config = insecure_config(server.uri());
    let client = HarnessaaSClient::new(config).unwrap();

    let result = client.health().await.unwrap();
    assert_eq!(result.data.status, "ok");
    assert_eq!(result.data.mode.as_deref(), Some("mock"));
    assert_eq!(result.meta.http_status, 200);

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].headers.get("X-API-Key").is_none());
}

#[tokio::test]
async fn health_maps_500_to_non_retryable_protocol_error() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/health"))
        .respond_with(ResponseTemplate::new(500).set_body_json(json!({"error": "internal"})))
        .mount(&server)
        .await;

    let config = insecure_config(server.uri());
    let client = HarnessaaSClient::new(config).unwrap();

    let err = client.health().await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Protocol);
    assert!(!err.retryable);
    assert_eq!(err.status, Some(500));
}

// ---------------------------------------------------------------------------
// solve() -- success
// ---------------------------------------------------------------------------

#[tokio::test]
async fn solve_sends_api_key_and_snake_case_body() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/solve"))
        .and(header("X-API-Key", "cog_test_canary_1234"))
        .respond_with(ResponseTemplate::new(200).set_body_json(solve_response_body()))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = HarnessaaSClient::new(config).unwrap();

    let result = client.solve(&solve_request()).await.unwrap();
    assert_eq!(result.data.request_id, "req_abc123");
    assert!(result.data.resolved);
    assert_eq!(result.data.cost_receipt.model, "deepseek/deepseek-chat");
    assert_eq!(result.data.cost_receipt.tokens_in, 220);
    assert!(!result.data.conformance.used_oracle_during_solve);
    assert_eq!(result.data.lineage_ref, "lineageOf:req_abc123");

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(
        body,
        json!({
            "repo": "https://github.com/acme/widget.git",
            "test_command": "pytest -k test_widget",
            "issue": "Widget renders twice"
        })
    );
}

#[tokio::test]
async fn solve_fails_closed_without_credential_provider() {
    let config = HarnessaaSClientConfig::new("https://harnessaas.test.cognitum.one");
    let client = HarnessaaSClient::new(config).unwrap();

    let err = client.solve(&solve_request()).await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Authentication);
}

// ---------------------------------------------------------------------------
// solve() -- error mapping and retry safety
// ---------------------------------------------------------------------------

#[tokio::test]
async fn solve_401_refreshes_credential_exactly_once_then_retries() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/solve"))
        .and(header("X-API-Key", "cog_v1"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error": "invalid_api_key"})))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/solve"))
        .and(header("X-API-Key", "cog_v2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(solve_response_body()))
        .mount(&server)
        .await;

    let provider = Arc::new(RefreshingCredentialProvider::default());
    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(provider.clone());
    let client = HarnessaaSClient::new(config).unwrap();

    let result = client.solve(&solve_request()).await.unwrap();
    assert_eq!(result.data.request_id, "req_abc123");

    assert_eq!(provider.acquire_calls.load(Ordering::SeqCst), 2);
    assert_eq!(provider.invalidate_calls.load(Ordering::SeqCst), 1);
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 2, "expected exactly one retry after the 401");
}

#[tokio::test]
async fn solve_maps_403_insufficient_scope_to_permission_denied() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/solve"))
        .respond_with(
            ResponseTemplate::new(403)
                .set_body_json(json!({"error": "insufficient scope", "code": "insufficient_scope"})),
        )
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = HarnessaaSClient::new(config).unwrap();

    let err = client.solve(&solve_request()).await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::PermissionDenied);
    assert!(!err.retryable);
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
}

#[tokio::test]
async fn solve_maps_422_to_safety_blocked() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/solve"))
        .respond_with(ResponseTemplate::new(422).set_body_json(json!({
            "error": "request blocked by PII/safety pre-flight",
            "code": "safety_blocked"
        })))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = HarnessaaSClient::new(config).unwrap();

    let err = client.solve(&solve_request()).await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::SafetyBlocked);
    assert!(!err.retryable);
}

#[tokio::test]
async fn solve_does_not_auto_retry_429_single_attempt() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/solve"))
        .respond_with(
            ResponseTemplate::new(429)
                .set_body_json(json!({"error": "rate limited"}))
                .insert_header("retry-after", "2"),
        )
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = HarnessaaSClient::new(config).unwrap();

    let err = client.solve(&solve_request()).await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::RateLimited);
    assert!(err.retryable);
    assert_eq!(err.retry_after_ms, Some(2000));

    // The critical assertion: exactly ONE HTTP attempt, proving solve()
    // never auto-retries even though the error is classified retryable.
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
}

#[tokio::test]
async fn solve_does_not_auto_retry_503_single_attempt() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/solve"))
        .respond_with(ResponseTemplate::new(503).set_body_json(json!({"error": "upstream unavailable"})))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = HarnessaaSClient::new(config).unwrap();

    let err = client.solve(&solve_request()).await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Transport);

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
}

// ---------------------------------------------------------------------------
// lineage()
// ---------------------------------------------------------------------------

#[tokio::test]
async fn lineage_fetches_and_parses_records() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/lineage/req_abc123"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "request_id": "req_abc123",
            "records": [{
                "request_id": "req_abc123",
                "ts": "2026-07-18T00:00:00.000Z",
                "prev_hash": "sha256:prev",
                "hash": "sha256:this",
                "genome": {"base_tier": "cognitum-low"}
            }]
        })))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = HarnessaaSClient::new(config).unwrap();

    let result = client.lineage("req_abc123").await.unwrap();
    assert_eq!(result.data.records.len(), 1);
    assert_eq!(result.data.records[0].hash, "sha256:this");
    assert!(result.data.records[0].raw.contains_key("genome"));
}

#[tokio::test]
async fn lineage_maps_404_to_not_found() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/lineage/req_unknown"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({"error": "request_id not found"})))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = HarnessaaSClient::new(config).unwrap();

    let err = client.lineage("req_unknown").await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::NotFound);
    assert!(!err.retryable);
}

#[tokio::test]
async fn lineage_fails_closed_without_credential_provider() {
    let config = HarnessaaSClientConfig::new("https://harnessaas.test.cognitum.one");
    let client = HarnessaaSClient::new(config).unwrap();

    let err = client.lineage("req_abc123").await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Authentication);
}

// Issue #110: PR #109 added `lineage()`'s defense-in-depth capability
// check (mirroring `solve()`'s `solve_fails_closed_when_snapshot_does_not_
// mark_solve_supported` above), but only ever exercised the pass-through/
// allowed case (`lineage_fetches_and_parses_records`) — the reject path
// itself had no test. Proven the same way `solve()`'s reject tests are:
// a capability snapshot that does not mark `lineage` supported must throw
// `UnsupportedCapabilityError` (surfaced as `AgenticErrorKind::UnsupportedCapability`)
// BEFORE any HTTP call, verified via `server.received_requests()` being
// empty rather than trusting the error alone (a mock server with no route
// mounted would otherwise mask a real request as a different failure).
#[tokio::test]
async fn lineage_fails_closed_when_snapshot_does_not_mark_lineage_supported() {
    let server = MockServer::start().await;
    // No mock mounted -- any HTTP request would be unmatched by wiremock.
    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    config.capabilities_snapshot = Some(unrecognized_version_snapshot());
    let client = HarnessaaSClient::new(config).unwrap();

    let err = client.lineage("req_abc123").await.expect_err("must fail closed");
    assert_eq!(err.kind, AgenticErrorKind::UnsupportedCapability);
    assert_eq!(server.received_requests().await.unwrap().len(), 0);
}

#[tokio::test]
async fn lineage_retries_503_bounded_safe_read() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/lineage/req_abc123"))
        .respond_with(ResponseTemplate::new(503).set_body_json(json!({"error": "unavailable"})))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/lineage/req_abc123"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "request_id": "req_abc123",
            "records": []
        })))
        .mount(&server)
        .await;

    let mut config = insecure_config(server.uri());
    config.credential_provider = Some(credential_provider(&server.uri()));
    let client = HarnessaaSClient::new(config).unwrap();

    let result = client.lineage("req_abc123").await.unwrap();
    assert_eq!(result.data.request_id, "req_abc123");

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 2);
}
