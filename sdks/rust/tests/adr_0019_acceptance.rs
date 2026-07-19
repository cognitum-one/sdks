#![cfg(all(
    feature = "meta-llm",
    feature = "meta-proxy",
    feature = "metaharness",
    feature = "harnessaas"
))]

//! ADR-0019 "Acceptance test" (issue #74), the ADR's own closing paragraph:
//!
//! > For each of Node, Python, and Rust, instantiate all four clients with
//! > fake local transports and distinct sentinel credentials. Assert zero
//! > I/O during construction, assert each client sends only its own
//! > credential to its own fixture, assert an unknown capability blocks a
//! > billable mutation before I/O, and assert importing one namespace does
//! > not load another product implementation.
//!
//! Written as one integration-style test exercising all four clients
//! together, mirroring the Node/Python siblings
//! (`tests/adr-0019-acceptance.test.ts`, `tests/test_adr0019_acceptance.py`).
//! "Fake local transport" here means a real `wiremock::MockServer` bound to
//! loopback -- Rust's `reqwest::Client` has no injectable mock-function
//! transport, so a controlled local HTTP server is the idiomatic
//! equivalent (matching every other Rust test file in this suite).
//! "(d) importing one namespace does not load another" is a compile-time
//! guarantee here (see `adr_0019_import_smoke.rs`'s doc comment) -- this
//! file's imports are exactly the four product paths plus the shared
//! `agentic` contracts, nothing cross-product, which is itself the proof.

use std::sync::Arc;

use cognitum_one::agentic::static_api_key_provider::{
    StaticApiKeyCredentialProvider, StaticApiKeyCredentialProviderOptions,
};
use cognitum_one::agentic::AgenticErrorKind;
use cognitum_one::harnessaas::{HarnessaaSClient, HarnessaaSClientConfig};
use cognitum_one::meta_llm::{MetaLlmClient, MetaLlmClientConfig};
use cognitum_one::meta_proxy::{
    LocalBearerTokenCredentialProvider, LocalBearerTokenCredentialProviderOptions,
    MetaProxyClient, MetaProxyClientConfig,
};
use cognitum_one::metaharness::{
    ApplyApproval, GeneratorIdentity, MetaHarnessClient, MetaHarnessConfig, ScaffoldPlan,
    TemplateIdentity,
};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const SENTINEL_META_LLM: &str = "sk-sentinel-meta-llm-AAA111";
const SENTINEL_META_PROXY: &str = "mh1.sentinel-meta-proxy-BBB222";
const SENTINEL_HARNESSAAS: &str = "cog_sentinel_harnessaas_CCC333";

