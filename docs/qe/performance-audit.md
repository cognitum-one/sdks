# Performance Audit — Cognitum SDKs v0.2.0

Scope: `sdks/{node,python,rust}` at this repo. Hot-path code read directly; no runtime measurement. Severity bands: high / medium / low / info. v0.2.0 fix claims are verified in-place and not re-listed as findings.

## Fix-claim verification

| Claim | Verdict | Evidence |
|---|---|---|
| Node: cached `undici.Agent` + no per-call header alloc → ~50% hot-path reduction | **True** for TLS-default case | `buildSeedFetch` returns `globalThis.fetch` verbatim when no insecure/ca/fetchFn (`node/src/seed/transport.ts:66-68`). Dispatcher built once in constructor; headers built as plain object literal (`client.ts:724-733`), not via `new Headers()`. |
| Python: PEP 562 lazy `__getattr__` reclaims ~12 ms cold start | **True, well contained** | `cognitum/__init__.py:47-104` table-driven, caches into `globals()`. `cognitum.seed.__init__` still eagerly loads its submodule graph — correct, since `from cognitum.seed import …` bypasses the cloud graph regardless. |
| Rust: xorshift64* replaces `SystemTime.nanos`; serialize-once gives 3.01× | **Both true** | `retry.rs:44-95` — atomic state + Marsaglia xorshift64 + rejection sampling; tests at `retry.rs:293-343` lock the claim. Serialize-once: `client.rs:475-478` calls `serde_json::to_vec(b)` **outside** retry loop; regression test `client.rs:1202-1269` uses a counting Serialize impl. |

**Nit (info):** `jitter_ms` (`retry.rs:77-95`) stores advanced state back into the atomic inside the rejection loop; concurrent callers can overwrite each other's state, losing one draw's advancement. Distribution stays uniform. CAS-style `fetch_update` if contention ever appears.

---

## Findings

### F1 — Rust `Endpoint::key()` allocates per call (high-frequency path)
- **Severity:** medium
- **File:** `rust/src/seed/peers.rs:67-70`; call sites `client.rs:204, 392, 412-414, 488, 927-928`, `peers.rs:236, 336`
- `key()` is `self.url.as_str().trim_end_matches('/').to_owned()` — fresh `String` every call. Inside request loop (`client.rs:488 let peer_key = peer.key();`) this fires every attempt. `find_by_key` iterates with an allocation per peer.
- **Fix:** precompute canonical key on `Endpoint` at parse time; `key(&self) -> &str`. Mirrors Node's precomputed `Peer.key` (`node/src/seed/peers.ts:46, 87-98`).

### F2 — Rust `PeerSet::find_by_key` / `peer_mut` are linear over owned strings
- **Severity:** low at N≤5, medium at N>10
- **File:** `rust/src/seed/peers.rs:235-237, 335-337`
- Same root cause as F1; the allocation cost dominates the O(N) cost at current mesh sizes.
- **Fix:** fold with F1; optionally maintain `HashMap<String, usize>` index.

### F3 — Node `PeerSet.findByKey` / `peerMut` re-normalise URL every call
- **Severity:** medium
- **File:** `node/src/seed/peers.ts:201-204, 294-297`
- `normaliseBaseUrl(peerKey)` runs `new URL(raw)` + regex-replace on every call (~2-5 μs on V8). Triggered by `SeedClient.request` validating `opts.peer`, `session()`, `rediscover()`.
- **Fix:** strict `===` fast-path against canonical key; normalisation only on miss, or require canonical keys at `opts.peer` ingress.

### F4 — Node `PeerSet.preferOrder` allocates + sorts on EVERY call when `prefer` is set
- **Severity:** medium
- **File:** `node/src/seed/peers.ts:232-256`, called from `client.ts:492-495`
- `this.peers.slice()` + `.sort(...)` per call. For `"local-first"` two filters + two sorts. Result discarded after one request.
- **Fix:** for `"closest"`/`"any"` inline pick/nextAfter into the failover loop. For `"random"`/`"local-first"` keep a cached ordered list, invalidate when a peer's rank actually flips. Don't rebuild on every EMA tweak.

