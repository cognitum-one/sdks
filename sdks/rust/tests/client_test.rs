use cognitum_rs::{Client, ClientConfig};
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn test_client(base_url: &str) -> Client {
    Client::with_config(ClientConfig {
        api_key: "test-key".to_owned(),
        base_url: Some(base_url.to_owned()),
        timeout_secs: 5,
        max_retries: 0,
    })
}

#[tokio::test]
async fn health_check_returns_ok() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/health"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"status": "ok", "version": "1.0.0"})),
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
    let resp = client
        .orders()
        .create("test@example.com", 1)
        .await
        .unwrap();
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
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"success": true})),
        )
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
    let device = client
        .devices()
        .register("ed25519-pk-abc")
        .await
        .unwrap();
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
        .respond_with(
            ResponseTemplate::new(401).set_body_string("invalid token"),
        )
        .mount(&server)
        .await;

    let client = test_client(&server.uri());
    let err = client.health().await.unwrap_err();
    assert!(
        matches!(err, cognitum_rs::Error::Auth(_)),
        "expected Auth, got: {err:?}"
    );
}
