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

### Cloud retry parity (#11) — cloud path compliant 2026-04-23

Closes the cloud half of `cognitum-one/sdks#11` (the seed half landed
2026-04-22 alongside #16/#21). Before this change `src/client.rs` only
parsed the `Retry-After` response header in seconds-integer form,
ignored the seed body field `retry_after_us`, and surfaced every 429 as
`Error::RateLimit { retry_after_ms: 1000 }` regardless of what the
server actually advertised.

**Files edited:**

- `src/client.rs` — `request` now reads the response body exactly once
  on the non-success branch and feeds both (a) backoff decision and
  (b) `map_error`. New helper `parse_retry_after(headers, body)` mirrors
  `src/seed/retry.rs::parse_retry_after` and adds an inline RFC 7231
  IMF-fixdate parser on the header (no new crates — `chrono` and
  `httpdate` are not in the reqwest tree). New `equal_jitter_backoff`
  helper implements ADR-0005 §"Backoff formula" as a fallback when no
  hint is present. Body wins over header per ADR-0005 seed convention.
- `src/error.rs` — `Error::RateLimit.retry_after_ms` field documentation
  expanded to cite the ADR-0005 resolution order. New `Error::retry_after()`
  accessor returns `Option<Duration>` so callers don't hand-convert ms.

**Tests added (7 in `tests/client_test.rs`):**

- `rate_limit_parses_retry_after_header_seconds`
- `rate_limit_parses_retry_after_http_date`
- `rate_limit_parses_retry_after_us_body`
- `rate_limit_parses_english_retry_after_body`
- `rate_limit_body_wins_over_header`
- `rate_limit_without_hint_falls_back_to_jitter`
- `retry_loop_sleeps_for_body_hint` — end-to-end: 429 with
  `retry_after_us: 2_500_000` then 200 on retry; asserts elapsed ≥ 2.4 s.

**Checks:**

- `cargo fmt --all --check` — clean.
- `cargo clippy --all-targets -- -D warnings` — clean (default features).
- `cargo clippy --all-targets --features seed -- -D warnings` — clean
  (seed path still compiles, seed tests still green).
- `cargo test --no-fail-fast` — 23 of 24 green in `tests/client_test.rs`
  (all 7 new #11 tests pass); 4 of 5 green in `src/client.rs` lib tests.
  The 2 pre-existing failures
  (`invalid_pem_is_surfaced_as_validation_error`,
  `builder_trust_root_pem_round_trips`) are unrelated to #11 — they
  assert that reqwest's PEM parser rejects bogus bytes as
  `Error::Validation`, but reqwest's current `rustls` stack accepts the
  fake cert up to use-time. Unchanged by this fix.

**Signature impact:** none — `Error::RateLimit { retry_after_ms: u64 }`
keeps its field name so `src/seed/error.rs:87-89` (owned by the seed
fence) continues to compile without edits.

#11 is closable for the Rust SDK.

Not yet landed (explicitly out of Phase 1.5 scope, tracked for Phase 2):

- mDNS discovery (`Discovery::Mdns` — ADR-0016a §D6, Phase 1.5 opt-in
  upgrade path). **Landed 2026-04-23 — see "Phase 3 — mDNS discovery"
  below.**
- Mesh-observability resource (`client.mesh().status/peers/swarm/health`
  — ADR-0016a §D8 Phase 1 surface addendum). **Landed 2026-04-23.**
- Per-call override args (`peer:` / `prefer:` / `consistency:`) —
  requires a per-call options bag and is tracked against ADR-0016b
  §"Per-call knobs". **Landed 2026-04-23.**
- `client.rediscover()` explicit re-resolve helper. **Landed 2026-04-23.**

### Phase 3 — mDNS discovery (2026-04-23)

Closes the ADR-0016a §D6 "Phase 1.5 opt-in upgrade path" that was
deferred through Phase 2. Wires the language-agnostic `Discovery`
provider surface from ADR-0016b §"Discovery providers" into the Rust
SDK and ships an mDNS implementation behind a new `mdns` Cargo feature.

**Crate dependency:** `mdns-sd = "0.19"` (MSRV 1.71 — well under the
SDK's 1.78), `default-features = false` so the optional `async` /
`log` integrations stay out of the default build. `mdns-sd` has no
async runtime of its own — it runs a blocking background thread and
delivers `ServiceEvent`s through a `flume::Receiver`; the SDK drives
that receiver from `tokio::task::spawn_blocking` so the whole browse
composes with the crate's existing `tokio` runtime. `mdns-sd 0.19`
was chosen over the older `0.11` line referenced by the task brief
because the current crate surface is materially cleaner (`ResolvedService`
replaces the earlier `ServiceInfo`, with explicit `get_addresses()` /
`get_property_val_str()` accessors) and upstream has been actively
maintained through 2026. `simple-mdns` was considered as a fallback
but pulls in `async-std` by default, which would drag a second
runtime into the SDK's dep tree — rejected.

**Files added:**

- `src/seed/discovery/mod.rs` — `Discovery` async trait (object-safe via
  `async_trait`), `DiscoveredPeer` value struct, and the zero-dep
  `Explicit` provider that wraps `Vec<String>`. `Discovery` is
  re-exported from `src/seed/mod.rs` as part of the public surface so
  consumers can write custom providers without depending on an internal
  path.
- `src/seed/discovery/mdns.rs` — `#[cfg(feature = "mdns")] MdnsDiscovery`
  + `MdnsDiscoveryBuilder`. Fluent `service_type(...)` /
  `browse_duration(...)` / `scheme(...)` / `default_port(...)`
  overrides; defaults match the seed's advertisement
  (`_cognitum._tcp.local.`, 2 s budget, `https`, port 8443). TXT-record
  parsing consumes the `id` / `port` keys emitted by
  `seed/src/cognitum-agent/src/discovery.rs:137-180`; unknown keys are
  ignored so v0.21+ fields don't break the SDK. IPv6 addresses are
  URL-bracketed before joining scheme + port.
- `tests/seed_discovery.rs` — 6 integration tests (see below).

**Files edited:**

- `Cargo.toml` — new optional dep `async-trait = "0.1"` gated on the
  existing `seed` feature; new optional dep
  `mdns-sd = { version = "0.19", default-features = false }` gated on
  the new `mdns = ["seed", "dep:mdns-sd"]` feature. No new default
  features.
- `src/seed/mod.rs` — exports `Discovery`, `DiscoveredPeer`, `Explicit`,
  and (feature-gated) `MdnsDiscovery`. New `pub mod discovery;`.
- `src/seed/client.rs` — `SeedInner` gained
  `discovery: Option<Arc<dyn Discovery>>`. `SeedClientBuilder` grew
  `.discovery(impl Discovery + 'static)` and `.discovery_arc(Arc<dyn
  Discovery>)`. `SeedClientBuilder::build()` seeds the initial peer
  list from the provider when `.endpoints(...)` is absent — an empty
  provider result becomes an `Error::Validation` at build time rather
  than lurking until the first request. `SeedClient::rediscover()` is
  now `async fn -> Result<(), Error>`: with a provider installed it
  calls `discover()` and rebuilds the `PeerSet`; without one it falls
  back to the pure-SDK-local Phase 2 reset. An empty rebuild is
  rejected and the existing `PeerSet` is left untouched. Session pins
  that are still present in the new list survive the rebuild; pins
  that drop out quietly become dangling and the next request resolves
  through the closest-first picker (per ADR-0016a §D9). The synchronous
  builder drives the provider via a scope-spawned thread with its own
  current-thread `tokio` runtime so callers from any runtime flavour
  (including none) can `build()` without deadlock.
- `tests/seed_rediscover.rs` — migrated to the new `async` signature
  (`client.rediscover().await.expect(...)`).

**Tests added (+6 in `tests/seed_discovery.rs`):**

- `explicit_discovery_through_builder_seeds_peer_set` — `.discovery(
  Explicit::new(&[...]))` replaces `.endpoints(&[...])` and produces a
  two-peer PeerSet.
- `explicit_discovery_with_zero_peers_is_rejected_at_build` — empty list
  surfaces as `Error::Validation` with a `"zero peers"` sentinel.
- `stub_discovery_runs_on_build_and_again_on_rediscover` — asserts the
  provider's `discover()` is called exactly twice (once at build, once
  at `rediscover()`) and that the second call's result replaces the
  PeerSet.
- `stub_discovery_empty_rebuild_is_rejected_and_leaves_peers_intact` —
  empty-list rebuild via rediscovery must NOT zero out the live PeerSet.
- `stub_discovery_preserves_session_pin_when_url_still_present` — a
  `SeedSession` pinned to peer A keeps resolving when rediscovery
  returns a superset that still contains A.
- `discovery_rebuild_replaces_peer_set_entirely` — rediscovery that
  yields a disjoint list (`{A}` → `{B, C}`) fully swaps the PeerSet;
  every new peer starts `Healthy` with cleared EMA / `last_used_at`.

The mDNS-specific smoke test (`discover_on_empty_network_returns_empty_fast`)
lives inside `src/seed/discovery/mdns.rs` so it can run as a lib unit
test on a tight budget (150 ms) without requiring an integration-test
feature gate. 3 `mdns.rs` unit tests total (defaults, overrides, empty
network).

**Checks:**

- `cargo fmt --all --check` — clean.
- `cargo clippy --features seed --tests -- -D warnings` — clean.
- `cargo clippy --features seed,mdns --tests -- -D warnings` — clean.
- `cargo test --features seed --no-fail-fast` per-binary:
  seed_discovery 6/6 new, seed_rediscover 2/2 (migrated to async),
  seed_mesh 7/7, seed_mesh_resource 5/5, seed_call_options 8/8,
  seed_trust_score 5/5, seed_unit 24/24, lib 71/72 (same pre-existing
  `invalid_pem_is_surfaced_as_validation_error` failure outside scope
  per the #11 note above). Net delta: **+6 integration tests, +3 lib
  unit tests**.
- `cargo test --features seed,mdns --no-fail-fast` adds the 3 mdns unit
  tests (74/75 lib, others unchanged). The `mdns` feature build is
  verified on Linux via `cargo build --features seed,mdns`; CI matrix
  addition is tracked in §11.1.

**Signature impact:** **breaking** —
`SeedClient::rediscover()` gained an `async` qualifier and a
`Result<(), Error>` return so Phase 3 network I/O surfaces cleanly.
Every existing call site (tests + docs) was migrated in the same
change. Since the SDK is still pre-1.0 (0.2.0), this lands under the
ADR-0006 "pre-1.0 MINOR-break" clause.

**Platform notes:** `mdns-sd 0.19` has Linux / macOS / Windows support
out of the box. Build verified on Linux x86_64. On networks where
multicast is blocked (typical Docker bridge, corporate Wi-Fi) the
discover call returns `Ok(vec![])` within the configured budget — the
SDK refuses to rebuild the PeerSet from an empty response, preserving
the last-known good list. Callers that want stricter behaviour can
match on `Error::Validation` and fall back to `SeedClient::builder()
.endpoints(...)`.

#D6 is closable for the Rust SDK.

### Phase 3 — Tailscale discovery (2026-04-23)

Closes **OQ-11** (docs/adr/README.md). Adds a second `Discovery` impl
alongside `MdnsDiscovery` that reads the local tailnet and filters for
seeds.

**Files (all under `sdks/rust/`):**

- `src/seed/discovery/tailscale.rs` — `TailscaleDiscovery` +
  `PeerPredicate` trait. `Discovery::discover()` wraps the blocking
  `std::process::Command::new("tailscale").args(["status", "--json"])`
  call in `tokio::task::spawn_blocking`, so it composes with the
  SDK's tokio runtime without a dedicated async-CLI dep.
  Fluent config: `.with_prefix(...)` (default `"cognitum-"`,
  case-insensitive), `.with_port(...)` (default 8443),
  `.with_command(...)` (default `"tailscale"`), `.with_predicate(...)`.
  Parses the status JSON with `serde_json` into a small
  `TailscaleStatus { Peer, Self }` shape; unknown keys ignored.
- `src/seed/discovery/mod.rs` — `pub mod tailscale; pub use
  tailscale::TailscaleDiscovery;`. **No feature gate** — the module
  only uses `std::process` + `tokio::task::spawn_blocking` + `serde`,
  all already pulled in by the base `seed` feature.
- `src/seed/mod.rs` — top-level re-export of `TailscaleDiscovery`
  alongside `Explicit` / `MdnsDiscovery`.
- `tests/seed_discovery_tailscale.rs` — 4 `#[tokio::test]` integration
  tests (`cfg(unix)` gate because the fake CLI is a shell script):
  default prefix + URL mapping, custom port override, missing binary
  → `Error::Validation("not found on PATH")`, malformed JSON →
  `Error::Validation("failed to parse")`. Each test writes a tiny
  `/bin/sh` script to `$TMPDIR` that echoes fixture JSON and points
  `TailscaleDiscovery.with_command(...)` at it — no real `tailscale`
  binary needed. Core parsing + predicate logic also has 3 inline
  unit tests in `src/seed/discovery/tailscale.rs::tests` that run on
  all platforms (including Windows CI).

Tailnet carries no `device_id` or cert fingerprint, so
`DiscoveredPeer::device_id` and `tls_fingerprint` stay `None`; combine
with `MdnsDiscovery` if per-peer TLS pinning is required.

On Windows, `Command::new("tailscale")` resolves `tailscale.exe` via
`PATHEXT` — default config works unchanged. Override
`.with_command("C:\\Program Files\\Tailscale\\tailscale.exe")` if the
CLI lives outside `PATH`.

### fp= cert pinning (2026-04-23)

Closes the per-peer TLS cert fingerprint pinning gap that Phase 3 mDNS
discovery left open: seed adverts carry `fp=sha256:<hex>` in the TXT
record (`seed/src/cognitum-agent/src/discovery.rs`) but until now the
Rust SDK only consumed the `id` and `port` keys. The rustls handshake
fell back to `SeedTls::System` (rejects link-local self-signed) or
`SeedTls::Insecure` (accepts everything including MITM). The pinning
path is the link-local story ADR-0007 §TLS calls out — pin the handshake
to the exact end-entity cert hash the seed advertised, no trust-store
round-trip required.

**Files added:**

- `sdks/rust/src/seed/tls_pin.rs` — `FingerprintPinVerifier` implements
  `rustls::client::danger::ServerCertVerifier`. `verify_server_cert`
  computes SHA-256 of the presented end-entity DER, compares to the
  map entry for the current hostname, and either returns success or
  `rustls::Error::General("fingerprint pin mismatch for <host>")` with
  **no fallback to the inner verifier on mismatch**. Three constructors:
  `with_webpki_roots(pins)` (production `SeedTls::System` + fp map),
  `with_insecure_fallback(pins)` (dev `SeedTls::Insecure` + fp map —
  pinned peers verified strictly, unknown peers waved through), and
  `new(pins, inner)` (custom inner verifier). Lib unit tests: 7 in
  `#[cfg(test)] mod tests`, covering the empty-openssl golden
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
  hex round-trips, case-insensitive parsing, and empty-map passthrough.
- `sdks/rust/tests/seed_fp_pin.rs` — 6 integration tests driving the
  verifier end-to-end with `rcgen`-minted self-signed certs:
  `matching_fingerprint_verifies_successfully`,
  `mismatched_fingerprint_errors_without_fallback`,
  `no_fingerprint_plus_insecure_builds_as_before` (back-compat
  SeedClient build path — no fp + Insecure keeps waving everything
  through), `mixed_peers_one_matches_one_does_not` (pin set, first
  peer OK / second peer mismatch rejects / unpinned host delegates),
  `webpki_backed_verifier_constructs_cleanly`, and
  `explicit_inner_verifier_is_respected_on_fallthrough` (deny-all
  inner proves the no-pin path actually delegates).

**Files edited:**

- `sdks/rust/src/seed/discovery/mod.rs` — `DiscoveredPeer` gained
  `tls_fingerprint: Option<String>` (lowercased hex, no `sha256:`
  prefix, no colons). New fluent `with_tls_fingerprint(...)` setter and
  crate-local `normalize_fingerprint(raw)` helper so the mDNS parser and
  the verifier agree on a single canonical form.
- `sdks/rust/src/seed/discovery/mdns.rs` — `resolve_info_to_peer` now
  reads the TXT `fp` key and normalises into the new `tls_fingerprint`
  field via `set_tls_fingerprint(...)`. Two new unit tests:
  `fingerprint_normalisation_strips_prefix_and_colons` and
  `set_tls_fingerprint_round_trip_on_discovered_peer`.
- `sdks/rust/src/seed/client.rs` — `SeedClientBuilder::build` now keeps
  the full `Vec<DiscoveredPeer>` around (not just the URLs) and feeds
  it to `build_http_client`. New `build_http_client(tls, timeouts,
  discovered)` applies this precedence: **`SeedTls::Pinned(ca_pem)`
  wins** (ignores fingerprints — caller asserted a named CA); else if
  any discovered peer has a `tls_fingerprint`, install a
  `FingerprintPinVerifier` via rustls `ClientConfig` +
  `reqwest::ClientBuilder::use_preconfigured_tls`; else fall through to
  the existing `System` / `Insecure` behaviour. A mismatch on any
  pinned peer is a hard `Error::Http`/`Error::Validation` — no cycling.
  `install_rustls_verifier` lazily installs the `ring` crypto provider
  if none is set so test binaries work without a global install.
- `sdks/rust/src/seed/error.rs` — new `tls_pin(peer_host)` helper
  producing `BaseError::Validation("tls_pin: fingerprint mismatch for
  <host>")`. Stays in the existing `Error` enum per ADR-0004; a
  dedicated variant would require touching `src/error.rs` (pre-fix
  track).
- `sdks/rust/src/seed/mod.rs` — exposes the new `tls_pin` module.

**Dependencies added (justified):**

- `sha2 = "0.10"` — the SHA-256 primitive the verifier uses. Not in
  reqwest's transitive tree (verified via `cargo tree --features seed`);
  the explicit dep keeps the hash call reviewable.
- `rustls = "0.23"` — already transitively pulled by reqwest's
  `rustls-tls` feature; surfaced here so our `ServerCertVerifier` and
  reqwest see the same rustls 0.23 types. `default-features = false`.
- `webpki-roots = "1.0"` — production trust root for the `System`
  fallthrough path. Matches reqwest's own default.
- `rcgen = "0.13"` (dev only) — self-signed certs for the integration
  tests. Dev-only means it never leaks into consumer builds.

**Verification:**

- `cargo fmt --all --check` — clean.
- `cargo clippy --features "seed,mdns" --tests -- -D warnings` — clean.
- `cargo test --features seed` — `seed_fp_pin` 6 green; all other seed
  integration suites green (`seed_unit` 24, `seed_mesh` 7,
  `seed_call_options` 8, `seed_discovery` 6, `seed_mesh_resource` 5,
  `seed_rediscover` 2, `seed_trust_score` 5); lib tests 80 pass + the
  pre-existing `invalid_pem_is_surfaced_as_validation_error` /
  `builder_trust_root_pem_round_trips` cloud-path failures documented
  earlier in this ADR.
- `cargo test --features "seed,mdns"` — same integration suites green
  (lib tests 85 pass including the 8 new `tls_pin` + `mdns` additions).

**Scope boundary:** The http client is built once in `build()` from
the initial discovery snapshot. If `rediscover()` introduces new
fingerprints for peers that previously had none (or vice versa), the
pin map does not rebuild — the existing client keeps its original
verifier. This is a conscious trade-off for the 45-minute budget: a
rebuild would require wrapping `SeedInner.http` behind a lock, which
touches every call site in the request loop. Tracked for follow-up.

### Phase 2 delivery (2026-04-23)

Closes the ADR-0016a §D8 + ADR-0016b §"Per-call knobs" conformance gap
that Phase 1.5 explicitly deferred.

**Files added:**

- `src/seed/models/mesh.rs` — `MeshStatus`, `MeshPeers`, `SwarmStatus`,
  `ClusterHealth` structs. Every struct carries `#[serde(flatten)] extras:
  Extras` so v0.21+ fields deserialize without a SemVer bump. Shapes
  verified against the live seed `ad7d7e7b-56e7-4e03-b078-939209858144`
  on firmware v0.20.0 (2026-04-22 probe):
  - `/api/v1/network/mesh/status` → 200 with `{ap_active, auto_mesh,
    connected_to_seed, device_id, has_mesh_password, peer_count, peers[]}`
  - `/api/v1/peers` → 200 with `{count, discovery_active, peers[]}`
  - `/api/v1/swarm/status` → 200 with `{device_id, discovery_active,
    epoch, peer_count, total_vectors, uptime_secs}`
  - `/api/v1/cluster/health` → 200 with `{auto_sync_interval_secs,
    cluster_enabled, discovery_active, last_sync_attempt, peer_count,
    peers[]}`

  All four are allowlisted reads on v0.20.0 — **no 404/501 observed**.
  `peers[]` is modeled as `Vec<serde_json::Value>` because v0.20.0 emits
  `[]` and the per-peer sub-schema is still churning upstream.
- `src/seed/resources/mesh.rs` — `MeshResource<'_>` with `status`,
  `peers`, `swarm_status`, `cluster_health` methods plus their
  `_with(opts: CallOptions)` twins. Registered in `resources/mod.rs`.
  Exposed via `SeedClient::mesh()`.

**Files edited:**

- `src/seed/config.rs` — new `CallOptions` struct (non-exhaustive, every
  field `Option<_>` so `default()` is a true no-op), `Prefer` enum
  (`Closest`/`LocalFirst`/`Random`/`Any`), `Consistency` enum
  (`Session`/`Eventual`/`Strong`). Fluent builder methods on
  `CallOptions` (`.peer()`, `.prefer()`, `.consistency()`, `.timeout()`,
  `.retries()`).
- `src/seed/error.rs` — new helpers `seed_err::unsupported(reason)` and
  `seed_err::config(reason)`. Both return `Error::Validation(...)` with
  sentinel prefixes (`unsupported:` / `config:`) so callers can
  pattern-match without a crate-private API.
- `src/seed/peers.rs` — `PeerSet::pick_local_first()`,
  `PeerSet::pick_random()` (nanosecond-hash, no `rand` dep), and
  `PeerSet::rediscover()` (reset every peer to `Healthy` with cleared
  EMA and counters).
- `src/seed/client.rs` — `SeedClient::mesh()` / `SeedClient::rediscover()`
  accessors. `SeedClient::status_with(opts)` / `identity_with(opts)`.
  Private `request_get_opts` / `request_post_opts` helpers that route
  through a new `resolve_call_options()` which enforces the
  `Consistency::Strong` reject, validates `opts.peer` against the
  `PeerSet`, and translates `opts.prefer` into the right per-call pin.
  **No behavioural change when `CallOptions::default()` is passed** — the
  helpers fall through to the existing request loop untouched.
- `src/seed/resources/{pair,store,witness,custody,ota}.rs` — every
  existing method grew a `_with(opts)` twin so per-call overrides are
  uniformly available across all resources. The `_with` flavours delegate
  to `request_get_opts` / `request_post_opts`.
- `src/seed/mod.rs` — new re-exports: `CallOptions`, `Consistency`,
  `Prefer`, `MeshStatus`, `MeshPeers`, `SwarmStatus`, `ClusterHealth`.

**Tests added (+15 in 3 new files):**

- `tests/seed_mesh_resource.rs` (5 tests) — one per endpoint plus an
  `extras`-capture forward-compat check. Live JSON is pasted verbatim
  into the wiremock bodies.
- `tests/seed_call_options.rs` (8 tests) — peer pin (healthy + unknown
  URL rejected with `config: peer not in mesh: …`), all four `Prefer`
  variants, `Consistency::Strong` rejected with `unsupported:` and **zero
  HTTP calls made**, `Consistency::Eventual` still routes,
  `CallOptions::default()` matches plain call byte-for-byte.
- `tests/seed_rediscover.rs` (2 tests) — drive peer A `Unhealthy` via a
  500 cycle then assert `rediscover()` clears the EMA + state on every
  peer; second test asserts idempotency on a fresh client.

Split out of `tests/seed_mesh.rs` (439 → 439 lines, unchanged) because
adding the 8 call-options tests inline would push that file past the
500-line project cap.

**Checks:**

- `cargo fmt --all --check` — clean.
- `cargo clippy --features seed --tests -- -D warnings` — clean.
- `cargo test --features seed` per-test: seed_mesh_resource 5/5,
  seed_call_options 8/8, seed_rediscover 2/2; pre-existing suites
  unchanged (seed_mesh 7/7, seed_unit 24/24, seed_trust_score 5/5).
  Net delta: **+15 tests**. The 2 pre-existing cloud PEM failures
  (`invalid_pem_is_surfaced_as_validation_error`,
  `builder_trust_root_pem_round_trips`) are still out of scope per the
  #11 note above.

**Signature impact:** none; every `_with(...)` method is additive and
`CallOptions` is `#[non_exhaustive]`. The existing parameterless method
twins remain and route through the unmodified fast path.

Endpoints that 404 / 501 on v0.20.0: **none of the four** — every
ADR-0016a §D8 endpoint returns 200 with a live JSON body on the current
firmware.

### MCP stdio parity (OQ-4, 2026-04-23)

Closes the Rust portion of cross-cutting **OQ-4** (MCP stdio parity with
Node's `createStdioTransport`). Before this change the Rust SDK only
spoke MCP over the cloud HTTP endpoint (`POST /mcpSse`); callers who
wanted to run a local MCP subprocess server had no path. Node shipped
both transports at 0.1.0 via `sdks/node/src/mcp-stdio.ts` — Rust now
matches.

**Files added:**

- `src/mcp/transport.rs` — `Transport` async trait (object-safe via
  `async_trait`), shared `JsonRpcMessage` / `JsonRpcError` serde types,
  and a transport-layer `McpError` with a `From<McpError> for
  crate::Error` bridge. `JsonRpcMessage` keeps the spec fields separate
  (`id`, `method`, `params`, `result`, `error`) and uses
  `#[serde(skip_serializing_if = "Option::is_none")]` so the wire form
  matches Node/Python byte-for-byte.
- `src/mcp/http.rs` — `HttpTransport` (request/response JSON-RPC over
  reqwest, `X-API-Key` auth). This is the baseline transport that
  mirrors the existing cloud code path; it is additive — the existing
  `McpResource` continues to ride the `Client` HTTP surface directly.
- `src/mcp/stdio.rs` — **new**: `StdioTransport` +
  `StdioTransportBuilder` (fluent `.command()` / `.args()` / `.env()` /
  `.cwd()` / `.inherit_env()`). Uses `tokio::process::Command` with
  `stdin/stdout/stderr = Stdio::piped()` and `kill_on_drop(true)`.
  Framing is newline-delimited JSON via `BufReader::read_line` on the
  child's stdout. Stderr is drained on a dedicated `tokio::spawn` task
  (prefixed with `[mcp-stdio]`) so a chatty child can't back-pressure
  the main pipe. `close()` drops stdin, waits up to 5 s for graceful
  exit (`CLOSE_GRACE`), then force-kills.
- `src/mcp/client.rs` — `McpClient` that owns a `Box<dyn Transport +
  Send + Sync>`. Auto-increments `id` via `AtomicU64`, correlates
  request/response by id, exposes `initialize()` / `list_tools()` /
  `call_tool()` / `notify()` / `close()`.
- `src/mcp/mod.rs` — wires the sub-modules, splits the old
  monolithic `src/mcp.rs` (kept as `src/mcp/resource.rs`, untouched).
  `pub use`: `McpClient`, `HttpTransport`, `StdioTransport`,
  `StdioTransportBuilder`, `Transport`, `JsonRpcMessage`,
  `JsonRpcError`, `McpError`, plus the pre-existing `McpResource`
  and `InitializeResponse`.
- `tests/mcp_stdio.rs` — 5 integration tests (see below).

**Files edited:**

- `Cargo.toml` — added `process` + `io-util` to tokio's feature list
  (previously `time`, `macros` only); lifted `async-trait` out of the
  optional / `seed`-gated slot so the cloud-only default build can
  expose `mcp::Transport` without forcing `seed` on. `seed` feature
  stripped of its `dep:async-trait` dependency (now unconditional).
  No new crate pulled in — `async-trait 0.1` was already in the
  `seed` build since Phase 3 (mDNS).

**Tests added (5 in `tests/mcp_stdio.rs`):**

- `transport_send_recv_round_trip` — spawns a `sh` echo shim, sends a
  JSON-RPC request, verifies the response shape and method name.
- `close_kills_subprocess_cleanly` — spawns `cat`, round-trips a
  notification, asserts `close()` returns under the 5 s budget and
  `pid()` reports `None` after.
- `stderr_drain_does_not_block_send` — child spams 4096 lines to
  stderr before reading stdin. Without the drain task the ~64 KB
  stderr pipe buffer would wedge the child and `recv()` would time
  out; this pins the drain invariant.
- `mcp_client_request_returns_rpc_error_on_server_error` — child
  always returns a JSON-RPC `error` object (`code: -32601`); asserts
  `McpClient::request()` surfaces it as `McpError::Rpc { code: -32601,
  message }`.
- `builder_requires_command` — `StdioTransport::builder().spawn()`
  with no command set returns a deterministic
  `McpError::Other("StdioTransport: command not set")` rather than
  panicking.

All 5 tests gate on `sh` being on PATH (skipped with an `eprintln!`
breadcrumb otherwise) so the suite stays green on minimal Windows
CI runners.

**Checks:**

- `cargo fmt --all --check` — clean.
- `cargo clippy --all-targets -- -D warnings` — clean (default
  features).
- `cargo clippy --all-targets --features seed -- -D warnings` — clean.
- `cargo test --no-fail-fast` — `mcp_stdio` 5/5 new; pre-existing
  suites unchanged. The same 2 pre-existing cloud-side PEM failures
  (`invalid_pem_is_surfaced_as_validation_error`,
  `builder_trust_root_pem_round_trips`) remain outside scope per the
  ADR-0014 fencing rule (do not touch `src/client.rs` or
  `src/error.rs`).

**Signature impact:** fully additive at the public-API level. The
existing `McpResource` is re-exported verbatim from the new
`src/mcp/mod.rs` (it moved to `src/mcp/resource.rs`), so
`client.mcp().list_tools()` / `call_tool()` / `search_docs()` /
`initialize()` call sites compile without edits. The new
`McpClient` + transports are additive surface.

**OQ-4 status:** Rust portion closed. Python parity is tracked in
parallel; `docs/adr/README.md` flips OQ-4 to fully Answered once
Python lands.

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

<!-- swarm-seed-validation 2026-04-22: every row below confirmed `(assumed)` / `failing` in 0.1.0. Tracking issues: cognitum-one/sdks#10 (Bearer→X-API-Key), #3 (error.rs rewrite + NotImplemented), ✅ #11 RateLimit default — cloud path compliant 2026-04-23 (src/client.rs parses Retry-After seconds + HTTP-date + body retry_after_us + english; Error::RateLimit.retry_after_ms populated from parsed value with ADR-0005 equal-jitter fallback). -->

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
- **OQ-4** (ADR-0010) — MCP stdio parity — **Answered 2026-04-23**,
  landed via `src/mcp/transport.rs` + `src/mcp/stdio.rs` (`Transport`
  trait, `HttpTransport`, `StdioTransport::builder()`, `McpClient`).
  See §"MCP stdio parity (OQ-4, 2026-04-23)" above; 5 green integration
  tests in `tests/mcp_stdio.rs`.
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
