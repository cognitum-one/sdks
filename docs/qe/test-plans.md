# Test Plans — per SDK

Derived from `test-strategy.md`. Each plan is a checklist of scripted tests that MUST exist or be extended in 0.3.0, with file targets, owning risks, and a pass/fail bar.

## Common (runs across all 3 SDKs)

### Contract fixture suite (S1)

- **New dir:** `docs/adr/contract-tests/`
- Fixture file format: YAML describing inputs + expected outcomes. One fixture per behaviour.
- Per-SDK harness at `sdks/{node,python,rust}/tests/contract/` loads and runs.
- Initial fixture set (required, one per row):

| Fixture | Asserts | Risk |
|---|---|---|
| `callopts-prefer-closest` | request order matches closest-first EMA regardless of list order | R4 |
| `callopts-prefer-random` | 100 invocations produce ≥ 3 unique first-peer selections | R4 |
| `callopts-prefer-local-first` | peers with RFC1918 / link-local IPs selected first | R13 |
| `callopts-peer-override` | `opts.peer="X"` pins request to X; error if X absent | — |
| `callopts-consistency-session` | 2nd request sticks to peer chosen by 1st | R4 |
| `retry-after-header-vs-body` | `retry_after_us` body wins when both present | — (spec) |
| `retry-post-no-auto` | POST without `idempotent: true` does NOT retry on network error | — |
| `retry-wall-clock-ceiling` | total elapsed ≤ 60s regardless of attempt count | R11 |
| `retry-equal-jitter-bounds` | 1000 samples: min ≥ base/2 * 2^attempt, max ≤ cap | — |
| `mesh-failover-5xx` | 5xx on peer A cycles to peer B same request | — |
| `mesh-failover-429-pin` | 429 pins peer A (no cycle on next req w/in Retry-After) | — |
| `secretstring-redact-roundtrip` | print / repr / toJSON / Debug all redact raw value | R5 |
| `secretstring-serialize-contract` | each SDK documents whether JSON serialize leaks or not; test pins behaviour | R5 |
| `trust-score-3strike-sequential` | 3rd consecutive 401 blocks w/ TrustScoreBlockedError | R6 |
| `trust-score-2xx-resets` | 2xx between 401s resets counter | — |
| `tls-pin-fp-mismatch` | fingerprint mismatch on TXT → TlsPinError, never insecure fallback | R1, R2 |
| `tls-pin-short-fp` | fp < 64 hex chars → reject, don't accept partial | R1 |
| `tls-pin-malformed-txt` | garbage TXT record → reject without crash | — |
| `env-api-key-fallback` | `COGNITUM_API_KEY` env used when arg omitted | R8 |
| `env-seed-token-fallback` | `COGNITUM_SEED_TOKEN` env used when arg omitted | R8 |
| `env-explicit-wins` | constructor arg wins over env | — |

### Documentation linter (S5)

- **New file:** `scripts/doc-conformance.{js,py,sh}`
- Walks README.md and `docs/adr/*.md`, extracts endpoint claims + env var names, greps source tree, asserts each exists.
- **Fail conditions:** claimed endpoint not in `sdks/*/src/seed/resources/`; env var named in docs not read anywhere in source.
- Wired into `.github/workflows/ci.yml` as `docs-conformance` job.

### Cross-SDK live matrix (S7)

- **Existing:** 30/30 Phase 2+3 scenarios against a live seed.
- **0.3.0 extension:** add 3 criticals regression scenarios — C1 (Node fp spoof), C2 (Python TOCTOU), C3 (Python cognitum.local) as negative tests that MUST produce TlsPinError on live seed.

---

## Node SDK (`sdks/node/`)

### New unit tests

- `tests/seed/unit/fp-pin-length.test.ts` — fp length floor (**R1**)
  - `startsWith` with 2-char fp → reject
  - non-hex chars → reject
  - 64 lowercase hex → accept
  - 64 uppercase hex → accept (case-insensitive)
- `tests/seed/unit/trust-score-race.test.ts` — concurrent 401s (**R6**)
  - Promise.all 16 requests returning 401. Exactly 3 of them reach the network; the rest short-circuit with `TrustScoreBlockedError`.
