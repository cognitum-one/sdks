//! A mutating seed POST is sent once when the seed may already have run it.
//!
//! ADR-0005 §Idempotency rule, issue #190. After a 500/502/504, a 503
//! without `Retry-After`, a read timeout or a connection dropped once the
//! request was written, a non-idempotent POST (`store().ingest()`) is neither
//! resent to the same peer nor replayed on the next one. A failure before the
//! request left the process (connection refused) still fails over, and the
//! attested-idempotent `store().query()` keeps its failover.
#![cfg(feature = "seed")]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use cognitum_one::seed::{SeedAuth, SeedClient, SeedTls, StoreIngest, StoreQuery, Timeouts};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const INGEST: &str = "/api/v1/store/ingest";
const QUERY: &str = "/api/v1/store/query";

fn client(endpoints: &[String]) -> SeedClient {
    let mut timeouts = Timeouts::default();
    timeouts.connect = Duration::from_secs(2);
    timeouts.read = Duration::from_millis(300);
    timeouts.total = Duration::from_secs(20);
    SeedClient::builder()
        .endpoints(endpoints)
        .auth(SeedAuth::None)
        .tls(SeedTls::System)
        .timeouts(timeouts)
        .max_retries(2)
        .build()
        .expect("seed client builds")
}

fn ingest() -> StoreIngest {
    StoreIngest { vectors: vec![] }
}

async fn requests(servers: &[&MockServer]) -> usize {
    let mut n = 0;
    for s in servers {
        n += s.received_requests().await.unwrap().len();
    }
    n
}

async fn failing_peer(template: ResponseTemplate) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(INGEST))
        .respond_with(template)
        .mount(&server)
        .await;
    server
}

/// A peer that reads one request and closes the connection without
/// answering. Returns its URL and a count of the requests it read.
async fn dropping_peer() -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(AtomicUsize::new(0));
    let counter = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let counter = counter.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let mut read = Vec::new();
                while let Ok(n) = socket.read(&mut buf).await {
                    if n == 0 {
                        return;
                    }
                    read.extend_from_slice(&buf[..n]);
                    if read.windows(4).any(|w| w == b"\r\n\r\n") {
                        counter.fetch_add(1, Ordering::SeqCst);
                        let _ = socket.shutdown().await;
                        return;
                    }
                }
            });
        }
    });
    (url, seen)
}

/// An address nothing listens on, so connecting is refused.
async fn closed_port() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    url
}

fn ambiguous_statuses() -> Vec<(&'static str, ResponseTemplate)> {
    vec![
        ("500", ResponseTemplate::new(500)),
        ("502", ResponseTemplate::new(502)),
        ("503 without Retry-After", ResponseTemplate::new(503)),
        ("504", ResponseTemplate::new(504)),
        (
            "read timeout",
            ResponseTemplate::new(200)
                .set_body_json(json!({}))
                .set_delay(Duration::from_secs(2)),
        ),
    ]
}

#[tokio::test]
async fn ingest_is_not_replayed_on_another_peer() {
    for (case, template) in ambiguous_statuses() {
        let a = failing_peer(template.clone()).await;
        let b = failing_peer(template).await;
        let c = client(&[a.uri(), b.uri()]);
        c.store().ingest(ingest()).await.unwrap_err();
        assert_eq!(
            requests(&[&a, &b]).await,
            1,
            "{case}: ingest sent more than once"
        );
    }
}

#[tokio::test]
async fn ingest_is_not_resent_to_a_single_peer() {
    for (case, template) in ambiguous_statuses() {
        let a = failing_peer(template).await;
        let c = client(&[a.uri()]);
        c.store().ingest(ingest()).await.unwrap_err();
        assert_eq!(
            requests(&[&a]).await,
            1,
            "{case}: ingest sent more than once"
        );
    }
}

#[tokio::test]
async fn ingest_is_not_resent_after_the_connection_drops() {
    let (a, seen_a) = dropping_peer().await;
    let (b, seen_b) = dropping_peer().await;
    client(&[a, b]).store().ingest(ingest()).await.unwrap_err();
    let total = seen_a.load(Ordering::SeqCst) + seen_b.load(Ordering::SeqCst);
    assert_eq!(
        total, 1,
        "ingest sent more than once after a dropped connection"
    );
}

#[tokio::test]
async fn ingest_fails_over_when_the_connection_was_refused() {
    let healthy = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(INGEST))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(&healthy)
        .await;
    let c = client(&[closed_port().await, healthy.uri()]);
    c.store()
        .ingest(ingest())
        .await
        .expect("fails over to the healthy peer");
    assert_eq!(requests(&[&healthy]).await, 1);
}

#[tokio::test]
async fn ingest_retries_a_503_that_carries_retry_after() {
    let a = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(INGEST))
        .respond_with(ResponseTemplate::new(503).insert_header("Retry-After", "0"))
        .up_to_n_times(1)
        .mount(&a)
        .await;
    Mock::given(method("POST"))
        .and(path(INGEST))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(&a)
        .await;
    client(&[a.uri()]).store().ingest(ingest()).await.unwrap();
    assert_eq!(requests(&[&a]).await, 2);
}

#[tokio::test]
async fn idempotent_query_still_fails_over_after_500() {
    let mut servers = Vec::new();
    for status in [500, 200] {
        let s = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(QUERY))
            .respond_with(ResponseTemplate::new(status).set_body_json(json!({"results": []})))
            .mount(&s)
            .await;
        servers.push(s);
    }
    let c = client(&[servers[0].uri(), servers[1].uri()]);
    c.store()
        .query(StoreQuery {
            vector: vec![0.1, 0.2],
            k: 1,
        })
        .await
        .expect("query fails over to the healthy peer");
    assert_eq!(requests(&[&servers[1]]).await, 1);
}
