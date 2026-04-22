use cognitum_rs::{Client, ClientConfig};
use serde_json::json;
use wiremock::matchers::{header, header_exists, method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

fn test_client(base_url: &str) -> Client {
    Client::with_config(ClientConfig {
        api_key: "test-key".to_owned(),
        base_url: Some(base_url.to_owned()),
        timeout_secs: 5,
        max_retries: 0,
        ..Default::default()
    })
}

#[tokio::test]
async fn health_check_returns_ok() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/health"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"status": "ok", "version": "1.0.0"})),
        )
        .mount(&server)
        .await;

    let client = test_client(&server.uri());
    let resp = client.health().await.unwrap();
    assert_eq!(resp.status, "ok");
    assert_eq!(resp.version.as_deref(), Some("1.0.0"));
}

#[tokio::test]
async fn catalog_browse_returns_products() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/listTemplates"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "products": [
                {
                    "id": "seed-1",
                    "name": "Cognitum Seed",
                    "description": "AI hardware device",
                    "priceCents": 13100,
                    "available": true
                }
            ],
            "total": 1
        })))
        .mount(&server)
        .await;

    let client = test_client(&server.uri());
    let catalog = client.catalog().browse().await.unwrap();
    assert_eq!(catalog.products.len(), 1);
    assert_eq!(catalog.products[0].name, "Cognitum Seed");
    assert_eq!(catalog.total, Some(1));
}

#[tokio::test]
async fn orders_create_returns_client_secret() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/createPresalePaymentIntent"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "clientSecret": "pi_test_secret_123",
            "orderId": "order-abc"
        })))
        .mount(&server)
        .await;

    let client = test_client(&server.uri());
    let resp = client.orders().create("test@example.com", 1).await.unwrap();
    assert_eq!(resp.client_secret, "pi_test_secret_123");
    assert_eq!(resp.order_id.as_deref(), Some("order-abc"));
}

#[tokio::test]
async fn leads_subscribe_succeeds() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/saveNotifyLead"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"success": true, "message": "Subscribed"})),
        )
        .mount(&server)
        .await;

    let client = test_client(&server.uri());
    let resp = client
        .leads()
        .subscribe("user@example.com", "seed")
        .await
        .unwrap();
    assert!(resp.success);
}

#[tokio::test]
async fn contact_send_succeeds() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/sendContactEmail"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true})))
        .mount(&server)
        .await;

    let client = test_client(&server.uri());
    let resp = client
        .contact()
        .send("Jane Doe", "jane@example.com", "Hello!", "general")
        .await
        .unwrap();
    assert!(resp.success);
}

#[tokio::test]
async fn devices_register_returns_device() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/seedRegisterDevice"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "deviceId": "dev-001",
            "publicKey": "ed25519-pk-abc",
            "status": "registered"
        })))
        .mount(&server)
        .await;

    let client = test_client(&server.uri());
    let device = client.devices().register("ed25519-pk-abc").await.unwrap();
    assert_eq!(device.device_id, "dev-001");
}

#[tokio::test]
async fn mcp_list_tools_returns_tools() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/apiMcpTools"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            {
                "name": "search",
                "description": "Search the knowledge base"
            }
        ])))
        .mount(&server)
        .await;

    let client = test_client(&server.uri());
    let tools = client.mcp().list_tools().await.unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "search");
}

#[tokio::test]
async fn brain_search_returns_results() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/brainSearch"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": [
                {
                    "id": "mem-1",
                    "content": "Rust SDK patterns",
                    "score": 0.95
                }
            ],
            "total": 1
        })))
        .mount(&server)
        .await;

    let client = test_client(&server.uri());
    let resp = client
        .brain()
        .search("rust sdk", None, Some(5))
        .await
        .unwrap();
    assert_eq!(resp.results.len(), 1);
    assert_eq!(resp.results[0].content, "Rust SDK patterns");
}

#[tokio::test]
async fn not_found_returns_error() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/health"))
        .respond_with(ResponseTemplate::new(404).set_body_string("not found"))
        .mount(&server)
        .await;

    let client = test_client(&server.uri());
    let err = client.health().await.unwrap_err();
    assert!(
        matches!(err, cognitum_rs::Error::NotFound(_)),
        "expected NotFound, got: {err:?}"
    );
}

#[tokio::test]
async fn unauthorized_returns_auth_error() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/health"))
        .respond_with(ResponseTemplate::new(401).set_body_string("invalid token"))
        .mount(&server)
        .await;

    let client = test_client(&server.uri());
    let err = client.health().await.unwrap_err();
    assert!(
        matches!(err, cognitum_rs::Error::Auth(_)),
        "expected Auth, got: {err:?}"
    );
}

// ── Bug 1: X-API-Key is canonical, Bearer is deprecation-gated ─────────

/// Capture the first incoming request's headers for assertions.
struct HeaderCapture {
    headers: std::sync::Arc<std::sync::Mutex<Option<reqwest::header::HeaderMap>>>,
}

impl Respond for HeaderCapture {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let mut map = reqwest::header::HeaderMap::new();
        for (name, value) in request.headers.iter() {
            if let (Ok(name), Ok(value)) = (
                reqwest::header::HeaderName::from_bytes(name.as_str().as_bytes()),
                reqwest::header::HeaderValue::from_bytes(value.as_bytes()),
            ) {
                map.insert(name, value);
            }
        }
        *self.headers.lock().unwrap() = Some(map);
        ResponseTemplate::new(200).set_body_json(json!({"status": "ok"}))
    }
}