- `tests/seed/unit/health-probe-latency.test.ts` — EMA not poisoned (**R12**, perf F14)
  - Mock seed responds in 10ms. Probe `markSuccess` called with value ≤ 50ms, not `probeTimeout`.
- `tests/seed/unit/preferorder-local-first.test.ts` — local-first classification (**R13**)
  - RFC1918 / link-local / loopback hosts rank before public IPs
  - Contract table against Python + Rust implementations of the same fixture
- `tests/seed/unit/cli-version.test.ts` — CLI reports package.json version (qx-sfdipot DX finding)

### New integration tests

- `tests/seed/integration/tailscale-prefix-exact.test.ts` (**R7**)
  - Mock `tailscale status --json` output with `cognitum-evil` and `cognitum-prod-01`. Only `cognitum-*` prefix-matches; not substring.
- `tests/seed/integration/insecure-warn-every-request.test.ts` (qx-sfdipot)
  - `tls: { insecure: true }` logs a warning on N=10 requests, not only on the first.

### New property tests (fast-check)

- `tests/seed/property/retry-loop.test.ts`
  - Generator: sequence of response codes (200/400/401/429/500/502/503/timeout), random peer count, `idempotent` boolean.
  - Asserts: wall-clock ≤ 60s; attempt count ≤ N×retries; 429 pins; 401x3 blocks.

### Benchmarks to add (F20)

- `bench/post-ingest.ts` — POST body path with 8KB fixture.
- `bench/retry-cycle.ts` — 503→200 retry latency.
- `bench/peerset-prefer.ts` — `preferOrder('local-first')` cost vs `'closest'` vs `'any'`.
- `bench/baseline.json` — committed numbers; CI compares.

### Pass/fail bar

- `npm test -- --run` → 0 fail (was 201/1 pre-existing).
- `npm run typecheck` → 0 error.
- `npm run lint` → 0 error.
- `npm run bench:status -- --compare baseline.json` → within 1.3× on p50.

---

## Python SDK (`sdks/python/`)

### New unit tests

- `tests/seed/unit/test_prefer_routing.py` — `CallOptions.prefer` actually affects order (**R4** — currently ignored)
  - Parameterised over all 4 `prefer` modes; asserts selection changes with mode.
  - Fails today — confirms the bug before the fix lands.
- `tests/seed/unit/test_tls_pin_toctou.py` — pinning uses the actual request's cert (**R2**)
  - MITM fixture: TLS handshake #1 returns real cert; handshake #2 returns forged. After verify → request, assert request fails with `TlsPinError`.
- `tests/seed/unit/test_transport_no_silent_insecure.py` — `cognitum.local` / 169.254.* don't bypass (**R3**)
  - Each target host: `verify_mode != CERT_NONE` unless `insecure=True` explicitly set.
- `tests/seed/unit/test_env_resolution.py` — env vars actually read (**R8**)
  - `COGNITUM_API_KEY=x` → header `X-API-Key: x` on first request.
  - `COGNITUM_SEED_TOKEN=y` → `X-Pairing-Token: y`.
  - Currently fails — confirms bug.
- `tests/seed/unit/test_retry_deadline_guard.py` — retry sleep respects deadline (**R11**, F16)
  - Mock 429 with `Retry-After: 45`, `timeouts.total=10`. Raises `TimeoutError` without sleeping 45s.
- `tests/seed/unit/test_store_ingest_typed.py` — return type is typed model not dict (code-quality finding)
  - Currently returns `dict[str, Any]`; test asserts isinstance check against `StoreIngestResponse`.

### New property tests (hypothesis)

- `tests/seed/property/test_mesh_failover.py` — same generators as Node's; shared fixture format.

### Async parity

- `tests/seed/async/test_async_client_parity.py` — for each sync API, assert async equivalent exists and returns same-shaped result.
  - Catches the `_async_client.py` diverging from `_client.py` (currently ~95% dup).

### Benchmarks to add

