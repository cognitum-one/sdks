//! ADR-0019 "Compliance and verification" #1 (issue #74): import smoke tests.
//!
//! > Import smoke tests prove each product namespace loads without
//! > constructing or probing any other product.
//!
//! Rust has no dynamic/side-effecting module load -- `use` merely brings a
//! path into scope, it never executes code -- so "importing X constructs Y"
//! is not a runtime concern the way it is in Node/Python. The equivalent,
//! and in fact STRONGER, guarantee here is enforced by the compiler itself:
//! each product module below is exercised in its own `mod` block that
//! `use`s ONLY that product's own crate path (plus the shared `agentic`
//! contracts every product depends on per ADR-0019 §D4's dependency
//! diagram) -- if any product's code secretly needed another product's
//! types, this file simply would not compile.
//!
//! This is deliberately layered on top of, not a replacement for:
//!  - `adr_0019_deny_list.rs` (#5), which proves the SOURCE never
//!    references another product's module path (except §D7's documented
//!    wire-type carve-out);
//!  - the `rust-feature-matrix` CI job (`.github/workflows/ci.yml`), which
//!    already builds the crate with each of `meta-llm`/`meta-proxy`/
//!    `metaharness`/`harnessaas` enabled ALONE, one job per feature, plus
//!    the `rust` job's `cargo build`/`test`/`clippy` in all-features mode
//!    -- i.e. ADR-0019 §Compliance #3 ("Rust builds every product feature
//!    alone and in all-features mode") is already CI-enforced today and is
//!    deliberately NOT duplicated as a source-level test here.
//!
//! Each `mod` block below also asserts construction performs no I/O and
//! that the client is immediately usable (a real, mocked round trip for
//! the HTTP-backed products; a fail-closed call for MetaHarness) without
//! ever needing a `use` of a sibling product path.

#![cfg(any(
    feature = "meta-llm",
    feature = "meta-proxy",
    feature = "metaharness",
    feature = "harnessaas"
))]

#[cfg(feature = "meta-llm")]
mod meta_llm_only {
    use cognitum_one::agentic::static_api_key_provider::{
        StaticApiKeyCredentialProvider, StaticApiKeyCredentialProviderOptions,
    };
    use cognitum_one::meta_llm::{MetaLlmClient, MetaLlmClientConfig};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn meta_llm_alone_constructs_and_operates() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/health"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "status": "ok"
            })))
            .mount(&server)
            .await;

        let mut config = MetaLlmClientConfig::new(server.uri());
        config.allow_insecure_http = true;
        config.credential_provider = Some(std::sync::Arc::new(
            StaticApiKeyCredentialProvider::new(
                "meta-llm",
                server.uri(),
                server.uri(),
                StaticApiKeyCredentialProviderOptions {
                    api_key: Some("sk-import-smoke".to_owned()),
                    ..Default::default()
                },
            )
            .unwrap(),
        ));
        let client = MetaLlmClient::new(config).expect("zero-I/O construction");
        let result = client.health().await.expect("mocked health call");
        assert_eq!(result.data.status, "ok");
    }
}

#[cfg(feature = "meta-proxy")]
mod meta_proxy_only {
    use cognitum_one::meta_proxy::{
        LocalBearerTokenCredentialProvider, LocalBearerTokenCredentialProviderOptions,
        MetaProxyClient, MetaProxyClientConfig,
    };
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn meta_proxy_alone_constructs_and_operates() {
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
        config.local_credential_provider = Some(std::sync::Arc::new(
            LocalBearerTokenCredentialProvider::new(
                server.uri(),
                server.uri(),
                LocalBearerTokenCredentialProviderOptions {
                    token: Some("mh1.import-smoke".to_owned()),
                    ..Default::default()
                },
            )
            .unwrap(),
        ));
        let client = MetaProxyClient::new(config).expect("zero-I/O construction");
        let result = client.status().await.expect("mocked status call");
        assert_eq!(result.data.process_state, "running");
    }
}

#[cfg(feature = "metaharness")]
mod metaharness_only {
    use cognitum_one::agentic::AgenticErrorKind;
    use cognitum_one::metaharness::{MetaHarnessClient, MetaHarnessConfig};

    #[tokio::test]
    async fn metaharness_alone_constructs_and_fails_closed() {
        let client = MetaHarnessClient::new(MetaHarnessConfig::new()).expect("zero-I/O construction");
        let err = client.capabilities().await.expect_err("no bridge protocol exists yet");
        assert_eq!(err.kind, AgenticErrorKind::UnsupportedCapability);
    }
}

#[cfg(feature = "harnessaas")]
mod harnessaas_only {
    use cognitum_one::agentic::static_api_key_provider::{
        StaticApiKeyCredentialProvider, StaticApiKeyCredentialProviderOptions,
    };
    use cognitum_one::harnessaas::{HarnessaaSClient, HarnessaaSClientConfig};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn harnessaas_alone_constructs_and_operates() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/health"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "status": "ok"
            })))
            .mount(&server)
            .await;

        let mut config = HarnessaaSClientConfig::new(server.uri());
        config.allow_insecure_http = true;
        config.credential_provider = Some(std::sync::Arc::new(
            StaticApiKeyCredentialProvider::new(
                "harnessaas",
                server.uri(),
                server.uri(),
                StaticApiKeyCredentialProviderOptions {
                    api_key: Some("cog_import_smoke".to_owned()),
                    ..Default::default()
                },
            )
            .unwrap(),
        ));
        let client = HarnessaaSClient::new(config).expect("zero-I/O construction");
        let result = client.health().await.expect("mocked health call");
        assert_eq!(result.data.status, "ok");
    }
}
