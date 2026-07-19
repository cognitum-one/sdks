//! Micro-benchmark: capability/consent gate overhead across the three
//! fail-closed local checks added this mission (ADR-0019 §D6):
//!
//!   1. `meta_proxy::assert_consent_for_routing_intent` — PR #96's consent
//!      gating for `MetaProxyClient` data-plane calls (ADR-0025a §D9): a
//!      pure, synchronous, no-I/O function.
//!   2. `HarnessaaSClient::solve()`'s local capability gate (PR #109/#111,
//!      issue #74) — an async method, but the benchmarked path (an
//!      unsupported `vertical`) returns `Err` from `assert_solve_capability`
//!      before any credential acquisition or HTTP call is made.
//!   3. `MetaHarnessClient`'s fail-closed §D2 stubs (ADR-0026a) — every
//!      operational method (`capabilities()` here) throws
//!      `UnsupportedCapabilityError` before any process/network/filesystem
//!      access, since no bridge protocol exists upstream yet.
//!
//! These are all meant to be fast local pre-I/O gates, not bottlenecks —
//! this bench exists to confirm that empirically (microseconds, not
//! milliseconds) rather than assume it.
//!
//! Target (engineering estimate, NOT ADR-mandated — ADR-0019 §D6 requires
//! that these checks happen locally before I/O, but does not cite a
//! latency number): p50 < 100 µs per gate check. Three-orders-of-magnitude
//! headroom below the seed client's ADR-0005 <1ms-p50 network-overhead
//! budget, since none of these gates do any I/O at all.
//!
//! Run it as an example:
//!
//! ```bash
//! cargo run --release --features "meta-proxy,metaharness,harnessaas" \
//!     --example agentic_capability_bench
//! # or, registered as a bench target:
//! cargo bench --features "meta-proxy,metaharness,harnessaas" \
//!     --bench agentic_capability_bench
//! ```

#![cfg(all(feature = "meta-proxy", feature = "metaharness", feature = "harnessaas"))]

use std::time::{Duration, Instant};

use cognitum_one::agentic::{ConsentGrant, ConsentGrantKind};
use cognitum_one::harnessaas::{HarnessaaSClient, HarnessaaSClientConfig, HarnessaaSSolveRequest, HarnessaaSVertical};
use cognitum_one::meta_proxy::{assert_consent_for_routing_intent, RoutingIntent, RoutingPlane};
use cognitum_one::metaharness::{MetaHarnessClient, MetaHarnessConfig};

const ITERS: usize = 20_000;

async fn measure_async<F, Fut>(label: &str, iters: usize, mut f: F) -> Duration
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    for _ in 0..200 {
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
        "{label:60}  mean={:>9.3}µs  p50={:>9.3}µs  p95={:>9.3}µs",
        mean.as_secs_f64() * 1_000_000.0,
        p50.as_secs_f64() * 1_000_000.0,
        p95.as_secs_f64() * 1_000_000.0,
    );
    p50
}

fn expired_grant() -> ConsentGrant {
    ConsentGrant {
        kind: ConsentGrantKind::CloudFallback,
        product: "meta-proxy".to_owned(),
        origin: "http://127.0.0.1:11434".to_owned(),
        subject: "bench-subject".to_owned(),
        scope: "chat.completions".to_owned(),
        issued_at: "2020-01-01T00:00:00Z".to_owned(),
        expires_at: Some("2020-01-02T00:00:00Z".to_owned()),
        evidence_id: None,
    }
}

fn valid_grant() -> ConsentGrant {
    ConsentGrant {
        kind: ConsentGrantKind::CloudFallback,
        product: "meta-proxy".to_owned(),
        origin: "http://127.0.0.1:11434".to_owned(),
        subject: "bench-subject".to_owned(),
        scope: "chat.completions".to_owned(),
        issued_at: "2020-01-01T00:00:00Z".to_owned(),
        expires_at: Some("2099-01-01T00:00:00Z".to_owned()),
        evidence_id: None,
    }
}

fn solve_request() -> HarnessaaSSolveRequest {
    HarnessaaSSolveRequest::new(
        "https://github.com/acme/widget.git",
        "pytest -k test_widget",
        "Widget renders twice",
    )
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    println!("Capability/consent gate overhead — {ITERS} iterations each\n");

    // ------------------------------------------------------------------
    // 1. MetaProxyClient consent gate (pure, synchronous, no I/O).
    // ------------------------------------------------------------------
    let origin = "http://127.0.0.1:11434";
    let cloud_intent = RoutingIntent {
        required_plane: Some(RoutingPlane::CognitumCloud),
        ..Default::default()
    };
    let local_intent = RoutingIntent::default(); // never touches cognitum_cloud -> early no-op return

    let no_grants: Vec<ConsentGrant> = vec![];
    let expired = vec![expired_grant()];
    let valid = vec![valid_grant()];

    measure_async(
        "assert_consent_for_routing_intent (no-op: local plane)",
        ITERS,
        || {
            let intent = &local_intent;
            let grants = &no_grants;
            async move {
                let _ = assert_consent_for_routing_intent(Some(intent), grants, origin, "chat.completions");
            }
        },
    )
    .await;

    measure_async(
        "assert_consent_for_routing_intent (reject: no matching grant)",
        ITERS,
        || {
            let intent = &cloud_intent;
            let grants = &expired;
            async move {
                let _ = assert_consent_for_routing_intent(Some(intent), grants, origin, "chat.completions");
            }
        },
    )
    .await;

    measure_async(
        "assert_consent_for_routing_intent (accept: valid grant present)",
        ITERS,
        || {
            let intent = &cloud_intent;
            let grants = &valid;
            async move {
                let _ = assert_consent_for_routing_intent(Some(intent), grants, origin, "chat.completions");
            }
        },
    )
    .await;

    // ------------------------------------------------------------------
    // 2. HarnessaaSClient::solve() local capability gate. Base URL is
    // never actually dialed: the unsupported-vertical rejection happens
    // in `assert_solve_capability` before any credential acquisition or
    // HTTP call, so this measures pure gate overhead, not network I/O.
    // ------------------------------------------------------------------
    let harnessaas_config = HarnessaaSClientConfig::new("https://harnessaas.bench.invalid");
    let harnessaas_client = HarnessaaSClient::new(harnessaas_config).expect("client should construct");

    let mut unsupported_request = solve_request();
    unsupported_request.vertical = Some(HarnessaaSVertical::SecurityRemediation);

    measure_async(
        "HarnessaaSClient.solve (reject: unsupported vertical, pre-I/O)",
        ITERS,
        || {
            let client = &harnessaas_client;
            let request = &unsupported_request;
            async move {
                let _ = client.solve(request).await;
            }
        },
    )
    .await;

    // ------------------------------------------------------------------
    // 3. MetaHarnessClient fail-closed §D2 stub. No bridge process is ever
    // spawned; the whole call is a synchronous check + typed error return
    // wrapped in an async fn.
    // ------------------------------------------------------------------
    let metaharness_client =
        MetaHarnessClient::new(MetaHarnessConfig::new()).expect("client should construct");

    measure_async(
        "MetaHarnessClient.capabilities (fail-closed stub, pre-I/O)",
        ITERS,
        || {
            let client = &metaharness_client;
            async move {
                let _ = client.capabilities().await;
            }
        },
    )
    .await;

    println!("\nAll three gates are expected to clear p50 < 100µs (engineering target, not ADR-mandated).");
}
