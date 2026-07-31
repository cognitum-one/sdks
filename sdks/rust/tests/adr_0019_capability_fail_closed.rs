#![cfg(all(feature = "meta-proxy", feature = "metaharness", feature = "harnessaas"))]

//! ADR-0019 "Compliance and verification" #6 (issue #74): capability
//! fail-closed tests across five categories.
//!
//! > Capability tests prove unknown product versions fail closed for
//! > mutation, spend, consent, installation, and code execution.
//!
//! ADR-0019 §D6: "A method whose prerequisite capability is false or
//! unknown MUST fail locally with `UnsupportedCapabilityError` before
//! causing spend, mutation, consent, or code execution."
//!
//! Audit (issue #74) performed before writing this file -- see the Node
//! sibling `tests/adr-0019-capability-fail-closed.test.ts` for the full
//! write-up; summary: `tests/metaharness_client.rs` and
//! `tests/meta_proxy_consent.rs`/`tests/meta_proxy_chat_completions_stream.rs`
//! already cover these operations individually, but not framed against
//! these five named categories. Gap CLOSED (this pass):
//! `HarnessaaSClient::solve()` previously had NO capability-version check
//! before its HTTP call, despite being simultaneously a mutation, a spend,
//! and (per HarnessaaS's "untrusted repository and command execution" trust
//! boundary) a code-execution trigger. `solve()` now calls
//! `self.capabilities()` and fails closed with `UnsupportedCapabilityError`
//! BEFORE any HTTP I/O when either the base `solve` feature or the
//! requested vertical's specific feature (`solve.vertical.<vertical>`) is
//! not affirmatively `true` in the resolved capability set -- the real,
//! non-vacuous dimension being that only the `code-repair` vertical is
//! modeled/serialized by this SDK pass (`src/harnessaas/types.rs`'s doc
//! comment: the other three verticals each need a compound request field
//! this client does not build).
//!
//! Category mapping used below. `installation` has no HarnessaaS analog
//! (HarnessaaS installs nothing), so it stays on
//! `MetaHarnessClient::plan_scaffold()`; every other category now exercises
//! real, currently-passing production behavior against
//! `HarnessaaSClient::solve()` directly:
//!
//!   mutation        -> HarnessaaSClient::solve() (unsupported vertical, mutating remote solve)
//!   spend           -> HarnessaaSClient::solve() (unsupported vertical, billable model spend)
//!   consent         -> MetaProxyClient::chat_completions() (cognitum_cloud, no grant)
//!   installation    -> MetaHarnessClient::plan_scaffold() (blocked in part on
//!                       package/template version disagreement, ADR-0026a §D7 #3)
//!   code execution  -> HarnessaaSClient::solve() (unsupported vertical, untrusted sandbox execution)

use std::sync::Arc;

use cognitum_one::agentic::static_api_key_provider::{
    StaticApiKeyCredentialProvider, StaticApiKeyCredentialProviderOptions,
};
use cognitum_one::agentic::AgenticErrorKind;
use cognitum_one::harnessaas::{HarnessaaSClient, HarnessaaSClientConfig, HarnessaaSSolveRequest, HarnessaaSVertical};
use cognitum_one::meta_llm::types::openai::{
    ChatCompletionRequest, ChatMessage, ChatMessageContent, ChatRole,
};
use cognitum_one::meta_proxy::{
    LocalBearerTokenCredentialProvider, LocalBearerTokenCredentialProviderOptions,
    MetaProxyChatCallOptions, MetaProxyClient, MetaProxyClientConfig, RoutingIntent, RoutingPlane,
    WorkloadPolicy,
};
use cognitum_one::metaharness::{MetaHarnessClient, MetaHarnessConfig, ScaffoldRequestV1};
use wiremock::MockServer;

/// A `HarnessaaSClient` actually wired to the given wiremock server origin
/// (with no mock mounted), so "zero HTTP calls" below proves the capability
/// gate fired before any I/O reached this client's own configured
/// transport -- not merely that some unrelated origin was never dialed.
fn harnessaas_client(origin: &str) -> HarnessaaSClient {
    let mut config = HarnessaaSClientConfig::new(origin);
    config.allow_insecure_http = true;
    config.credential_provider = Some(Arc::new(
        StaticApiKeyCredentialProvider::new(
            "harnessaas",
            origin,
            origin,
            StaticApiKeyCredentialProviderOptions {
                api_key: Some("cog_compliance_canary".to_owned()),
                ..Default::default()
            },
        )
        .unwrap(),
    ));
    HarnessaaSClient::new(config).unwrap()
}

