//! Query values must reach the server exactly as the caller passed them.
//!
//! A bare `+` in a query string is decoded as a space, and a bare `%` starts
//! an escape, so both must be percent-encoded along with everything else
//! outside the RFC 3986 unreserved set.

use cognitum_one::{Client, ClientConfig};
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn client(base_url: &str) -> Client {
    Client::with_config(ClientConfig {
        api_key: "test-key".to_owned(),
        base_url: Some(base_url.to_owned()),
        timeout_secs: 5,
        max_retries: 0,
        ..Default::default()
    })
}

async fn decoded_query(server: &MockServer) -> Vec<(String, String)> {
    let requests = server.received_requests().await.unwrap();
    requests[0]
        .url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

#[tokio::test]
async fn order_status_email_round_trips() {
    for email in [
        "alice+tag@example.com",
        "100%real@example.com",
        // Valid escape sequences must stay literal text, not be decoded.
        "alice%2Btag@example.com",
        "50%25off@example.com",
        "a%26b@example.com",
        "a&b=c@example.com",
        "zoë@example.com",
    ] {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/lookupOrderStatus"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .mount(&server)
            .await;

        client(&server.uri()).orders().status(email).await.unwrap();
        assert_eq!(
            decoded_query(&server).await,
            vec![("email".to_owned(), email.to_owned())],
            "email {email:?} did not survive encoding"
        );
    }
}

#[tokio::test]
async fn catalog_category_round_trips() {
    let category = "C++ & Rust 100% %2B%26";
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/listTemplates"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"products": []})))
        .mount(&server)
        .await;

    client(&server.uri())
        .catalog()
        .browse_with_category(category)
        .await
        .unwrap();
    assert_eq!(
        decoded_query(&server).await,
        vec![("category".to_owned(), category.to_owned())]
    );
}
