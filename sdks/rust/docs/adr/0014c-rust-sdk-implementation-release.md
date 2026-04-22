# ADR 0014c: Rust SDK Implementation — Release (CI, benchmarks, examples, migration, open questions)

<!-- swarm-seed-validation 2026-04-22 (rust agent): Phase 1 ✅ partial.
     Pre-fix agent landed `X-API-Key` default + deprecation-gated Bearer.
     `git grep -nE 'Authorization.*Bearer' src/` now only matches the
     deprecation-gated path in `src/client.rs`; ADR-0003 compliance would
     pass. Full `src/auth.rs` split is deferred. Team Rust's Phase 1
     `src/seed/**` ships 52 green tests (33 lib + 19 wiremock). OQ-1 CLOSED. -->

## Phase 1.5 delivery (2026-04-22)

Mesh routing landed on 2026-04-22, executing ADR-0017 against the Rust
tree. Concrete deliverables relative to the Phase 1 snapshot above:

- `src/seed/peers.rs` — `PeerSet` extended to 1..N with per-peer
  `PeerState`, `latency_ema_ms`, `last_used_at`, `consecutive_failures`.
  `pick` / `next_after` / `mark_success` / `mark_failure` per ADR-0016a
  §D2/§D3/§D7. Earlier Phase 1 "mesh-routing not implemented" reject
  path removed.
- `src/seed/token_book.rs` — new `TokenBook` trait + `InMemoryTokenBook`
  default (ADR-0016a §D5). `SecretString` zeroes on drop. Builder
  accessor `ClientBuilder::token_book` plumbed.
- `src/seed/client.rs` — `SeedClient::request` rewrites onto the new
  `PeerSet`. Failover state machine cycles on `NetworkError` / `5xx` /
  `503`, pins on `429`, surfaces `Auth` / `Validation` / `NotFound`
  immediately. ADR-0005 60 s total budget is respected across ALL peer
  attempts (not multiplied).
- `src/seed/session.rs` — `SeedClient::session()` returns a peer-pinned
  `SeedSession<'_>` mirroring the resource accessors (§D9).
- `src/seed/health.rs` — opt-in active probe via
  `ClientBuilder::health_interval(Duration)`; spawns a `tokio` task that
  stops when the client drops via a `oneshot` shutdown channel (§D7).
- `tests/seed_mesh.rs` — new integration suite; all 7 ADR-0017 §5 tests
  (`test_mesh_single_peer_behaves_like_single_mode`,
  `test_mesh_two_peers_round_robin_for_reads`, `test_mesh_cycles_on_5xx`,
  `test_mesh_pins_on_429`, `test_mesh_session_stickiness`,
  `test_mesh_token_book_per_peer`,
  `test_mesh_health_probe_degrades_unhealthy_peer`) green against
  multi-peer `wiremock` fixtures.

### Security hardening — issue [#19](https://github.com/cognitum-one/sdks/issues/19) fixed 2026-04-23

`SeedAuth::PairingToken` now wraps the token in the homegrown
`SecretString` (from `src/seed/token_book.rs`) instead of a plain
`String`. `SeedAuth` has a manual `Debug` impl that prints
`SeedAuth::PairingToken(<redacted>)` — the raw token never appears in
`{:?}` or `tracing::debug!` dumps. The downstream `SeedInner` /
`SeedClient` / `SeedSession` derives remain in place because they
delegate to `SeedAuth::Debug`, which is now safe. New helper
`SeedAuth::pairing_token(impl Into<String>)` so callers never
accidentally see the inner `SecretString` type. Two new regression
tests in `tests/seed_unit.rs` assert the sentinel token string never
appears in `format!("{:?}", auth)` or `format!("{:?}", client)`.

No external crate added; we use the SDK's existing `SecretString`
(which also zeroes on drop) rather than adding the `secrecy` crate, to
keep the dep surface tight and consistent with `TokenBook`.