#[tokio::test]
async fn four_clients_zero_io_no_credential_bleed_capability_fails_closed() {
    // -------------------------------------------------------------
    // (a) zero I/O during construction, for all four clients. Each
    // MockServer below starts listening but has NO mock mounted yet, so
    // any request that reached it before we explicitly mount one would
    // surface as an unmatched-request panic on drop / a non-200 response.
    // -------------------------------------------------------------
    let meta_llm_server = MockServer::start().await;
    let meta_proxy_server = MockServer::start().await;
    let harnessaas_server = MockServer::start().await;

    let meta_llm_client = MetaLlmClient::new({
        let mut config = MetaLlmClientConfig::new(meta_llm_server.uri());
        config.allow_insecure_http = true;
        config.credential_provider = Some(Arc::new(
            StaticApiKeyCredentialProvider::new(
                "meta-llm",
                meta_llm_server.uri(),
                meta_llm_server.uri(),
                StaticApiKeyCredentialProviderOptions {
                    api_key: Some(SENTINEL_META_LLM.to_owned()),
                    ..Default::default()
                },
            )
            .unwrap(),
        ));
        config
    })
    .expect("zero-I/O construction");

    let meta_proxy_client = MetaProxyClient::new({
        let mut config = MetaProxyClientConfig::with_origin(meta_proxy_server.uri());
        config.local_credential_provider = Some(Arc::new(
            LocalBearerTokenCredentialProvider::new(
                meta_proxy_server.uri(),
                meta_proxy_server.uri(),
                LocalBearerTokenCredentialProviderOptions {
                    token: Some(SENTINEL_META_PROXY.to_owned()),
                    ..Default::default()
                },
            )
            .unwrap(),
        ));
        config
    })
    .expect("zero-I/O construction");

    let metaharness_client =
        MetaHarnessClient::new(MetaHarnessConfig::new()).expect("zero-I/O construction");

    let harnessaas_client = HarnessaaSClient::new({
        let mut config = HarnessaaSClientConfig::new(harnessaas_server.uri());
        config.allow_insecure_http = true;
        config.credential_provider = Some(Arc::new(
            StaticApiKeyCredentialProvider::new(
                "harnessaas",
                harnessaas_server.uri(),
                harnessaas_server.uri(),
                StaticApiKeyCredentialProviderOptions {
                    api_key: Some(SENTINEL_HARNESSAAS.to_owned()),
                    ..Default::default()
                },
            )
            .unwrap(),
        ));
        config
    })
    .expect("zero-I/O construction");

    assert_eq!(meta_llm_server.received_requests().await.unwrap().len(), 0);
    assert_eq!(meta_proxy_server.received_requests().await.unwrap().len(), 0);
    assert_eq!(harnessaas_server.received_requests().await.unwrap().len(), 0);

    // -------------------------------------------------------------
    // (b) each client sends only its own credential to its own fixture
    // -- never another client's sentinel.
    // -------------------------------------------------------------
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "object": "list", "models": []
        })))
        .mount(&meta_llm_server)
        .await;
    Mock::given(method("GET"))
        .and(path("/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "product_version": "0.1.0",
            "protocol_version": "1.0",
            "process_state": "running",
            "configured_plane": "local",
            "selected_plane": "local",
            "limitations": []
        })))
        .mount(&meta_proxy_server)
        .await;
    Mock::given(method("GET"))
        .and(path("/lineage/req-sentinel-check"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "request_id": "req-sentinel-check", "records": []
        })))
        .mount(&harnessaas_server)
        .await;

    meta_llm_client.models().await.expect("mocked models call");
    meta_proxy_client.status().await.expect("mocked status call");
    harnessaas_client
        .lineage("req-sentinel-check")
        .await
        .expect("mocked lineage call");

    let meta_llm_requests = meta_llm_server.received_requests().await.unwrap();
    let meta_proxy_requests = meta_proxy_server.received_requests().await.unwrap();
    let harnessaas_requests = harnessaas_server.received_requests().await.unwrap();
    assert_eq!(meta_llm_requests.len(), 1);
    assert_eq!(meta_proxy_requests.len(), 1);
    assert_eq!(harnessaas_requests.len(), 1);

    let meta_llm_headers = format!("{:?}", meta_llm_requests[0].headers);
    let meta_proxy_headers = format!("{:?}", meta_proxy_requests[0].headers);
    let harnessaas_headers = format!("{:?}", harnessaas_requests[0].headers);

    // Each fixture saw its own sentinel...
    assert!(meta_llm_headers.contains(SENTINEL_META_LLM));
    assert!(meta_proxy_headers.contains(SENTINEL_META_PROXY));
    assert!(harnessaas_headers.contains(SENTINEL_HARNESSAAS));

    // ...and NEVER another client's sentinel (no credential bleed).
    assert!(!meta_llm_headers.contains(SENTINEL_META_PROXY));
    assert!(!meta_llm_headers.contains(SENTINEL_HARNESSAAS));
    assert!(!meta_proxy_headers.contains(SENTINEL_META_LLM));
    assert!(!meta_proxy_headers.contains(SENTINEL_HARNESSAAS));
    assert!(!harnessaas_headers.contains(SENTINEL_META_LLM));
    assert!(!harnessaas_headers.contains(SENTINEL_META_PROXY));

    // -------------------------------------------------------------
    // (c) an unknown capability blocks a billable mutation before I/O.
    // MetaHarnessClient::scaffold() has no published bridge capability
    // yet (ADR-0026a §D7), so it fails closed, and none of the three
    // HTTP fixtures above see any additional request as a result.
    // -------------------------------------------------------------
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

    let err = metaharness_client
        .scaffold(&plan, &approval)
        .await
        .expect_err("unknown capability must fail closed");
    assert_eq!(err.kind, AgenticErrorKind::UnsupportedCapability);

    assert_eq!(meta_llm_server.received_requests().await.unwrap().len(), 1);
    assert_eq!(meta_proxy_server.received_requests().await.unwrap().len(), 1);
    assert_eq!(harnessaas_server.received_requests().await.unwrap().len(), 1);
}