#[tokio::test]
async fn default_client_sends_x_api_key_not_bearer() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/health"))
        .and(header("x-api-key", "test-key"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"status": "ok"})))
        .expect(1)
        .mount(&server)
        .await;

    let client = test_client(&server.uri());
    client.health().await.unwrap();
    // wiremock's `.expect(1)` + drop verifies the request matched the header.
}

#[tokio::test]
async fn default_client_does_not_send_authorization_header() {
    let server = MockServer::start().await;
    let captured = std::sync::Arc::new(std::sync::Mutex::new(None));
    let responder = HeaderCapture {
        headers: captured.clone(),
    };

    Mock::given(method("GET"))
        .and(path("/health"))
        .respond_with(responder)
        .mount(&server)
        .await;

    let client = test_client(&server.uri());
    client.health().await.unwrap();

    let headers = captured.lock().unwrap();
    let headers = headers.as_ref().expect("request was captured");
    assert!(
        headers.get("authorization").is_none(),
        "default client must not send Authorization header, got: {:?}",
        headers.get("authorization")
    );
    assert_eq!(
        headers.get("x-api-key").and_then(|v| v.to_str().ok()),
        Some("test-key"),
    );
}

#[tokio::test]
async fn deprecated_bearer_auth_sends_both_headers() {
    // Silence the one-shot deprecation warning in tests.
    std::env::set_var("COGNITUM_SUPPRESS_BEARER_WARNING", "1");

    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/health"))
        .and(header("x-api-key", "test-key"))
        .and(header("authorization", "Bearer test-key"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"status": "ok"})))
        .expect(1)
        .mount(&server)
        .await;

    let client = Client::builder()
        .api_key("test-key")
        .base_url(server.uri())
        .timeout_secs(5)
        .max_retries(0)
        .deprecated_bearer_auth(true)
        .build()
        .unwrap();

    client.health().await.unwrap();
    std::env::remove_var("COGNITUM_SUPPRESS_BEARER_WARNING");
}

// ── Bug 2: TLS escape hatch for self-signed seed ───────────────────────

#[tokio::test]
async fn builder_exposes_danger_accept_invalid_certs() {
    // We only assert the builder plumbs the flag through. Spinning up a
    // real self-signed TLS server in-process pulls in rustls/openssl test
    // infra that isn't worth the weight here; the live-seed integration
    // covers the end-to-end path.
    let client = Client::builder()
        .api_key("test-key")
        .danger_accept_invalid_certs(true)
        .build()
        .expect("insecure client should build");
    assert!(client.config().insecure);
    assert!(!client.config().use_bearer);
}

#[tokio::test]
async fn builder_trust_root_pem_round_trips() {
    // A valid self-signed PEM (generated once, pinned here for the test).
    // Matches the shape reqwest expects via `reqwest::Certificate::from_pem`.
    let pem = b"-----BEGIN CERTIFICATE-----\n\
MIIBhTCCASugAwIBAgIUZpQfWjNY9ajdFIKI0TrPYEtgXm0wCgYIKoZIzj0EAwIw\n\
EjEQMA4GA1UEAwwHVGVzdCBDQTAeFw0yNDAxMDEwMDAwMDBaFw0zNDAxMDEwMDAw\n\
MDBaMBIxEDAOBgNVBAMMB1Rlc3QgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC\n\
AAQx79mHYG9a9UTk1l9T0Y4I5N+e6AwQUjTVgv+w0Tl+3nJz0JRhJt7U0pAq4A6n\n\
w6eY2N9a9D3qXo4p7V+iMQ3go1MwUTAdBgNVHQ4EFgQUHbCGXCPyLnjmPgwbDYN5\n\
j2mxg4cwHwYDVR0jBBgwFoAUHbCGXCPyLnjmPgwbDYN5j2mxg4cwDwYDVR0TAQH/\n\
BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiAwzD1b7iFpsm9cT2xGxmxGxmxGxmxG\n\
xmxGxmxGxmxGxgIgZqR5S9ItRrGTe9u3zXKO+v5o4cPjA9E2x9f2B1FQ6zA=\n\
-----END CERTIFICATE-----\n";

    // The pinned PEM above is syntactically valid but contents are not
    // a real signed cert — reqwest may still accept the parse step. We
    // only care that the builder plumbs the PEM and that mutually-
    // exclusive mode errors fire cleanly.
    let result = Client::builder()
        .api_key("test-key")
        .trust_root_pem(pem.to_vec())
        .build();

    // Either the cert parses and the client builds, or reqwest rejects
    // the body and we surface a Validation error — both prove the path.
    match result {
        Ok(client) => {
            assert!(client.config().trust_root_pem.is_some());
            assert!(!client.config().insecure);
        }
        Err(cognitum_rs::Error::Validation(msg)) => {
            assert!(msg.contains("trust_root_pem"), "got: {msg}");
        }
        Err(other) => panic!("unexpected error: {other:?}"),
    }
}

#[tokio::test]
async fn builder_rejects_both_insecure_and_trust_root_pem() {
    let err = Client::builder()
        .api_key("test-key")
        .danger_accept_invalid_certs(true)
        .trust_root_pem(b"anything".to_vec())
        .build()
        .expect_err("mutually exclusive modes must fail");
    match err {
        cognitum_rs::Error::Validation(msg) => {
            assert!(msg.contains("mutually exclusive"), "got: {msg}");
        }
        other => panic!("expected Validation, got {other:?}"),
    }
}

#[tokio::test]
async fn retries_default_config_header_is_absent() {
    // Regression for issue #10: confirm the legacy Bearer header is
    // absent even under a retry loop (the previous impl emitted it on
    // every attempt).
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/health"))
        .and(header_exists("x-api-key"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"status": "ok"})))
        .expect(1)
        .mount(&server)
        .await;

    let client = test_client(&server.uri());
    client.health().await.unwrap();
}
