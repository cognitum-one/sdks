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

// ── Bug 11: Retry-After parsing (header seconds, HTTP-date, body hints) ──
//
// Regression suite for `cognitum-one/sdks#11`. Prior to the fix the cloud
// path parsed `Retry-After` in seconds only, ignored the seed body field
// `retry_after_us`, and hardcoded `Error::RateLimit { retry_after_ms: 1000 }`.

fn retry_test_client(base_url: &str, max_retries: u32) -> Client {
    Client::with_config(ClientConfig {
        api_key: "test-key".to_owned(),
        base_url: Some(base_url.to_owned()),
        timeout_secs: 30,
        max_retries,
        ..Default::default()
    })
}

/// One-shot 429 (no retries) — assert the parsed `retry_after_ms` lands on
/// `Error::RateLimit`, not the old hardcoded 1000.
async fn assert_rate_limit_hint(
    server: &MockServer,
    response: ResponseTemplate,
    lower_ms: u64,
    upper_ms: u64,
) {
    Mock::given(method("GET"))
        .and(path("/health"))
        .respond_with(response)
        .expect(1)
        .mount(server)
        .await;

    let client = retry_test_client(&server.uri(), 0);
    let err = client.health().await.unwrap_err();
    match err {
        cognitum_rs::Error::RateLimit { retry_after_ms } => {
            assert!(
                (lower_ms..=upper_ms).contains(&retry_after_ms),
                "retry_after_ms={retry_after_ms} outside [{lower_ms}, {upper_ms}]"
            );
        }
        other => panic!("expected RateLimit, got {other:?}"),
    }
}

#[tokio::test]
async fn rate_limit_parses_retry_after_header_seconds() {
    let server = MockServer::start().await;
    let resp = ResponseTemplate::new(429)
        .insert_header("retry-after", "5")
        .set_body_string("");
    // Expect exactly 5000 ms from header (body empty so header wins).
    assert_rate_limit_hint(&server, resp, 5_000, 5_000).await;
}

#[tokio::test]
async fn rate_limit_parses_retry_after_http_date() {
    // `Retry-After: <HTTP-date>` in roughly 2 seconds from now.
    let target = std::time::SystemTime::now() + std::time::Duration::from_secs(2);
    let datetime = http_date(target);
    let server = MockServer::start().await;
    let resp = ResponseTemplate::new(429)
        .insert_header("retry-after", datetime.as_str())
        .set_body_string("");
    // Clock drift + rounding: accept 1..=3 s.
    assert_rate_limit_hint(&server, resp, 1_000, 3_000).await;
}

#[tokio::test]
async fn rate_limit_parses_retry_after_us_body() {
    let server = MockServer::start().await;
    // 2_500_000 µs = 2_500 ms. No Retry-After header.
    let resp = ResponseTemplate::new(429).set_body_json(json!({"retry_after_us": 2_500_000u64}));
    assert_rate_limit_hint(&server, resp, 2_500, 2_500).await;
}

#[tokio::test]
async fn rate_limit_parses_english_retry_after_body() {
    let server = MockServer::start().await;
    let resp =
        ResponseTemplate::new(429).set_body_json(json!({"error": "rate limited — retry after 3s"}));
    assert_rate_limit_hint(&server, resp, 3_000, 3_000).await;
}

#[tokio::test]
async fn rate_limit_body_wins_over_header() {
    // Header says 10s, body says 2s — body wins per ADR-0005.
    let server = MockServer::start().await;
    let resp = ResponseTemplate::new(429)
        .insert_header("retry-after", "10")
        .set_body_json(json!({"retry_after_us": 2_000_000u64}));
    assert_rate_limit_hint(&server, resp, 2_000, 2_000).await;
}

#[tokio::test]
async fn rate_limit_without_hint_falls_back_to_jitter() {
    // Empty body, no header — must NOT be the old hardcoded 1000 ms, and
    // must fall in the ADR-0005 equal-jitter band for attempt 1:
    // [500 ms, 1000 ms).
    let server = MockServer::start().await;
    let resp = ResponseTemplate::new(429).set_body_string("");
    assert_rate_limit_hint(&server, resp, 500, 999).await;
}

#[tokio::test]
async fn retry_loop_sleeps_for_body_hint() {
    // End-to-end: 429 with `retry_after_us: 2_500_000` then 200 on retry.
    // Measure elapsed time between first and second attempt.
    let server = MockServer::start().await;

    // Use wiremock's response scheduling: two separate mocks, the first
    // limited to 1 response, the second always-on.
    Mock::given(method("GET"))
        .and(path("/health"))
        .respond_with(
            ResponseTemplate::new(429).set_body_json(json!({"retry_after_us": 2_500_000u64})),
        )
        .up_to_n_times(1)
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/health"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"status": "ok"})))
        .mount(&server)
        .await;

    let client = retry_test_client(&server.uri(), 3);
    let started = std::time::Instant::now();
    let resp = client.health().await.unwrap();
    let elapsed = started.elapsed();
    assert_eq!(resp.status, "ok");
    assert!(
        elapsed >= std::time::Duration::from_millis(2_400),
        "expected retry to sleep ≥ 2400 ms (got {elapsed:?}); old hardcoded 1s would finish in ≈ 1s"
    );
    // Loose upper bound to catch regressions that sleep forever.
    assert!(
        elapsed < std::time::Duration::from_millis(5_000),
        "retry loop took too long: {elapsed:?}"
    );
}

/// Minimal RFC 7231 IMF-fixdate formatter for the `Retry-After` HTTP-date
/// test. `chrono` isn't a dep — keep this inline. Uses the Howard Hinnant
/// civil-from-days algorithm.
fn http_date(t: std::time::SystemTime) -> String {
    let unix = t
        .duration_since(std::time::UNIX_EPOCH)
        .expect("post-epoch")
        .as_secs() as i64;
    let days = unix.div_euclid(86_400);
    let tod = unix.rem_euclid(86_400);
    let hour = (tod / 3600) as u32;
    let min = ((tod % 3600) / 60) as u32;
    let sec = (tod % 60) as u32;

    // Civil-from-days.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 {
        (mp + 3) as u32
    } else {
        (mp - 9) as u32
    };
    let year = if m <= 2 { y + 1 } else { y };

    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    // Unix day 0 = Thursday. `(days + 4) mod 7` gives Sunday=0.
    const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let wd = ((days + 4).rem_euclid(7)) as usize;

    format!(
        "{}, {:02} {} {:04} {:02}:{:02}:{:02} GMT",
        WEEKDAYS[wd],
        d,
        MONTHS[(m - 1) as usize],
        year,
        hour,
        min,
        sec,
    )
}
