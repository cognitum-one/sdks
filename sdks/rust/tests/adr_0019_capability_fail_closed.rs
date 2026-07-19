#![cfg(all(feature = "meta-proxy", feature = "metaharness"))]

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
//! these five named categories. Genuine gap found: `HarnessaaSClient::solve()`
//! has NO capability-version check before its HTTP call, despite being
//! simultaneously a mutation, a spend, and (per HarnessaaS's "untrusted
//! repository and command execution" trust boundary) a code-execution
//! trigger -- flagged as a follow-up rather than asserted here as passing
//! behavior that does not exist.
//!
//! Category mapping used below (all backed by real, currently-passing
//! production behavior):
//!
//!   mutation        -> MetaHarnessClient::scaffold()   (applies a plan)
//!   spend           -> MetaProxyClient::sponsored_chat_completions()
//!   consent         -> MetaProxyClient::chat_completions() (cognitum_cloud, no grant)
//!   installation    -> MetaHarnessClient::plan_scaffold() (blocked in part on
//!                       package/template version disagreement, ADR-0026a §D7 #3)
//!   code execution  -> MetaHarnessClient::analyze_repository()

use std::sync::Arc;

use cognitum_one::agentic::AgenticErrorKind;
use cognitum_one::meta_llm::types::openai::{
    ChatCompletionRequest, ChatMessage, ChatMessageContent, ChatRole,
};
use cognitum_one::meta_proxy::{
    LocalBearerTokenCredentialProvider, LocalBearerTokenCredentialProviderOptions,
    MetaProxyChatCallOptions, MetaProxyClient, MetaProxyClientConfig, RoutingIntent, RoutingPlane,
    WorkloadPolicy,
};
use cognitum_one::metaharness::{
    ApplyApproval, GeneratorIdentity, LocalRepository, MetaHarnessClient, MetaHarnessConfig,
    RepositorySource, ScaffoldPlan, ScaffoldRequestV1, TemplateIdentity,
};
use wiremock::MockServer;

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

fn local_repo(path: &str) -> RepositorySource {
    RepositorySource::Local(LocalRepository {
        canonical_path: path.to_owned(),
        expected_tree_digest: None,
    })
}

#[tokio::test]
async fn mutation_scaffold_fails_closed() {
    let client = MetaHarnessClient::new(MetaHarnessConfig::new()).unwrap();
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
    let err = client.scaffold(&plan, &approval).await.expect_err("must fail closed");
    assert_eq!(err.kind, AgenticErrorKind::UnsupportedCapability);
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
async fn code_execution_analyze_repository_fails_closed() {
    let client = MetaHarnessClient::new(MetaHarnessConfig::new()).unwrap();
    let source = local_repo("/tmp/repo");
    let err = client.analyze_repository(&source).await.expect_err("must fail closed");
    assert_eq!(err.kind, AgenticErrorKind::UnsupportedCapability);
}

#[tokio::test]
async fn spend_sponsored_chat_completions_fails_closed_before_http() {
    let server = MockServer::start().await;
    // No mock mounted -- any HTTP request would be unmatched.
    let client = refusing_proxy_client(&server.uri());
    let err = client
        .sponsored_chat_completions(&chat_request())
        .await
        .expect_err("must fail closed");
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