- `tests/seed/bench/test_bench_ingest.py` — POST body bench (F20 #1).
- `tests/seed/bench/test_bench_peerset.py` — `find_by_key` under 5, 20, 100 peers (F8).
- `tests/seed/bench/test_bench_cold_import.py` — assert import time < 30 ms (guards PEP 562 claim).
- Add `pytest-benchmark` to `[dev]` in `pyproject.toml` (F19).
- `tests/seed/bench/baseline.json` — committed.

### Pass/fail bar

- `pytest -x` → 0 fail (was 274/3 skip).
- `mypy --strict cognitum/` → 0 error on the core path; known-Any boundaries documented.
- `ruff check` → 0 error.
- `pytest --benchmark-compare=baseline.json --benchmark-compare-fail=mean:30%` → green.

---

## Rust SDK (`sdks/rust/`)

### New unit tests

- `tests/seed_secret_string_serde.rs` — SecretString::Serialize contract (**R5**)
  - `serde_json::to_string(&secret)` → document whether it leaks or redacts. If leak is intentional for `PairCreateResponse` round-trip, introduce a separate wrapper type; test pins each wrapper's serialize behaviour.
- `tests/seed_error_taxonomy.rs` — ADR-0004 variants exist at crate root (**R10**)
  - `match` on `TlsPin`, `TrustScoreBlocked`, `NotImplemented`, `Conflict`, `ServiceUnavailable`, `Timeout`, `Parse` — compiles without fallthrough to `Validation(_)` / `Auth(_)`.
- `tests/seed_pair_delete_callopts.rs` — `pair.delete()` accepts `CallOptions` (**R14**)
  - `client.pair().delete(opts)` compiles with full CallOptions struct.
- `tests/seed_pick_random_uniform.rs` — modulo bias (**R17**, F17)
  - 10_000 samples, N=7 peers. Chi-squared test against uniform. Current nano-modulo fails; after `jitter_ms` reuse, passes.
- `tests/seed_retry_after_http_date.rs` — HTTP-date `Retry-After` parser (**code-quality**, `retry.rs:182-196`)
  - `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT` → parsed to duration.
- `tests/seed_client_no_panic_on_poisoned_lock.rs` — (code-quality, `client.rs:203,215,925`)
  - Simulate `PeerSet` poisoned → `Err(...)` not `panic!`.
- `tests/seed_env_resolution.rs` — env var fallback (**R8**)
  - Same contract as Python, Node.

### Benchmarks to add

- `benches/seed_bench.rs` — register as `[[bench]]` in `Cargo.toml` (F18).
- New criterion groups:
  - `serialize_once` — asserts body is serialized once across retry cycle.
  - `pick_closest_first` — PeerSet selection under 3, 10, 30 peers.
  - `retry_cycle` — end-to-end retry under 503→200.
  - `endpoint_key` — asserts `key()` allocation-free (F1 when fixed).
- `benches/baseline.criterion/` — committed; CI compares.

### Feature-gate compilation test

- `.github/workflows/feature-matrix.yml` — build matrix over `--features` combinations:
  - default (empty)
  - `--features seed`
  - `--features seed,mdns`
  - `--features seed,tailscale`
  - `--features seed,mdns,tailscale`
- Assertion: each builds; `cargo doc` succeeds per combo.

### Pass/fail bar

- `cargo test --all-features` → 0 fail.
- `cargo clippy --all-targets --all-features -- -D warnings` → 0 warning.
- `cargo bench --bench seed_bench` → within 1.3× of baseline.
- `cargo doc --no-deps` → 0 warning (currently doc comments reference removed variants).

---

## Test data & fixtures

- Shared fixture bank under `docs/adr/contract-tests/fixtures/` — YAML format, language-agnostic.
- Per-peer mock seeds: `tests/fixtures/mock-seed/` run a stubbed seed implementation (separate mini-crate / package) usable from all three SDKs' integration tests. Avoids each SDK inventing a different mock shape.
- No real API keys, pairing tokens, or CA material in test fixtures. All placeholder (`test-key-xxx`, `test-fp-<hex>`). The SAST false-positive allowlist at `.security-allowlist.yaml` declares these.

## Out of scope for 0.3.0

- Windows CI (none of the three SDKs currently guarantee Windows).
- WASM target for Rust.
- Python 3.9 support (drop confirmed in 0.2.0).
- Kubernetes operator integration tests.