### F5 — Node `isLocalHost` constructs `new URL(...)` per peer per call
- **Severity:** medium
- **File:** `node/src/seed/peers.ts:326-346`
- `new URL(peer.baseUrl).hostname.toLowerCase()` runs on every peer evaluation even though `baseUrl` is already normalised.
- **Fix:** compute `hostLower` / `isLocal` once on `Peer` at construction.

### F6 — Node session-per-call allocates a new bound closure + object spread
- **Severity:** low
- **File:** `node/src/seed/session.ts:60-77`
- `req` closure allocates `{...(opts ?? {}), pinnedPeerKey}` per resource call — one per call, not once per session.
- **Fix:** `Object.assign({}, opts, { pinnedPeerKey })` or add `pinnedPeerKey` as a separate `SeedRequestOptions` field so no merge is needed.

### F7 — Node `resources/*.ts` spread `opts` on every call
- **Severity:** low
- **File:** `node/src/seed/resources/status.ts:35-39` and peers
- `{ idempotent: true, ...(opts ?? {}) }` runs on every call; default case pays a cost only the decorated case needs.
- **Fix:** branch on `opts === undefined`, pass frozen default in common case; thread `idempotent` as a separate param for GET-only resources.

### F8 — Python `PeerSet.find_by_key` — generator allocation + O(N) under `threading.Lock`
- **Severity:** medium
- **File:** `python/cognitum/seed/_peers.py:126-128`
- `next((p for p in self.peers if p.key() == wanted_key), None)` — generator frame per call, `p.key()` rstrips per peer. Wrapped by `_SyncTransport` under `threading.Lock` (`_client.py:225-238`) — the O(N) scan is serialised.
- **Fix:** precompute `_key` on `Peer.__init__`, maintain `self._by_key: dict[str, Peer]` in `PeerSet`. O(1) lookup, lock not held for the scan.

### F9 — Python holds `_peers_lock` across `time.monotonic()` in request hot path
- **Severity:** low
- **File:** `python/cognitum/seed/_client.py:240-246`
- Not a correctness issue (lock not held across `await`); lock contention under concurrent requests is the real cost. Covered by F8.

### F10 — Python `resolve_call_options` acquires peer lock even when nothing changes
- **Severity:** low
- **File:** `python/cognitum/seed/_call_options.py:117-177`, call site `_client.py:265-271`
- Early-return at line 135 skips when `options is None`. But the `with peers_lock:` at line 149 fires whenever `options.peer` is set, regardless of whether a resolution is actually needed.
- **Fix:** skip lock when `options.peer is None and options.prefer is None`. Secondary win after F8 lands.

### F11 — Python sync health probe sequentialises peers (blocking httpx)
- **Severity:** low
- **File:** `python/cognitum/seed/_health.py:65-91`
- Sequential `for url, _host in targets: self._http.get(...)`. 3 peers × 50ms = 150ms per tick. Node parallelises via `Promise.all`; Rust is also sequential (`rust/src/seed/health.rs:88`).
- **Fix:** `ThreadPoolExecutor(max_workers=N)` for sync probe; `asyncio.gather` for async variant (line 120-136). Matters when mesh grows beyond current single-digit sizes.

### F12 — Python MdnsDiscovery waits the full timeout even when peers arrive early
- **Severity:** low (cold-path)
- **File:** `python/cognitum/seed/discovery/mdns.py:178-225`
- `done = threading.Event()` created but never `.set()`. `done.wait(self._timeout_s)` always waits the full 2s. Node same pattern (`discovery/mdns.ts:181`). Rust uses mdns-sd's channel with explicit budget — documented.
- **Fix:** set the event when peer announcements stabilise (e.g. 200ms silence).

### F13 — Tailscale discovery shells out without caching
- **Severity:** medium (Python), low (Node)
- **Files:** `python/cognitum/seed/discovery/tailscale.py:160-205`; `node/src/seed/discovery/tailscale.ts:193-229`
- Subprocess spawn (~3-10ms on macOS/Linux) + JSON parse of whole tailnet per `discover()` call. No caching, no TTL, no coalescing.
- **Fix:** TTL cache (e.g. 5s) keyed on `(command, prefix)` inside `TailscaleDiscovery`. Configurable; invalidate on `close()`.

