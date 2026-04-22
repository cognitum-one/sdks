# ADR 0014c: Rust SDK Implementation — Release (CI, benchmarks, examples, migration, open questions)

<!-- swarm-seed-validation 2026-04-22 (rust agent): overall ❌ CI guards not
     in place. `git grep -nE 'Authorization.*Bearer' src/` matches
     src/client.rs:161 today; the ADR-0003 compliance check would FAIL if
     it were enabled. Deprecation path (src/auth.rs) does not exist yet.
     OQ-1 OPEN. Report: /tmp/swarm-seed-validation/reports/rust.json. -->

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

- `/home/ruvultra/projects/sdks/docs/adr/impl/0014a-rust-sdk-implementation-foundations.md`
- `/home/ruvultra/projects/sdks/docs/adr/impl/0014b-rust-sdk-implementation-behaviors.md`
- `/home/ruvultra/projects/sdks/docs/adr/README.md:46-56` — open questions
- Current crate tree: `/home/ruvultra/projects/sdks/sdks/rust/`
- Related ADRs: 0002, 0003, 0004, 0005, 0006, 0007, 0010, 0011.