fn unsupported_vertical_solve_request(vertical: HarnessaaSVertical) -> HarnessaaSSolveRequest {
    let mut request = HarnessaaSSolveRequest::new(
        "https://github.com/acme/widget.git",
        "pytest -k test_widget",
        "Widget renders twice",
    );
    request.vertical = Some(vertical);
    request
}

fn refusing_proxy_client(origin: &str) -> MetaProxyClient {
    let mut config = MetaProxyClientConfig::with_origin(origin.to_owned());
    config.local_credential_provider = Some(Arc::new(
        LocalBearerTokenCredentialProvider::new(
            origin,
            origin,
            LocalBearerTokenCredentialProviderOptions {
                token: Some("mh1.canary-local-token".to_owned()),
                ..Default::default()
            },
        )
        .unwrap(),
    ));
    MetaProxyClient::new(config).unwrap()
}

fn chat_request() -> ChatCompletionRequest {
    ChatCompletionRequest {
        model: "gpt-proxy".to_owned(),
        messages: vec![ChatMessage {
            role: ChatRole::User,
            content: Some(ChatMessageContent::Text("hello".to_owned())),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }],
        max_tokens: None,
        temperature: None,
        top_p: None,
        n: None,
        stream: None,
        stop: None,
        presence_penalty: None,
        frequency_penalty: None,
        logit_bias: None,
        user: None,
        tools: None,
        tool_choice: None,
        response_format: None,
        seed: None,
        routing_controls: None,
    }
}

/// `HarnessaaSClient::solve()` with a vertical this SDK pass does not model
/// (`security-remediation` needs a `finding`/`scanner_command` compound
/// field this client does not serialize -- see `src/harnessaas/types.rs`).
/// One real call embodies all three of ADR-0019's `mutation`, `spend`, and
/// `code execution` categories simultaneously (HarnessaaS's own "untrusted
/// repository and command execution" trust boundary), so the tests below
/// each assert the same fail-closed outcome against the category they
/// specifically care about.
#[tokio::test]
async fn mutation_harnessaas_solve_fails_closed() {
    let server = MockServer::start().await;
    // No mock mounted -- any HTTP request would be unmatched by wiremock.
    let client = harnessaas_client(&server.uri());
    let request = unsupported_vertical_solve_request(HarnessaaSVertical::SecurityRemediation);
    let err = client.solve(&request).await.expect_err("must fail closed");
    assert_eq!(err.kind, AgenticErrorKind::UnsupportedCapability);
    assert_eq!(server.received_requests().await.unwrap().len(), 0);
}

#[tokio::test]
async fn installation_plan_scaffold_fails_closed() {
    let client = MetaHarnessClient::new(MetaHarnessConfig::new()).unwrap();
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
    let err = client.plan_scaffold(&request).await.expect_err("must fail closed");
    assert_eq!(err.kind, AgenticErrorKind::UnsupportedCapability);
}

#[tokio::test]
async fn code_execution_harnessaas_solve_fails_closed() {
    let server = MockServer::start().await;
    let client = harnessaas_client(&server.uri());
    let request = unsupported_vertical_solve_request(HarnessaaSVertical::DependencyMigration);
    let err = client.solve(&request).await.expect_err("must fail closed");
    assert_eq!(err.kind, AgenticErrorKind::UnsupportedCapability);
    assert_eq!(server.received_requests().await.unwrap().len(), 0);
}

#[tokio::test]
async fn spend_harnessaas_solve_fails_closed_before_billable_http() {
    let server = MockServer::start().await;
    let client = harnessaas_client(&server.uri());
    let request = unsupported_vertical_solve_request(HarnessaaSVertical::TestGeneration);
    let err = client.solve(&request).await.expect_err("must fail closed");
    assert_eq!(err.kind, AgenticErrorKind::UnsupportedCapability);
    assert_eq!(server.received_requests().await.unwrap().len(), 0);
}

#[tokio::test]
async fn consent_chat_completions_fails_closed_before_http() {
    let server = MockServer::start().await;
    // No mock mounted, and no consent_grants configured.
    let client = refusing_proxy_client(&server.uri());
    let options = MetaProxyChatCallOptions {
        routing_intent: Some(RoutingIntent {
            required_plane: Some(RoutingPlane::CognitumCloud),
            workload_policy: WorkloadPolicy::Standard,
            ..RoutingIntent::default()
        }),
        ..Default::default()
    };
    let err = client
        .chat_completions(&chat_request(), Some(options))
        .await
        .expect_err("must fail closed");
    assert_eq!(err.kind, AgenticErrorKind::ConsentRequired);
    assert_eq!(server.received_requests().await.unwrap().len(), 0);
}