### F14 — Node health probe feeds `probeTimeout` to EMA on success (correctness)
- **Severity:** low (correctness smell, pollutes routing)
- **File:** `node/src/seed/health.ts:87` — `peers.markSuccess(p.key, probeTimeout);`
- Probe passes configured max timeout as observed latency. Rust and Python both measure actual elapsed (`rust/src/seed/health.rs:89 started.elapsed()`; `python/_health.py:75-80`). Node's EMA drifts toward `probeTimeout` on every successful probe, masking real degradation.
- **Fix:** measure probe's actual elapsed time. Single-line diff.

### F15 — Node retry has two backoff implementations
- **Severity:** info
- **Files:** `node/src/seed/retry.ts:79-91` (`runWithRetry`) + `node/src/seed/client.ts:705-713` (`backoffDelay`)
- Equal-jitter in both, clamp order differs. Result is equivalent but duplicates the rule.
- **Fix:** extract `computeEqualJitterDelay(attempt, hintMs)` pure function; both call it. Confirm `runWithRetry` is still used externally before removing.

### F16 — Python retry sleeps past the deadline (correctness)
- **Severity:** medium
- **File:** `python/cognitum/seed/_client.py:428-445`
- Rust and Node guard the sleep duration against the deadline before sleeping (`rust/client.rs:557, 588`; `node/client.ts:633, 659`). Python only checks `time.monotonic() >= deadline` AFTER sleeping. A 429 with a large `Retry-After` can sleep past the budget, wasting up to 30s for a request that was already doomed.
- **Fix:** gate sleep on `time.monotonic() + delay/1000.0 > deadline`; shorten delay to remaining budget or raise `TimeoutError` immediately.

### F17 — Rust `PeerSet::pick_random` uses modulo-biased nanos (contradicts retry.rs fix)
- **Severity:** low (but embarrassing)
- **File:** `rust/src/seed/peers.rs:253-266`
- `let seed = Instant::now().elapsed().subsec_nanos() as usize; let idx = seed % candidates.len();` — exact anti-pattern `retry.rs::jitter_ms` was written to fix. Also, two calls within same nanosecond return identical values.
- **Fix:** reuse `retry.rs::jitter_ms(candidates.len() as u64) as usize`. One-line reuse, zero new deps.

### F18 — Rust bench not registered as a Cargo `[[bench]]` target
- **Severity:** low (tooling)
- **File:** `rust/benches/seed_bench.rs:18-19` (TODO marker), `rust/Cargo.toml` has no `[[bench]]` / `[[example]]`
- `cargo bench --bench seed_bench` fails; `cargo run --example seed_bench` fails. Only runs via `cargo test --test seed_bench` or manual wiring.
- **Fix:** add `[[bench]] name = "seed_bench" harness = false` (or criterion later).

### F19 — Python bench requires unlisted dep, not in dev group, not in CI
- **Severity:** low
- **File:** `python/tests/seed/bench/test_bench_status.py:67-72, 14-17`
- `pytest-benchmark` not in `pyproject.toml [dev]`. `HAS_BENCH = False` skips both tests by default.
- **Fix:** add to `[project.optional-dependencies].dev`; CI job to run the CLI path on every PR.

### F20 — Benchmark coverage gaps (all three SDKs)
- **Severity:** medium (for a perf-forward release)
- **Covered today:** `client.status()` vs raw HTTP p50 micro-bench. One GET, no retry, no mesh, no body.
- **Missing:**
  1. POST hot path — `store.ingest` / `store.query` with realistic (4-16 KB) JSON body (guards the serialize-once fix under cycling).
  2. Retry loop per-attempt — 503→200 mock cycle.
  3. PeerSet micro-benches — `pick`, `nextAfter`, `preferOrder` (catches F1/F2/F4/F8 regressions).
  4. `PeerSet.markSuccess/markFailure` under contention (sync Python: proves F8 matters).
  5. Discovery parse+filter with 100+ peer fixture (catches F13 regressions).
  6. Python cold-start bound: assert import time under N ms so PEP 562 gain isn't silently undone.
  7. Header/URL construction micro-bench (Node `buildUrl` at `client.ts:850-866`, Rust `Endpoint::join_api`).

