//! Micro-benchmark: `SeedClient::status()` vs raw `reqwest::Client::get`.
//!
//! Target (ADR-0005 intent): <1 ms p50 overhead for the SDK wrapper
//! compared to the underlying `reqwest` client.
//!
//! This file uses `std::time::Instant` directly so it has zero additional
//! dev-dep cost. For a statistically-rigorous bench, add `criterion` to
//! `[dev-dependencies]` and convert to a `criterion_group!` harness.
//!
//! Run it as an example:
//!
//! ```bash
//! cargo run --release --features seed --example seed_bench
//! # or, once listed as a bench in Cargo.toml:
//! cargo bench --features seed --bench seed_bench
//! ```
//!
//! TODO: register as a proper `[[bench]]` target in Cargo.toml and
//! optionally adopt `criterion` when the SDK adds more benches.

#![cfg(feature = "seed")]

use std::time::{Duration, Instant};

use cognitum_rs::seed::{SeedAuth, SeedClient, SeedTls};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn start_mock() -> MockServer {
    let server = MockServer::start().await;
    let body = serde_json::json!({
        "device_id": "bench-0",
        "uptime_secs": 1,
        "epoch": 0,
        "total_vectors": 0,
        "deleted_vectors": 0,
        "file_size_bytes": 0,
        "dimension": 8,
        "paired": false,
        "roles": []
    });
    Mock::given(method("GET"))
        .and(path("/api/v1/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(&server)
        .await;
    server
}

async fn measure<F, Fut>(label: &str, iters: usize, mut f: F) -> Duration
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    // Warmup
    for _ in 0..50 {
        f().await;
    }
    let mut samples = Vec::with_capacity(iters);
    for _ in 0..iters {
        let t0 = Instant::now();
        f().await;
        samples.push(t0.elapsed());
    }
    samples.sort();
    let p50 = samples[iters / 2];
    let p95 = samples[(iters * 95) / 100];
    let mean: Duration = samples.iter().sum::<Duration>() / iters as u32;
    println!(
        "{label:30}  mean={:>7.3}ms  p50={:>7.3}ms  p95={:>7.3}ms",
        mean.as_secs_f64() * 1000.0,
        p50.as_secs_f64() * 1000.0,
        p95.as_secs_f64() * 1000.0,
    );
    p50
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let server = start_mock().await;
    let uri = server.uri();

    let client = SeedClient::builder()
        .endpoint(&uri)
        .auth(SeedAuth::None)
        .tls(SeedTls::System)
        .max_retries(0)
        .build()
        .expect("seed client");

    let raw = reqwest::Client::new();
    let raw_url = format!("{uri}/api/v1/status");

    let iters = 500;
    let raw_p50 = measure("raw reqwest GET", iters, || {
        let raw = raw.clone();
        let url = raw_url.clone();
        async move {
            let _ = raw
                .get(url)
                .send()
                .await
                .expect("send")
                .text()
                .await
                .expect("body");
        }
    })
    .await;

    let sdk_p50 = measure("SeedClient::status()", iters, || {
        let client = client.clone();
        async move {
            client.status().await.expect("status");
        }
    })
    .await;

    let delta_ms = (sdk_p50.as_secs_f64() - raw_p50.as_secs_f64()) * 1000.0;
    println!("\nSDK overhead (p50 delta): {delta_ms:.3} ms");
    if delta_ms < 1.0 {
        println!("PASS: <1 ms overhead");
    } else {
        println!("WARN: >=1 ms overhead");
    }
}
