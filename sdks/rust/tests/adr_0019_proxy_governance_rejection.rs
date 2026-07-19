#![cfg(feature = "meta-proxy")]

//! ADR-0019 "Compliance and verification" #7 (issue #74): proxy governance
//! rejection test.
//!
//! > A proxy test proves an unsupported Meta LLM governance call is
//! > rejected locally and never reaches `/v1/*` on the proxy fixture.
//!
//! ADR-0019 §D7: "Meta LLM governance methods are never sent to Meta
//! Proxy." Unlike Node/Python, Rust's static dispatch means there is no
//! runtime "call a method that doesn't exist" escape hatch at all -- a
//! caller cannot even write `client.models()` against `MetaProxyClient`
//! because no such method is defined; it is a `E0599` compile error. That
//! is a STRONGER guarantee than a runtime rejection, so this test proves
//! it two ways:
//!
//!  1. Statically: `src/meta_proxy/client.rs`'s public method names are
//!     source-scanned and asserted to exclude every Meta LLM governance
//!     method name (`models`, `whoami`, `usage`, `ready`, plus `batches`/
//!     `pods`, which do not exist as callable methods on `MetaLlmClient`
//!     either yet).
//!  2. Behaviorally (control): a real, supported call (`status()`) is
//!     proven to reach the fixture at `/status`, and NEVER at any `/v1/*`
//!     path -- ruling out a false-negative in the fixture-spy technique
//!     the sibling capability-fail-closed and acceptance tests rely on.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use cognitum_one::meta_proxy::{
    LocalBearerTokenCredentialProvider, LocalBearerTokenCredentialProviderOptions,
    MetaProxyClient, MetaProxyClientConfig,
};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const META_LLM_GOVERNANCE_METHODS: [&str; 6] =
    ["models", "whoami", "usage", "ready", "batches", "pods"];

#[test]
fn meta_proxy_client_source_declares_no_governance_method() {
    let client_rs = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/meta_proxy/client.rs");
    let source = fs::read_to_string(&client_rs).expect("readable src/meta_proxy/client.rs");

    for method_name in META_LLM_GOVERNANCE_METHODS {
        let signature_fragment = format!("fn {method_name}(");
        assert!(
            !source.contains(&signature_fragment),
            "MetaProxyClient must not declare a `{method_name}` method (ADR-0019 §D7) -- \
             found `{signature_fragment}` in src/meta_proxy/client.rs"
        );
    }
}

#[tokio::test]
async fn control_a_real_supported_call_reaches_the_fixture_and_only_that_path() {
    let server = MockServer::start().await;
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
        .mount(&server)
        .await;

    let mut config = MetaProxyClientConfig::with_origin(server.uri());
    config.local_credential_provider = Some(Arc::new(
        LocalBearerTokenCredentialProvider::new(
            server.uri(),
            server.uri(),
            LocalBearerTokenCredentialProviderOptions {
                token: Some("mh1.canary-local-token".to_owned()),
                ..Default::default()
            },
        )
        .unwrap(),
    ));
    let client = MetaProxyClient::new(config).unwrap();

    client.status().await.expect("status should succeed");

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].url.path(), "/status");
    assert!(!requests[0].url.path().starts_with("/v1/"));
}