### F21 — No committed baselines, no regression detection
- **Severity:** medium (release hygiene)
- No `bench/baseline.*` anywhere. No CI step compares. 3.01× and 50% claims reproducible by hand only.
- **Fix:** commit `benches/baseline.criterion/` (or plain `baseline.json` with p50 numbers). Add `ci-bench.yml` that fails if overhead exceeds baseline × 1.3. Start lenient, tighten as signal stabilises.

### F22 — Python bench uses `MockTransport` — skips TLS/pool path
- **Severity:** info
- **File:** `python/tests/seed/bench/test_bench_status.py:53-57`
- Isolates SDK overhead; doesn't catch regressions in `build_sync_client`'s verify/pool tuning (e.g. someone knocks `max_keepalive_connections` down).
- **Fix:** keep MockTransport bench for SDK overhead; add a loopback httpx-ASGI bench for full path. Node already uses a real loopback server.

### F23 — Python `PinVerifier.verify` opens a second TLS socket per new peer
- **Severity:** low (documented trade-off, but see security audit C2)
- **File:** `python/cognitum/seed/_transport.py:254-349`
- Docstring (`282-288`) acknowledges "one extra handshake per peer at first use". First request to pinned peer pays two handshakes. Rust solves this in its rustls verifier; Node via undici `checkServerIdentity`.
- **NOTE:** the security audit flags this same pattern as a critical TOCTOU (C2). Fix for correctness drives fix for perf too.

### F24 — Rust health probe doesn't drain response body
- **Severity:** info
- **File:** `rust/src/seed/health.rs:90-94`
- `http.get(url).send().await` never reads body. reqwest holds the connection until body consumed or Response dropped. Node drains via `res.text()` (`node/src/seed/health.ts:94-98`).
- **Fix:** `let _ = resp.bytes().await;` or explicit drop before `markSuccess/Failure`.

---

## Allocation hotspots

| SDK | Where | What | Per-call? | Ref |
|---|---|---|---|---|
| Node | `resources/*.ts` | `{ idempotent: true, ...opts }` | yes | F7 |
| Node | `session.ts:70-77` | bound closure + spread | yes | F6 |
| Node | `peers.ts preferOrder` | `.slice() + .sort()` | when `prefer:` set | F4 |
| Node | `peers.ts isLocalHost` | `new URL(...)` × N | on local-first | F5 |
| Rust | `peers.rs key()` | `String::to_owned()` | multiple per call | F1, F2 |
| Rust | `client.rs:488` | `peer_key = peer.key()` | inside retry loop | F1 |
| Rust | `client.rs:507` | `body_bytes.as_ref().clone()` | once per attempt (intentional per serialize-once) | — |
| Python | `_peers.py key()` | `.rstrip('/')` per comparison | inside `find_by_key` loop | F8 |
| Python | `_call_options.py 117-177` | `ResolvedCallOptions` dataclass | per call | acceptable |

Python header building in `_transport.py:183-199` is clean — plain dict, built once inside `build_sync_client`, reused by httpx.

---

## Prioritised fix order (one afternoon)

1. **F16** — Python retry sleeps past deadline. Correctness-adjacent, trivial diff.
2. **F14** — Node health probe pollutes EMA with `probeTimeout`. Trivial.
3. **F1 + F2 + F8** — "Peer lookup" PR: precomputed key, dict index, O(1) lookups across all three SDKs. Single biggest per-call win.
4. **F4 + F5** — Node `preferOrder` allocation + `isLocalHost` URL construction. One PR.
5. **F20 + F21** — Baseline + CI bench BEFORE fixing the rest, so fixes can be measured.
6. **F17** — Rust `pick_random` modulo bias. One-line fix.
7. Rest are hygiene.

---

## Benchmark coverage gaps (consolidated)

**Today:** only `status()` vs raw GET p50 micro-benches. That's it.

**Required before a perf-parity claim:**
- POST body path (all three) — guards serialize-once end-to-end.
- Retry loop cost — 503→200 cycling bench.
- PeerSet ops — `pick`, `nextAfter`, `preferOrder` micro-benches.
- Python cold-start bound — asserts PEP 562 ≤ N ms.
- Header/URL construction micro-benches (Node, Rust).
- Tailscale/mDNS parse-path bench with 100-peer fixture.
- CI baseline file + automated comparison (all three).
- Python non-MockTransport bench against loopback httpx-ASGI.