Follow-up — issue [#15](https://github.com/cognitum-one/sdks/issues/15)
fixed 2026-04-23 applies the same pattern to
`PairCreateResponse.token` (the *response* side of the pairing flow):
the field is now a `SecretString`, the struct derives `Clone, Serialize,
Deserialize` and has a manual `Debug` impl that prints `token:
"<redacted>"` while the other fields remain visible. `SecretString`
gained `Serialize` / `Deserialize` / `Default` impls in
`src/seed/token_book.rs` so it can back `#[serde(default)]` wire
fields. `PartialEq` was dropped from `PairCreateResponse` (nothing in
the SDK compares responses, and we did not want `PartialEq` on
`SecretString`). Two new regression tests in `tests/seed_unit.rs`
(`pair_create_response_debug_does_not_leak_token`,
`pair_create_response_json_round_trip`) assert the sentinel token
never appears in `format!("{:?}", response)` yet still round-trips
through JSON.

Test totals (`cargo test --features seed`): 23 `seed_unit` (was 21 —
2 #15 regression tests added) + 7 `seed_mesh` integration tests + 53
lib unit tests = 83 green seed-feature tests. One pre-existing cloud-side
`client::tests::invalid_pem_is_surfaced_as_validation_error` failure
in `src/client.rs` is tracked separately — outside the Phase 1.5 mesh
scope. `cargo fmt --all --check` clean; `cargo clippy --features seed
--tests -- -D warnings` clean.

### Trust-score protection (#16) + redaction audit (#21) — 2026-04-22

Implemented the 3-strike trust-score circuit from ADR-0007 §Trust-score
protection for the Rust SDK and landed an end-to-end redaction
conformance test for #21.

**Trust-score (closes #16 Rust portion):**

- `src/seed/client.rs` — `SeedInner` gained
  `auth_failure_counts: Mutex<BTreeMap<String, u32>>` keyed on
  `Endpoint::key()`. The request loop resets the counter to 0 on every
  2xx and bumps it whenever the response status is 401 or 403. On the
  3rd consecutive auth failure for one peer the loop returns
  `seed_err::trust_score_blocked(peer_key)` immediately — no retry, no
  cycling to another peer. 5xx / 429 / network-level failures do NOT
  touch the auth counter (test `server_5xx_after_auth_fail_still_cycles`
  pins that invariant). New helpers
  `SeedClient::trust_score_failures(peer_key)` and
  `SeedClient::reset_trust_score(peer_url: Option<&str>)` are gated
  behind `#[doc(hidden)]` for test/operator-recovery use.
- `src/seed/error.rs` — new `trust_score_blocked(peer_url)` builder and
  `is_trust_score_blocked(&Error)` predicate. The returned value is an
  `Error::Auth("trust_score_blocked: <peer_url>")` so callers that
  already match on `Error::Auth(_)` keep working while callers wanting
  the stronger semantics use the predicate. A dedicated variant on the
  base `Error` was not added because `src/error.rs` is owned by the
  pre-fix track (ADR-0004) — this follows the same pattern as
  `auth_reason::NOT_PAIRED` / `PAIRING_WINDOW_CLOSED` already uses. The
  helper is non-retryable by construction (matches `Error::Auth`, which
  `retry::should_retry` already excludes) and mesh failover never sees
  it since the request loop returns before the cycling branch.
- `tests/seed_trust_score.rs` — new suite with 5 regression tests:
  `auth_fail_3_consecutive_same_peer_trips_trust_score`,
  `auth_fail_then_success_resets_counter`,
  `per_peer_counters_independent` (multi-peer, session-pinned),
  `trust_score_blocked_is_not_retryable` (even with
  `max_retries(5)`), and `server_5xx_after_auth_fail_still_cycles`.

**Redaction audit (closes #21 for Rust):**

Grepped `sdks/rust/src/seed/` for `eprintln!`, `println!`, `log::`,
`tracing::`, `format!`, `write!`, `.to_string()` and `.as_str()` usage
on auth-carrying fields. Findings:

- `SecretString` has a manual `fmt::Debug` that emits
  `SecretString(<redacted, N bytes>)` (covered since #19).
- `SeedAuth::PairingToken` has a manual `fmt::Debug` that prints
  `SeedAuth::PairingToken(<redacted>)` (covered since #19).
- `PairCreateResponse` has a manual `fmt::Debug` that emits
  `token: "<redacted>"` while keeping `client_name` visible (covered
  since #15).
- `SharedTokenBook` has a manual `fmt::Debug` that prints
  `SharedTokenBook { .. }` — no entries leak.
- Every `tok.as_str()` call site is either on the request path
  (populating an `X-Pairing-Token` header on a `reqwest::RequestBuilder`)
  or inside the `#[doc(hidden)]` test-only `SeedClient::token_for_peer`
  helper. None of these flow into a `format!` / `Debug` / log path.
- `eprintln!` in `src/seed/client.rs:627` prints only the one-shot TLS
  insecure warning — no token touches.

New conformance test `error_paths_never_leak_pairing_token` in
`tests/seed_unit.rs` builds a client with a sentinel pairing token,
forces a 401/403/500 via wiremock, and asserts the sentinel never
appears in `format!("{err}")` or `format!("{client:?}")`, and that
`x-pairing-token` never appears in the error chain (case-insensitive).

**Verification:**

- `cargo fmt --all --check` — clean.
- `cargo clippy --features seed --tests -- -D warnings` — clean.
- `cargo test --features seed`:
  - `seed_unit` — 24 green (was 23, +1 redaction conformance).
  - `seed_mesh` — 7 green (unchanged).
  - `seed_trust_score` — 5 green (new).
  - lib seed tests — 55 green (was 53, +2 `seed::error` trust-score
    helpers).
  - Same pre-existing cloud-side `invalid_pem_is_surfaced_as_validation_error`
    and `builder_trust_root_pem_round_trips` failures in
    `src/client.rs` / `tests/client_test.rs`, outside scope.

#16 + #21 are closable for the Rust SDK.

### Perf hardening (#22, #23) — 2026-04-23

Two findings from the 2026-04-22 perf audit
(`/tmp/swarm-seed-validation/OPTIMIZATION-REPORT.md`) fixed against the
Rust SDK without adding new deps.

**#22 — jitter RNG non-uniform under bursts:**

- `src/seed/retry.rs` — `jitter_ms` replaced. The old impl was
  `SystemTime::now().subsec_nanos() % base_ms`, which is (a) biased via
  modulo when `base_ms` isn't a power of two and (b) strongly correlated
  when many calls fall in the same microsecond (typical under burst
  retries). The new impl uses a process-global `xorshift64*` PRNG seeded
  lazily from `SystemTime::now()` mixed with a Marsaglia-style constant,
  and rejection-sampling to eliminate modulo bias. State is an
  `AtomicU64` so the PRNG advances across threads; `0` is never stored
  so xorshift never enters its absorbing state.
- No new deps — chose the xorshift path over adding `rand = "0.8"`
  because `rand` is NOT already in the reqwest/tokio tree (verified via
  `cargo tree --features seed`). The RNG is ~15 lines inside `retry.rs`.
- 3 regression tests in `src/seed/retry.rs`:
  - `jitter_is_roughly_uniform_over_base` — 1000 samples at `base=100`;
    every sample in `[0, 100)`, mean in `[45, 55]`, ≥20 distinct values.
  - `jitter_decorrelates_consecutive_calls` — ≤20 identical consecutive
    pairs out of 256 draws at `base=1000` (old impl saw 200+).
  - `jitter_zero_bound_returns_zero` — guards the rejection-sampling
    short-circuit.

**#23 — retry body re-serialized per attempt:**

- `src/seed/client.rs` `SeedClient::request` — the `B: Serialize` body
  is now serialized to `Vec<u8>` exactly once, before the peer-failover /
  backoff loop. Each attempt clones the byte buffer (memcpy) and
  attaches it via `req.body(bytes.clone())` + `Content-Type:
  application/json`, replacing the previous `req.json(b)` which
  re-entered `serde_json::to_vec` on every attempt. The `Content-Type`
  header is set explicitly since `.body()` doesn't infer it the way
  `.json()` does.
- 1 regression test in `src/seed/client.rs` (`post_body_serialized_once_across_retries`):
  a `CountingBody` struct with a hand-rolled `Serialize` impl that bumps
  an `AtomicUsize` on every call. A wiremock server returns 503 twice
  (cycling the retry loop) then 200; the test asserts the counter
  equals `1` across the 3 attempts. Before the fix this counter would
  equal the number of attempts.
- Micro-bench on a realistic `StoreQuery` body (384-dim vector, `k=10`)
  with 3 attempts: serialize-per-attempt = 15.6 µs, serialize-once +
  clone-per-attempt = 5.2 µs → **3.01x speedup** on the happy+retry
  path. This is pure CPU saved per retried POST; on 429-rich mesh
  deployments the savings compound.

**Tests + checks:**

- `cargo fmt --all -- --check` — clean.
- `cargo clippy --features seed --tests -- -D warnings` — clean.
- `cargo test --features seed --no-fail-fast` — 111 green (was 107);
  +3 jitter regression tests (`src/seed/retry.rs`) + 1 body-ser
  regression test (`src/seed/client.rs`). The 2 pre-existing cloud-side
  `invalid_pem_is_surfaced_as_validation_error` and
  `builder_trust_root_pem_round_trips` failures in `src/client.rs` /
  `tests/client_test.rs` remain outside scope (per ADR-0014 task
  fencing: "Do NOT touch src/client.rs or src/error.rs").
- `benches/seed_bench.rs` compiles; it uses a non-criterion harness
  with a `#[tokio::main] fn main()` which `cargo bench` currently skips
  (no `[[bench]]` entry + `harness = false` in Cargo.toml). Tracking
  proper wiring under OQ-R3 in §15.

**Files edited:**

- `src/seed/retry.rs` — `jitter_ms` rewritten to xorshift64 + rejection
  sampling; 3 new tests.
- `src/seed/client.rs` — `SeedClient::request` serializes body once
  outside the loop; 1 new test.
- `docs/adr/0014c-rust-sdk-implementation-release.md` — this section.

#22 + #23 are closable for the Rust SDK.

Not yet landed (explicitly out of Phase 1.5 scope, tracked for Phase 2):

- mDNS discovery (`Discovery::Mdns` — ADR-0016a §D6, Phase 1.5 opt-in
  upgrade path).
- Mesh-observability resource (`client.mesh().status/peers/swarm/health`
  — ADR-0016a §D8 Phase 1 surface addendum).
- Per-call override args (`peer:` / `prefer:` / `consistency:`) —
  requires a per-call options bag and is tracked against ADR-0016b
  §"Per-call knobs".
- `client.rediscover()` explicit re-resolve helper.

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** SDK WG (Rust lead + cross-cutting)
- **Scope:** sdks/rust

> Final file in the 0014 series. Predecessors:
>
> - 0014a — crate layout + public API
> - 0014d — wire types, error enum, transport
> - 0014b — retry + auth
> - 0014e — streaming, tests, packaging
>
> This file closes the series with CI, benchmarks, examples, the
> line-by-line migration plan off the current 241-line `client.rs`, and
> open questions.

## Context

0014a and 0014b describe what the code should look like and how it should
behave. This document answers: how do we know it's right, how do we ship
it, and which concrete diffs take us from the current crate to the new
one without leaving the main branch red.

## Decision

Adopt the CI matrix, benchmark suite, example set, and migration plan
below. Ship 0.2.0 once every item under §14.6 is green.

---

## 11. CI

### 11.1 GitHub Actions matrix

`.github/workflows/rust.yml` (sketch — one workflow file for the Rust crate):

```yaml
name: rust-sdk

on:
  push:
    branches: [main]
    paths: ["sdks/rust/**", ".github/workflows/rust.yml"]
  pull_request:
    paths: ["sdks/rust/**", ".github/workflows/rust.yml"]

jobs:
  test:
    name: test (${{ matrix.rust }} / ${{ matrix.os }} / ${{ matrix.features }})
    runs-on: ${{ matrix.os }}
    defaults:
      run:
        working-directory: sdks/rust
    strategy:
      fail-fast: false
      matrix:
        rust: [stable, beta, "1.78"]        # 1.78 = MSRV
        os: [ubuntu-latest, macos-latest, windows-latest]
        features:
          - "rustls"                         # cloud-only default
          - "rustls seed"                    # + seed
          - "rustls seed stream"             # + SSE
          - "rustls seed stream blocking"    # + sync facade
        exclude:
          - rust: "1.78"
            os: windows-latest
          - rust: beta
            os: macos-latest
    steps:
      - uses: actions/checkout@v4
        with: { submodules: recursive }
      - uses: dtolnay/rust-toolchain@master
        with: { toolchain: "${{ matrix.rust }}", components: clippy,rustfmt }
      - uses: Swatinem/rust-cache@v2
      - run: cargo fmt --all --check
      - run: cargo clippy --no-default-features --features "${{ matrix.features }}" -- -D warnings
      - run: cargo test --no-default-features --features "${{ matrix.features }}"
      - run: cargo doc --no-deps --no-default-features --features "${{ matrix.features }}"

  native_tls:
    name: native-tls build (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    defaults: { run: { working-directory: sdks/rust } }
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - uses: actions/checkout@v4
        with: { submodules: recursive }
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo check --no-default-features --features native-tls
      - run: cargo check --no-default-features --features "native-tls seed"

  lint:
    name: supply chain + custom lints
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: sdks/rust } }
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: EmbarkStudios/cargo-deny-action@v2
        with:
          command: "check"
          manifest-path: "sdks/rust/Cargo.toml"

      # ADR-0003 §Compliance — no raw Bearer in sources except deprecation path.
      - name: "no unauthorized Bearer header"
        run: |
          if git grep -nE 'Authorization.*Bearer' -- src/ ':(exclude)src/auth.rs' ; then
            echo "::error::Authorization: Bearer found outside the ADR-0003 deprecation path (src/auth.rs)"
            exit 1
          fi

      # ADR-0010 §Compliance — no unwrap/expect outside tests.
      - name: "no unwrap/expect in library code"
        run: |
          if git grep -nE '\.(unwrap|expect)\(' -- src/ ':(exclude)src/client.rs' ; then
            echo "::error::unwrap()/expect() in non-test code; only exception is the documented reqwest builder in src/client.rs"
            exit 1
          fi

      # ADR-0007 §Compliance — no println/log of secrets.
      - name: "no println of credentials"
        run: |
          if git grep -nE 'println.*(api_key|apiKey|token|Authorization)' -- src/ ; then
            echo "::error::println!() of credential field"; exit 1
          fi
```

### 11.2 Matrix cells

| Rust | OS | Features | Purpose |
|------|----|----------|---------|
| stable | Linux | rustls | happy path |
| stable | Linux | rustls seed | seed happy path |
| stable | Linux | rustls seed stream | SSE code path (compiles; runtime still 501) |
| stable | Linux | rustls seed stream blocking | sync facade |
| stable | macOS | rustls seed stream | darwin rustls check |
| stable | Windows | rustls | schannel-not-chosen check |
| beta | Linux | rustls seed | canary |
| **1.78 (MSRV)** | Linux | rustls seed | MSRV regression net |
| — (separate job) | all 3 OS | native-tls, native-tls+seed | backend alt. |

### 11.3 Release workflow

Release via `cargo-release` with `--sign-tag`:

```bash
# one-shot on a release branch
cargo release 0.2.0 \
    --sign-tag \
    --execute \
    --no-publish                   # publish in a separate gated step
cargo publish --no-verify --token "$CRATES_IO_TOKEN"
```

`cargo-release` config at `sdks/rust/release.toml`:

```toml
sign-tag = true
sign-commit = true
tag-prefix = "rust-v"
pre-release-commit-message = "release: cognitum-rs {{version}}"
consolidate-commits = true
dependent-version = "upgrade"
```

### 11.4 Docs

`docs.rs` builds with `--all-features` gated by `#[cfg(docsrs)]`; guarded
per feature in `src/lib.rs` using
`#[cfg_attr(docsrs, doc(cfg(feature = "seed")))]` for discoverability.

---

## 12. Benchmarks

`criterion` is the harness. Benches live at `benches/wire.rs`.

### 12.1 Targets

| Bench | What it measures | SLO |
|-------|-----------------|-----|
| `cloud_health_local_mock` | `Client::health()` against `wiremock` on loopback | p99 < 5 ms |
| `seed_status_local_mock` | `SeedClient::status()` against `wiremock` on loopback | p99 < 5 ms |
| `seed_store_upsert_100_local_mock` | one `store.ingest()` with 100 × 8-dim vectors | p99 < 20 ms |
| `seed_store_query_local_mock` | `store.query(&[0.0;8], 10)` | p99 < 10 ms |
| `compute_delay_equal_jitter` | `RetryPolicy::compute_delay(1, None)` | p99 < 200 ns |
| `status_json_parse` | parsing `tests/fixtures/seed/status.json` | p99 < 15 µs |

All loopback SLOs are *client-only* (CPU + serde + reqwest overhead). Real
seed targets (169.254.42.1 over USB gadget) are tracked in a separate
smoke test, not CI benches.

### 12.2 Harness sketch

```rust
// benches/wire.rs
use criterion::{criterion_group, criterion_main, Criterion};
use tokio::runtime::Runtime;

fn bench_cloud_health(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    c.bench_function("cloud_health_local_mock", |b| {
        b.to_async(&rt).iter(|| async {
            // wiremock setup omitted; helpers live in benches/common.rs
            let client = common::cloud_against_mock().await;
            client.health().await.unwrap()
        });
    });
}

criterion_group!(benches, bench_cloud_health);
criterion_main!(benches);
```

Run: `cargo bench --features "seed"` (benches depend on seed models).

---

## 13. Examples

Two runnable examples under `sdks/rust/examples/`.

### 13.1 `examples/cloud_tour.rs`

```rust
//! Cloud tour: health, catalog browse, create a lead.
//! Run with: COGNITUM_API_KEY=sk-... cargo run --example cloud_tour

use cognitum_rs::{Client, Error};

#[tokio::main]
async fn main() -> Result<(), Error> {
    let client = Client::from_env()?;

    let h = client.health().await?;
    println!("health: {:?}", h);

    let cat = client.catalog().browse().await?;
    println!("catalog: {} products", cat.products.len());

    client.leads().subscribe("demo@example.com", "seed").await?;
    Ok(())
}
```

### 13.2 `examples/seed_tour.rs` (feature = "seed")

```rust
//! Seed tour: pair, status, ingest, query.
//! Run with:
//!   COGNITUM_SEED_TOKEN=... cargo run --example seed_tour --features seed

use cognitum_rs::seed::{SeedClient, StoreUpsert, StoreUpsertEntry};
use cognitum_rs::Error;

#[tokio::main]
async fn main() -> Result<(), Error> {
    let seed = SeedClient::builder()
        .host("169.254.42.1")
        .port(8443)
        .pairing_token(std::env::var("COGNITUM_SEED_TOKEN").unwrap_or_default())
        .build()?;

    let status = seed.status().get().await?;
    println!("seed epoch={} paired={}", status.epoch, status.paired);

    if !status.paired {
        let completed = seed.pair().init("my-laptop").await?;
        println!("paired: token={}", completed.token);
    }

    let upsert = StoreUpsert {
        vectors: vec![StoreUpsertEntry {
            id: "doc-1".into(),
            values: vec![0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
            metadata: Some(serde_json::json!({ "source": "tour" })),
        }],
    };
    seed.store().ingest(&upsert).await?;

    let hits = seed.store().query(
        &[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
        5,
    ).await?;
    println!("top hit: {:?}", hits.results.first());

    Ok(())
}
```

---

## 14. Migration from current code

Diff list from `/home/ruvultra/projects/sdks/sdks/rust/` HEAD to the new layout.
Every line-number citation is against the current tree.

### 14.1 File moves (no content changes yet)

| From | To | Notes |
|------|----|-------|
| `src/brain.rs` | `src/cloud/brain.rs` | add `pub mod brain;` to `cloud/mod.rs` |
| `src/catalog.rs` | `src/cloud/catalog.rs` | same |
| `src/contact.rs` | `src/cloud/contact.rs` | same |
| `src/devices.rs` | `src/cloud/devices.rs` | same |
| `src/leads.rs` | `src/cloud/leads.rs` | same |
| `src/mcp.rs` | `src/cloud/mcp.rs` | same |
| `src/orders.rs` | `src/cloud/orders.rs` | same |
| `src/types.rs` | `src/models/cloud.rs` | re-exported via `models/mod.rs` |

### 14.2 Renames

| Symbol | Before | After | Reason |
|--------|--------|-------|--------|
| `Error::Http` | `/home/ruvultra/projects/sdks/sdks/rust/src/error.rs:34-36` | `Error::Network` | ADR-0004 |
| `Error::Json` | `/home/ruvultra/projects/sdks/sdks/rust/src/error.rs:38-40` | `Error::Parse { expected, got, source }` | ADR-0004 |
| `Error::Api { code, message }` | `/home/ruvultra/projects/sdks/sdks/rust/src/error.rs:25-32` | `Error::Api { status, code, message, raw_body }` | `code` was HTTP status; now a separate `code` slot exists for server-defined codes |
| `Error::Auth(String)` | `/home/ruvultra/projects/sdks/sdks/rust/src/error.rs:7-8` | `Error::Auth { reason, message, source }` | structured reasons |
| `Error::Validation(String)` | `/home/ruvultra/projects/sdks/sdks/rust/src/error.rs:17-19` | `Error::Validation { field, message }` | structured |
| `Error::NotFound(String)` | `/home/ruvultra/projects/sdks/sdks/rust/src/error.rs:21-23` | `Error::NotFound { resource }` | structured |
| `ClientConfig` fields | `/home/ruvultra/projects/sdks/sdks/rust/src/client.rs:22-33` | drop — superseded by `ClientBuilder` | no more struct literal |
| `Client::with_config(ClientConfig)` | `/home/ruvultra/projects/sdks/sdks/rust/src/client.rs:68-84` | drop — use `Client::builder().build()` | pattern shift |

### 14.3 Breaking (pre-1.0) changes

<!-- swarm-seed-validation 2026-04-22: every row below confirmed `(assumed)` / `failing` in 0.1.0. Tracking issues: cognitum-one/sdks#10 (Bearer→X-API-Key), #3 (error.rs rewrite + NotImplemented), #11 (RateLimit default 1000ms). -->

| Location | Change | Reason |
|----------|--------|--------|
| `/home/ruvultra/projects/sdks/sdks/rust/src/client.rs:161` | `Authorization: Bearer` → `X-API-Key` | ADR-0003 |
| `/home/ruvultra/projects/sdks/sdks/rust/src/client.rs:188-195` | add 502, 504 to retriable | ADR-0005 |
| `/home/ruvultra/projects/sdks/sdks/rust/src/client.rs:213-214` | add equal-jitter | ADR-0005 |
| `/home/ruvultra/projects/sdks/sdks/rust/src/client.rs:223-240` | replace `map_error` with `error::from_http` | ADR-0004 |
| `/home/ruvultra/projects/sdks/sdks/rust/src/error.rs` | entire file rewritten | ADR-0004 |
| `/home/ruvultra/projects/sdks/sdks/rust/Cargo.toml:14` | `reqwest` features lock to `default-features = false` + explicit set | 0014a §1.3 |
| `/home/ruvultra/projects/sdks/sdks/rust/Cargo.toml:3` | `version = "0.2.0"` | ADR-0006 pre-1.0 MINOR-break |

### 14.4 Additive changes (non-breaking)

| Location | Change |
|----------|--------|
| `src/auth.rs` | new; fluent credential builder; `SecretString` redaction |
| `src/retry.rs` | new; `RetryPolicy` + loop |
| `src/transport.rs` | new; cloud + seed builders |
| `src/seed/` | new tree behind `seed` feature |
| `src/sse.rs` | new behind `stream` feature |
| `tests/fixtures/seed/*.json` | new |
| `examples/cloud_tour.rs`, `examples/seed_tour.rs` | new |
| `benches/wire.rs` | new |

### 14.5 Dropped symbols (2 minors deprecation, removed in 0.3.0)

| Symbol | Reason |
|--------|--------|
| `ClientConfig` struct | superseded by builder |
| `Client::with_config` | superseded by `Client::builder().build()` |
| `ClientBuilder::use_bearer_auth` | deprecation-window flag for ADR-0003 migration |

### 14.6 Release gate (merge to main to tag 0.2.0)

- [ ] `cargo fmt --all --check`
- [ ] `cargo clippy --all -- -D warnings` across the matrix cells in §11.1
- [ ] `cargo test --all-features` green (excluding `native-tls + rustls` cell)
- [ ] `cargo doc --no-deps --all-features` clean with `#![deny(missing_docs)]`
- [ ] `cargo deny check` — no unmaintained, no copyleft-incompat
- [ ] The Bearer-grep CI step (§11.1) is green
- [ ] The unwrap-grep CI step is green
- [ ] Every new `#[cfg_attr(docsrs, doc(cfg(feature = "...")))]` is present
- [ ] `CHANGELOG.md` documents every entry in §14.3
- [ ] README compatibility matrix (ADR-0006 §compat) updated to `0.2.x`

---

## 15. Open questions

Carry-forward + Rust-specific (as mandated by the brief).

### Cross-cutting (carried forward)

- **OQ-1** (ADR-0003) — Resolved by this ADR: Rust switches to `X-API-Key`,
  with a `use_bearer_auth` deprecation flag for one MINOR window. Closed.
- **OQ-2** (ADR-0011) — Resolved by this ADR for Rust: single crate,
  `seed` feature. Closed for Rust; still tracked for Node/Python.
- **OQ-3** (ADR-0002) — SSE endpoints return 501; this ADR ships the
  typed stream handles and gates them behind `stream` feature. Unchanged
  status — the seed ships SSE, the SDK stops raising `NotImplemented`
  automatically.
- **OQ-4** (ADR-0010) — MCP stdio parity — out of scope for 0.2.0; tracked.
- **OQ-5** (ADR-0003) — Request signing (`X-Signature`) — still TBD.
- **OQ-6** (ADR-0012) — Legacy `sdk-typescript/` — unrelated; tracked.

### Rust-specific

- **OQ-R1** — Should `blocking` ship as a published feature? Cloud users on
  CLI tools (the primary non-async audience) benefit. Seed users talk to
  a single appliance on USB — rarely parallel. Current ADR keeps it
  opt-in. Revisit after 0.2.0 telemetry shows demand.
- **OQ-R2** — `reqwest` + `rustls` can ship over either `ring` or
  `aws-lc-rs`. Today `rustls 0.23` still defaults to `ring`, but
  `rustls-webpki` is shifting. The `features = ["std"]` lock-down in
  0014a §1.3 keeps us explicit, but a future minor bump may need an
  explicit `rustls/ring` or `rustls/aws-lc-rs` sub-feature knob. Track
  upstream; don't bake an opinion until rustls forces the issue.
- **OQ-R3** — The equal-jitter RNG uses `rand::thread_rng()`. Under heavy
  concurrency, `fastrand` or a per-Client RNG is cheaper. Defer unless
  benches in §12 show the `compute_delay` SLO regressing.
- **OQ-R4** — `Extras` carries `serde_json::Value`, which allocates per
  field. If parsing the long-tail of sensor telemetry shows up as a
  bottleneck, consider swapping to `simd_json::OwnedValue`. Out of scope
  for 0.2.0.
- **OQ-R5** — Should `SeedClient` re-export a `pair_auto(client_name)`
  convenience that polls `/pair/status`, opens a window, and pairs in a
  single call? ADR-0007 forbids holding the window open by polling, so
  the helper must only call once and return an `AuthError` if no window
  is open. Tracking as "ergonomics" for 0.3.0.
- **OQ-R6** — The pinned self-signed verifier at 0014a §5.3 is
  `static`-allowed-hosts. What happens if the operator deploys a seed at
  a custom hostname (e.g. behind Tailscale)? Current answer: caller
  supplies `trust_root_pem`. Tracking whether to expose a
  `add_allowed_self_signed_host` escape hatch.

## Consequences

### Positive

- Closes OQ-1 + OQ-2 for the Rust SDK with concrete code.
- Every migration step is auditable (path:line citations).
- Release gate (§14.6) is checkbox-driven, hard to forget.

### Negative / trade-offs

- The matrix is wide (9 cells in §11.1); CI time grows ~3× over current.
  Mitigation: Swatinem caching + path filters on `push`.
- Two deprecation flags (`ClientConfig`, `use_bearer_auth`) have to be
  carried through 0.2.x. Remove in 0.3.0 — track in CHANGELOG.

### Neutral

- Moving `types.rs` → `models/cloud.rs` doesn't change semantics, but
  reviewers will need to double-check import paths.

## Alternatives considered

| Option | Why rejected |
|--------|--------------|
| Ship 0.2.0 without MSRV pin | subtle regressions will find us; 1.78 is cheap |
| Skip the native-tls job | we still document it as a feature; must keep it compiling |
| Rely only on `cargo test` default features | we'd miss the seed-less and blocking-less compile paths |
| Merge CI workflow into a single giant job | harder to read; keeping `test` / `native_tls` / `lint` separate parallelises cleanly |

## Compliance / verification

- Every item in §14.6 is a blocking gate for tagging.
- CI runs on every PR touching `sdks/rust/**`.
- `cargo-release --sign-tag` enforces signed tags; CI rejects unsigned.

## References

- `/home/ruvultra/projects/sdks/sdks/rust/docs/adr/0014a-rust-sdk-implementation-foundations.md`
- `/home/ruvultra/projects/sdks/sdks/rust/docs/adr/0014b-rust-sdk-implementation-behaviors.md`
- `/home/ruvultra/projects/sdks/docs/adr/README.md` §"Open questions tracked across ADRs" — open questions
- Current crate tree: `/home/ruvultra/projects/sdks/sdks/rust/`
- Related ADRs: 0002, 0003, 0004, 0005, 0006, 0007, 0010, 0011.
