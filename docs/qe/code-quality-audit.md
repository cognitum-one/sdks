# Cognitum SDK Code-Quality Audit — v0.2.0

**Scope:** `sdks/{node,python,rust}/` at commit on branch `initial-setup-ruflo-aqe`, 2026-04-23.
**Review aspect:** maintainability, parity drift, type safety, file-size hygiene, test hygiene.
**Method:** line-by-line read of shared surface (`client`, `peers`, `retry`, `call_options`, `errors`, every `resources/*`), plus targeted greps for escape hatches (`as any`, `.unwrap`, `type: ignore`, `TODO`).
**Baseline:** CHANGELOG claim — "Per-call `CallOptions` threaded through every resource method", "aligned release across all three SDKs".
**Severity scale:** blocker / major / minor / nit.
**Minimum finding score (BMAD-001):** 3.0 — this audit clears it with margin.

---

## Parity Matrix

| Feature / Behaviour | Node | Python | Rust | Notes |
|---|---|---|---|---|
| Resources: `pair`, `store`, `witness`, `custody`, `ota`, `mesh` | ✓ | ✓ | ✓ | All three expose the same six namespaces |
| `status` / `identity` as a resource | ✓ (member) | ⚠ (top-level method) | ⚠ (top-level method) | Node exposes `client.status(...)` via a `StatusResource` instance with `.get()`; Python/Rust expose it as a plain method on `SeedClient`. Harmless stylistically. |
| `CallOptions` on EVERY resource method | ✓ | ⚠ | ✗ | **Rust `pair.delete` has no `_with` variant** (pair.rs:41). **Python accepts `options=` everywhere** but the resolver silently drops `prefer`. |
| `CallOptions.prefer` actually honoured | ✓ (full order walked) | ✗ (accepted + validated, never used) | ⚠ (applied to 1st peer only, cycle ignores it) | Genuine semantic divergence — see F-Parity-2 |
| `CallOptions.signal` / cancellation | ✓ (`AbortSignal`) | ✗ | ✗ | Python/Rust have no first-class cancellation knob on `CallOptions` |
| `CallOptions.timeout` shape | ms scalar | seconds scalar OR `(c,r,t)` tuple | `Duration` | Three different shapes; none is wrong per host idiom but undocumented that shape differs |
| `CallOptions.idempotent` | ✓ | ✗ | ✗ | Node lets callers attest idempotency; Python/Rust hardcode per-method |
| Error taxonomy — 12 typed variants (ADR-0004) | ✓ | ✓ | ✗ | **Rust collapses 7+ logical errors into `Error::Auth(String)` / `Error::Validation(String)` with magic-string prefixes** (`tls_pin:`, `trust_score_blocked:`, `config:`, `unsupported:`, `not_implemented:`). No typed `TlsPinError`, `TrustScoreBlockedError`, `UnsupportedError`, `NotImplementedError`, `NetworkError`, `TimeoutError`, `ConflictError`, `ParseError`, `ConfigError`. Severity: major. |
| `TlsPinError` / `TrustScoreBlockedError` / `UnsupportedError` | class | class | string prefix on `Error::Auth`/`Error::Validation` | see F-Type-1 |
| `AuthReason` taxonomy | — (opaque message) | enum (`AuthReason`) | `&'static str` constants | Python is richest; Node has no structured reason at all; Rust exposes the reason but only as a string prefix. |
| `RateLimitError.retry_after_ms` carries parsed hint | ✓ | ✓ | ✗ (hardcoded `1000`) | rust/seed/error.rs:88 — real hint is applied to the sleep but the Error object lies about it. |
| `PeerSet.preferOrder(mode)` returning full walkable order | ✓ | ✗ | ✗ | Rust has `pick_local_first`/`pick_random` returning 1 peer; Python has neither |
| Semantics of `prefer=local-first` | RFC-1918/link-local IP detection | n/a | lowest `list_index` (first configured) | **Same name, completely different meaning** |
| mDNS discovery | optional peer dep (Node 7.x) | optional extra `[mdns]` | cargo feature `mdns` | Cleanly gated on all three; good. |
| Tailscale discovery | ✓ | ✓ | ✓ (always compiled) | Rust has no `tailscale` cargo feature — minor dependency hygiene gap |
| TLS fingerprint pinning (`fp=sha256:` TXT) | per-peer undici `Agent` | pre-handshake socket + `hashlib` | rustls `ServerCertVerifier` | Three different mechanisms — see F-Arch-2 |
| Sync + async client | — (Node is always async) | ✓ both | — (Rust is always async) | Python has ~95% duplicated request-loop logic between `_client.py` and `_async_client.py` |
| TODO / FIXME / XXX / HACK count (src, non-test) | 0 | 0 | 0 | Genuinely clean on this dimension. |

Legend: ✓ supported & consistent · ⚠ present with caveat · ✗ missing or broken

---

## Node SDK (`sdks/node`, 10 ts files, 3,265 lines src)

### Parity

**F-Node-1 (minor) — `client.mesh` is a full namespace; `client.pair.delete` uses `idempotent: true` by convention**
- `src/seed/resources/pair.ts:111` — hard-codes DELETE as idempotent. Matches HTTP semantics; but `pair.delete` has no body so that's just the correct path.
- No divergence *from* Rust / Python here in behaviour; noted only because it makes Python's lack of `idempotent` on `CallOptions` more visible.

**F-Node-2 (minor) — Resource `Record<string, unknown>` on all wire types**
- `src/seed/resources/store.ts:5,26,32,48` — `StoreStatus`, `StoreQueryHit`, `StoreQueryResponse`, `StoreIngestResponse` all `extends Record<string, unknown>`. This is intentional (the wire carries forward-compat extras) but means `hit.anythingAtAll` type-checks even when the field doesn't exist. Document the pattern or switch to an `extras: Record<string, unknown>` member.
- **Fix:** Introduce `extras` property, like Rust's `#[serde(flatten)] extras`.

### File size

**F-Node-3 (major) — `src/seed/client.ts` is 894 lines**
- CLAUDE.md / sdks/CLAUDE.md both mandate "Keep files under 500 lines". Only the seed-client blows it.
- The `request()` method alone is 224 lines (client.ts:447–671) and contains the failover state machine, trust-score gate, retry budget, cancellation chaining, and body serialisation — all interleaved.
- **Fix:** Extract the state machine into a `RequestDriver` class in a new `requestLoop.ts`. The three distinct concerns (peer cycle, retry backoff, trust-score gate) become testable in isolation. No public API change.

### Type safety

**F-Node-4 (nit) — `as any` in CLI / MCP glue**
- `src/cli.ts:140, :172`, `src/mcp-stdio.ts:93, :94` — 4 casts at dynamic boundaries (tool names from JSON-RPC params). Acceptable; JSON-RPC is inherently untyped. Consider `as { tools?: unknown[] }` casts for the two cli.ts sites.

### Behaviour

**F-Node-5 (nit) — backoff formula uses `Math.random()` (not crypto)**
- `src/seed/retry.ts:82` — `Math.random() * BASE_MS`. Not a bug (jitter is not a security primitive) but the Rust SDK uses a seeded xorshift64 with rejection sampling specifically to avoid modulo bias and burst-correlation (retry.rs:49–95). Under a sync 100-client burst, Node's jitter will exhibit higher correlation. Low impact; parity with Python on this choice.

### Tests / Dependencies

- `tests/seed/integration/mesh.test.ts` — mocked fetch only, no live network. Good.
- `tests/client-retry.test.ts:365` — test sets `COGNITUM_API_KEY = "env-key-abc"`. Placeholder, not a real token. OK.
- `package.json` peer dep `multicast-dns` declared optional with `peerDependenciesMeta`. Clean.
- No lockfile audit performed; undici@6 is current upstream.

---

## Python SDK (`sdks/python`, 17 py files, ~4,750 lines)

### Parity

**F-Py-1 (blocker) — `CallOptions.prefer` is declared, validated, then silently dropped**
- `_call_options.py:47` declares `prefer: Prefer | None`.
- `_call_options.py:54–64` validates it (`closest`/`local-first`/`random`/`any`).
- `_call_options.py:117–177` `resolve_call_options()` NEVER references `prefer` again. The field is accepted, passes validation, and has zero effect on routing.
- Node's `client.ts:491–495` computes `preferOrder` and walks it during failover. Rust's `config.rs:406–417` at least uses `prefer` for the first-peer pick (still degraded — see F-Parity-2 below).
- **Impact:** Callers who set `options=CallOptions(prefer="random")` get the default closest-first routing and no warning. The CHANGELOG v0.2.0 claim "Per-call `CallOptions` threaded through every resource method" is false for Python's `prefer`.
- **Fix:** Port `PeerSet.preferOrder` from Node; thread it through `_SyncTransport.request` and `_AsyncTransport.request`. Add a unit test that asserts routing order for each mode.

**F-Py-2 (major) — `_http: object` / `_http: Any` on every resource plus `# type: ignore[attr-defined]` x13**
- `resources/custody.py:10, :21`, `resources/ota.py:10, :29`, `resources/pair.py:12, :45`, `resources/store.py:39, :79`, `resources/witness.py:10, :23`, `resources/mesh.py:30, :65` — all type their transport dep as `object` (or `Any` for mesh).
- Every resource method then needs `# type: ignore[attr-defined]` to call `self._http.request(...)`.
- 13 `type: ignore[attr-defined]` in `resources/*.py` alone; 16 more elsewhere (29 total).
- **Fix:** Define a `typing.Protocol` e.g. `class Transport(Protocol): def request(self, method: str, path: str, *, options: CallOptions | None = None, json: dict | None = None, idempotent: bool | None = None) -> Any: ...`. Resources take `_http: Transport`. Deletes all 13 ignores, enables mypy-strict coverage.

**F-Py-3 (major) — `store.query` accepts a `filter=` param that Node and Rust do not**
- `resources/store.py:52, :94` — sync & async sig: `query(*, vector, k=10, metric='cosine', filter=None, options=None)`. Payload carries `"filter"` when set.
- `resources/store.ts:19–24` and `rust/resources/store.rs:26–28` have no `filter` knob.
- Either the seed actually honours `filter` on `/store/query` (then Node/Rust are missing it) or it doesn't (then Python is sending a field the seed ignores). Either way it's drift.
- **Fix:** Confirm against live seed; either add to Node/Rust or remove from Python.

**F-Py-4 (major) — `store.ingest` return type is `dict[str, Any]` in Python, typed dataclass in Node/Rust**
- `resources/store.py:69` — `def ingest(...) -> dict[str, Any]:`.
- `resources/store.ts:69` — `Promise<StoreIngestResponse>`.
- `rust/resources/store.rs:42` — `Result<StoreIngestAck, Error>`.
- There IS a `StoreIngestAck` / `StoreIngestResponse` equivalent in `_models/store.py` waiting to be used — it's just not wired in.
- **Fix:** Wrap return value with a `StoreIngestResponse.from_wire(data)` and declare the return type.

**F-Py-5 (minor) — Two public retry delay functions with different formulas**
- `_retry.py:120` `compute_delay_ms(...)` — correct equal-jitter exponential.
- `_retry.py:136` `compute_delay(...)` — **flat uniform** in `[0, min(cap, base*2^attempt)]`. No exponential-plus-jitter; just the multiplier is exponential but the draw is uniform over the whole range. Different formula, both exported in `cognitum.seed` public namespace (`seed/__init__.py:88`).
- **Fix:** Delete the seconds-valued `compute_delay` from public API or mark it deprecated; it duplicates `compute_delay_ms` with a subtly-different formula and is only used in internal tests.

**F-Py-6 (minor) — `_IDEMPOTENT_METHODS` includes `DELETE` and `PUT`; Node's default only covers `GET`/`HEAD`**
- `_retry.py:17` — `frozenset({"GET", "HEAD", "DELETE", "PUT"})`.
- `node/src/seed/client.ts:476–477` — `methodUpper === "GET" || methodUpper === "HEAD"`.
- Under the hood both SDKs pass `idempotent: true` explicitly on the resources that need it (e.g. `store.query`), so the default only affects calls that DON'T pass it. No current production divergence, but the defaults should match — either both retry DELETE on read-timeout or neither does.

### File size

**F-Py-7 (major) — `_client.py` 673 lines, `_async_client.py` 575 lines, ~90% duplicated**
- Sync and async request loops are line-by-line clones with `async`/`await` sprinkled in. Both above the 500-line limit.
- The sync `_SyncTransport.request` is 198 lines (248–445); async `_AsyncTransport.request` is ~190.
- Trust-score bookkeeping (`_trust_record_failure`, `_trust_reset`, `_trust_reset_all`, `_trust_count`) is duplicated verbatim.
- **Fix:** Extract a shared base `_BaseTransport` that holds peers / token_book / trust-score state and abstracts only the one `_dispatch(method, url, headers, json, timeout)` coroutine/function (one inline sync impl, one inline async). Or just lean on async & let sync users call `asyncio.run()`.

### Type safety / Dead code

- 29 `# type: ignore` suppressions. 13 of them vanish after F-Py-2.
- Zero `TODO/FIXME/XXX/HACK`.

### Tests / Dependencies

- `tests/seed/integration/test_seed_live.py:30` — gated on `SKIP_SEED_INTEGRATION` + TCP reachability. Good.
- `pyproject.toml` — `[mdns]` extra correctly declared, `dev` extra includes `pytest-asyncio` and `respx`. Clean.
- `httpx>=0.25.0` — current; no known CVE.

---

## Rust SDK (`sdks/rust`, 19 rs files, ~7,300 lines)

### Parity

**F-Rust-1 (blocker) — Error taxonomy missing 5+ variants; magic-string prefixes used instead**
- `src/error.rs` defines only 7 variants: `Auth(String)`, `RateLimit {retry_after_ms}`, `Validation(String)`, `NotFound(String)`, `Api {code, message}`, `Http`, `Json`.
- `src/seed/error.rs:100–152` defines builder functions that encode additional error classes as string prefixes on `Error::Validation` or `Error::Auth`:
  - `not_implemented(...)` → `Error::Validation("not_implemented: …")`
  - `unsupported(...)`     → `Error::Validation("unsupported: …")`
  - `config(...)`          → `Error::Validation("config: …")`
  - `tls_pin(...)`         → `Error::Validation("tls_pin: …")`
  - `trust_score_blocked(...)` → `Error::Auth("trust_score_blocked: …")`
- Node and Python both expose these as distinct classes: `TlsPinError`, `TrustScoreBlockedError`, `UnsupportedError`, `NotImplementedError`, `ConfigError`, `ConflictError`, `NetworkError`, `TimeoutError`, `ParseError`.
- Callers cannot `match` on these specifically in Rust — they have to `match Error::Validation(ref m) if m.starts_with("tls_pin:") => …`. `seed::error::is_trust_score_blocked(&err)` is the *only* extractor helper; the others don't exist.
- The file's own doc comment admits this: `error.rs:10–14` — "When the pre-fix lands the 12-variant ADR-0004 error, the helpers below collapse to a single mapping function". The "pre-fix" has not landed in v0.2.0 but the CHANGELOG ships as 1.0-quality.
- **Fix:** Add to `Error` enum: `TlsPin { peer: String, expected: String, actual: Option<String> }`, `TrustScoreBlocked { peer: String }`, `Unsupported { feature: String }`, `NotImplemented { endpoint: String }`, `Config { message: String, field: Option<&'static str> }`, `Conflict(String)`, `Timeout { phase: TimeoutPhase }`, `Network(reqwest::Error-like)`, `Parse(String)`. Keep the `Validation(String)` / `Auth(String)` variants as catch-alls; rewrite `from_response` to return the strong variant.

**F-Rust-2 (major) — `pair.delete()` does not accept `CallOptions`; no `delete_with` variant**
- `src/seed/resources/pair.rs:41–47` — `pub async fn delete(&self, client_name: &str) -> Result<(), Error>`.
- Every other resource method in Rust has both `foo` and `foo_with(opts: CallOptions)` overloads (e.g. `status_with`, `create_with`, `query_with`, `ingest_with`, `chain_with`, `peers_with`, `swarm_status_with`, `cluster_health_with`, `config_with`, `check_now_with`, `epoch_with`).
- Direct violation of the v0.2.0 release claim ("Per-call `CallOptions` threaded through every resource method"). A caller who wants to route a DELETE to a specific peer has no supported way to do it.
- **Fix:** Add `pair.delete_with(client_name, opts: CallOptions)` mirroring `create_with`.

**F-Rust-3 (major) — `CallOptions.prefer` affects only first peer pick, ignored by cycle logic**
- `src/seed/client.rs:406–417` — `resolve_call_options` uses `prefer` to resolve a *single* peer key, then passes it as the `pinned` argument to `request()`.
- `src/seed/client.rs:441–445` — the failover `next_peer()` helper uses `PeerSet::next_after`, which walks the `sort_key`-ordered closest-first sequence. The caller's `prefer` hint is lost after peer #1 fails.
- TS Node computes `preferOrder: Peer[]` once and walks the whole sequence (client.ts:492–495, :614–619). Semantically different from Rust under mesh failover.
- **Fix:** Port `PeerSet::prefer_order(mode) -> Vec<&Peer>`; carry the cursor through the request loop the way Node does.

**F-Rust-4 (major) — `Prefer::LocalFirst` means "lowest list_index", not "RFC-1918 / link-local"**
- `src/seed/peers.rs:242–248` — `pick_local_first` picks the `min_by_key(|p| p.list_index)` that isn't Unhealthy. That is just "first configured".
- `node/src/seed/peers.ts:326–346` — `isLocalHost` classifies hosts by IP range (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, fe80::/10, ::1, `localhost`).
- Same `"local-first"` token, completely different result. A user with `endpoints: ["https://api.cognitum.one", "https://seed.local"]` who asks for `Prefer::LocalFirst`:
  - Node picks `seed.local` (the `.local` address reverse-resolves; for literal IPs it would pick 10/192.168/etc.).
  - Rust picks `api.cognitum.one` (list index 0).
- **Fix:** Port the IP classifier from Node (or the simpler: "peer whose URL resolves to a private / link-local IP"). Document that both `prefer` and `prefer_local_first` are best-effort classifiers, not guaranteed semantics.

**F-Rust-5 (major) — `RateLimit` error carries hardcoded `retry_after_ms: 1000`**
- `src/seed/error.rs:87–89` — `429 => BaseError::RateLimit { retry_after_ms: 1000 }`.
- The actual server hint is parsed in `retry::parse_retry_after` and used for the sleep delay in `client.rs:556`, but the `Error` bubbled up to the caller always says "1000 ms" regardless of what the seed sent. Callers handling their own rate-limiting (e.g. a dashboard waiting on `err.retry_after()`) get the wrong number.
- **Fix:** `from_response` should accept the parsed hint and pass it into the `RateLimit` variant. That means plumbing the `HeaderMap` into the call, which the current code path already has.

**F-Rust-6 (minor) — HTTP-date parser in `parse_retry_after` is a stub**
- `src/seed/retry.rs:182–196` — `parse_http_date_delta` has doc "We don't fully parse". Always returns `None`.
- Node's `parseRetryAfterHeader` uses `Date.parse` (retry.ts:151). Python's uses `email.utils.parsedate_to_datetime` (_retry.py:77).
- A seed that emits `Retry-After: Sun, 06 Nov 1994 08:49:37 GMT` (unlikely, but legal per RFC 7231) would have its hint silently dropped on Rust, retried immediately via computed backoff.
- **Fix:** Pull in `httpdate` crate or roll the ~40-line parser. Low priority given the seed's observed behaviour.

**F-Rust-7 (minor) — `TailscaleDiscovery` has no cargo feature gate**
- `Cargo.toml:24–36` defines features `seed`, `mdns`, `rustls`, `native-tls`, `blocking`, `live-seed-tests`, `stream`, `default`. No `tailscale`.
- `src/seed/discovery/mod.rs:41–46` — comment explicitly says "`TailscaleDiscovery` has no feature flag — it only needs `std::process::Command` + `tokio::task::spawn_blocking`".
- That's defensible (no external deps needed), but Node / Python treat Tailscale as an opt-in capability. A `tailscale` feature would let Rust consumers signal intent the same way, and guarantees the `TailscaleDiscovery::default()` call can be dead-stripped when unused.

### File size & complexity

**F-Rust-8 (major) — `src/seed/client.rs` is 1,270 lines, `request()` is 202 lines**
- Largest file in the repo by a wide margin. Violates the 500-line rule.
- `request` method (client.rs:447–648) contains:
  1. Deadline check per iteration.
  2. Body serialise-once.
  3. Peer-pick / header build / pin selection.
  4. Two-level match on the send result.
  5. Trust-score bump / reset.
  6. `StatusOutcome` dispatch (cycle / pin / surface).
  7. ADR-0005 retry-budget fallthrough for each case.
  8. Separate transport-error branch with its own retry fallthrough.
- Nested 5 deep in places (outer `loop` → `match send_result` → `Ok(response)` → `match dispatch_status_outcome` → `StatusOutcome::Cycle` arm → `if retry::should_retry…`).
- **Fix:** Extract `RequestLoop` struct holding the mutable per-request state (`attempt`, `peers_tried`, `last_err`, `started`). One method per state-transition (`handle_success`, `handle_cycle`, `handle_pin`, `handle_surface`, `handle_transport_error`). The outer loop shrinks to ~30 lines of state-machine dispatch.

### Type safety

**F-Rust-9 (minor) — `.expect("peers lock poisoned")` in hot path**
- `src/seed/client.rs:203, :215, :925` — three sites that panic if `Mutex<PeerSet>` is poisoned. If a panic happened while holding the lock on any other thread, these calls turn what might have been a recoverable logic error (e.g., a panic in `mark_failure`) into a process-wide abort.
- Other callers in the same file (e.g. client.rs:161, :182, :387, :407, :430) correctly use `.map_err(|_| Error::Api {…})`. The three panic sites are outliers.
- **Fix:** Return `Err(Error::Api { code: 0, message: "seed: peers lock poisoned".into() })` like the other sites.

**F-Rust-10 (nit) — 21 `.unwrap()` / `.expect()` in `src/seed/peers.rs`, 15 in `src/seed/client.rs`**
- Majority are in `#[cfg(test)]` blocks — fine. Non-test instances:
  - `peers.rs:231` — `best.expect("PeerSet invariant: at least one peer")`. Constructor-guaranteed; OK as a debug assertion but a `unreachable!` with a message would be idiomatic.
  - `client.rs:190` — `expect("failed to build reqwest client")` on `Client::with_config`. The doc comment warns callers; still, mesh callers going through the builder hit this on any `reqwest::ClientBuilder::build` failure.
  - `client.rs:203`, `:215`, `:925` — already covered in F-Rust-9.
- **Fix:** Swap the `PeerSet` one for `unreachable!`. Others handled by F-Rust-9.

**F-Rust-11 (nit) — `reqwest_error_into_transport` is a no-op pass-through**
- `src/seed/client.rs:733–737` — accepts `reqwest::Error`, returns it unchanged. Doc: "Pass-through: we just want to keep `Error::Http` semantics. Split out for readability now that the request loop is larger."
- Dead abstraction; either delete and use `Error::from(e)` directly, or give it a real job (e.g. filter/map-classify transport error types).

### Tests / Dependencies

- `Cargo.toml` feature gates (`seed`, `mdns`, `rustls`, `native-tls`, `blocking`, `stream`, `live-seed-tests`) compose correctly:
  - `default = ["rustls"]` — base cloud client with TLS.
  - `seed = ["dep:url"]` — enables seed module.
  - `stream = ["seed", "dep:eventsource-stream"]` — depends on seed.
  - `mdns = ["seed", "dep:mdns-sd"]` — depends on seed.
  - `live-seed-tests = ["seed"]` — gate for integration tests.
- I did NOT run `cargo check --no-default-features --features <x>` for each combination; recommended as a CI gate. Rationale: `cargo-hack --each-feature check` would catch e.g. accidental unconditional `url::Url` references in non-seed code paths.
- `tests/seed_live.rs:13` — `#![cfg(feature = "live-seed-tests")]`. Good.
- `rustls = { version = "0.23", default-features = false }` — current.
- `reqwest = "0.12"` — current.

---

## Shared findings

**F-Parity-1 (major) — `SeedSession` surface is not matched across SDKs**
- Node: `SeedSession` class; `new SeedSession(client, peerKey)`. Every resource method is re-exposed on the session.
- Python: `from cognitum.seed._session import SeedSession`. Lazy-imports at `client.session()` call site (`_client.py:594`). Resource attr access uses `Any`.
- Rust: `pub fn session(&self) -> SeedSession<'_>` with a lifetime-borrowed session. Resource methods live on `SeedSession` directly.
- The three shapes are all "correct" for host idiom, but the method NAME parity (`client.session().store.query(...)` vs `client.session().store().query(...)`) differs between Python (attribute) and Rust (method returning resource). Document the intended user-facing pattern in the root README so the three paths are readable side-by-side.

**F-Parity-2 (blocker) — `prefer` behaviour diverges across all three SDKs**
- Node: full order walked through every failover cycle.
- Rust: only first peer is biased; cycle reverts to closest-first.
- Python: declared, validated, ignored.
- Combined with F-Rust-4 (LocalFirst semantics differ), an app that works against the Node SDK and is ported to Python/Rust will silently get different routing.
- **Root cause:** No shared golden test for "given prefer=X and a mesh of Y peers where peer A fails, the next peer must be B". Each SDK implemented `prefer` in isolation.
- **Fix:** Add a wire-level parity suite under `tests/parity/prefer/` that the three SDKs all validate against a shared YAML fixture.

**F-Arch-1 (minor) — `status` / `identity` exposure shape differs**
- Node: resource pattern (`client.status(opts?)` via callable-with-`.get`, `resources/status.ts:27–42`).
- Python: method on client (`client.status(*, options=None)`, `_client.py:537–547`).
- Rust: method on client (`client.status() / client.status_with(opts)`, `client.rs:262–280`).
- Minor stylistic drift; the Node variant is cleverer than necessary (the callable-plus-`.get`-property pattern). Consider dropping the `.get` alias — it's unused anywhere I could find and makes `StatusResource` look like something more complex than a thin function.

**F-Arch-2 (minor) — TLS fingerprint pinning uses three different mechanisms**
- Node: per-peer `undici.Agent` with `tls.checkServerIdentity` override (`transport.ts`).
- Python: PRE-dispatch raw TLS handshake to fetch the cert, SHA-256 check, cache (`_transport.py:272–348`). **Note:** this opens a *second* TCP+TLS handshake per new peer on top of the httpx one, and creates a TOCTOU window — a MITM that cuts in between the pre-check and the httpx handshake defeats the pin. Threat is marginal (timing window is microseconds) but not zero.
- Rust: rustls `ServerCertVerifier` (`tls_pin.rs`) — lives inside the handshake, no TOCTOU.
- **Fix (Python):** Move the pin check to a custom `httpx.HTTPTransport` that hooks the SSL context post-handshake. The Python comment at `_transport.py:282–286` already acknowledges the httpx limitation; the cost is ~100 lines of transport code vs. the current TOCTOU window. Reasonable trade for a security-adjacent path.

**F-DRY-1 (major) — Each SDK has 6 resource wrappers that are 90% the same boilerplate**
- Every resource method: "receive args → call request → return typed body". Same pattern in all three SDKs.
- Rust: `_with` variants double the method count for pure plumbing — they could be generated with a macro or collapsed via `impl<T: Into<Option<CallOptions>>>`.
- Node: resources are functions returning a plain object. Fine, just boilerplate.
- Python: 6 sync classes + 6 async classes for the same endpoints (12 total). The async ones are line-for-line `await`-sprinkled copies.
- **Fix (Rust):** Default CallOptions via `impl Default`, collapse `foo`/`foo_with` into one `foo(&self, opts: CallOptions)` where `CallOptions::default()` is a zero-effect no-op. The existing `#[non_exhaustive]` + `Default` already support this — just a signature change.
- **Fix (Python):** See F-Py-7 (shared transport base). Resource classes can be one class that takes a bool flag, or can keep sync/async split but at least share `_ResourceBase` that holds `_http`.

**F-DRY-2 (minor) — Retry formula lives in 3 places with subtle differences**
- Node: `retry.ts:80–82` — `min(CAP_MS, expo + Math.random() * BASE_MS)`.
- Python: `_retry.py:129–133` — `min(cap_ms, raw + uniform(0, base_ms))` where `raw = min(cap_ms, base_ms * 2^attempt)`.
- Rust: `retry.rs:28–35` — `min(cap_ms, base_ms * 2^attempt + uniform(0, base_ms))` via xorshift64.
- All three are *equivalent* to ADR-0005's equal-jitter. But no golden test locks them to the same random seed; a refactor could silently change distributions. Add a deterministic unit test (fixed seed → fixed delays list) to each SDK; cross-reference the three.

---

## Clean Justification (where this audit deliberately did NOT find issues)

| Dimension | Evidence of cleanliness |
|---|---|
| TODO / FIXME / XXX / HACK backlog | 0 across all three SDK `src` trees (verified `grep -rn`) |
| Test hygiene — real secrets | All token constants are placeholders (`"env-key-abc"`, `"abc"`, `"shared"`). Env-var reads use `COGNITUM_API_KEY` / `COGNITUM_SEED_TOKEN` at the correct namespace |
| Integration-test gating | Rust uses `#[cfg(feature = "live-seed-tests")]`. Python checks `SKIP_SEED_INTEGRATION` + TCP reachability at test-setup. Node integration tests are mock-fetch-only (no gating needed) |
| `peers.ts` / `_peers.py` / `peers.rs` core algorithm parity | Sort key `(state_rank, latency_ema, list_index)` + `mark_failure` transitions (Degraded ≥1, Unhealthy ≥3, ServiceUnavailable → immediate Unhealthy) are identical across the three |
| `TokenBook` / `SecretString` abstraction | Trait / Protocol / interface shape matches; `SecretString` redaction consistent (Node: `[util.inspect.custom]` + `toJSON`; Python: `__repr__` + `__str__`; Rust: `Debug`/`Display` return redacted form) |
| mDNS / Tailscale discovery logic | `fp=sha256:<hex>` / `id=` / `port=` / `epoch=` TXT parsing is parity-clean |
| Node `as any` escapes | Only 4 instances, all at inherently-dynamic JSON-RPC boundaries |
| Rust feature composability | Feature graph is clean (`seed`-gated cleanly; mdns correctly depends on seed) — though see F-Rust-7 |
| DDD glossary compliance | "PeerSet" / "SeedSession" / "TokenBook" are *not* in the seed-domain.md glossary — they're SDK-internal abstractions, not ubiquitous-language terms, so the "glossary drift" concern is moot for them. Actual domain terms (`Pairing`, `Witness chain`, `Epoch`, `Custody`) are used verbatim where they appear |

---

## Remediation priority (blocker → minor)

**Blockers (ship-stoppers for the v0.2.0 parity claim):**
1. F-Py-1 — Python silently ignores `CallOptions.prefer`.
2. F-Rust-1 — Rust error taxonomy is 5+ variants short; uses string prefixes instead.
3. F-Parity-2 — `prefer` behaves differently in all three SDKs; no cross-SDK golden test.

**Majors (correctness / maintainability debt):**
4. F-Rust-2 — `pair.delete` has no CallOptions variant in Rust.
5. F-Rust-3 — Rust's `prefer` cycle semantics differ from Node.
6. F-Rust-4 — `prefer=local-first` means different things in Node vs Rust.
7. F-Rust-5 — Rust `RateLimit.retry_after_ms` is hardcoded.
8. F-Py-2 — Python resources use `_http: object` with 13 `type: ignore`.
9. F-Py-3 — Python `store.query` carries a `filter` param Node/Rust don't.
10. F-Py-4 — Python `store.ingest` returns `dict[str, Any]` instead of typed model.
11. F-Py-7 — Python sync/async client duplication; both files >500 lines.
12. F-Node-3 — Node `seed/client.ts` at 894 lines; `request()` at 224 lines.
13. F-Rust-8 — Rust `seed/client.rs` at 1270 lines; `request()` at 202 lines.
14. F-DRY-1 — Resource wrapper boilerplate multiplied ×3 per SDK.

**Minors / nits (hygiene):**
- F-Py-5, F-Py-6, F-Node-2, F-Node-5, F-Rust-6, F-Rust-7, F-Rust-9/10/11, F-Arch-1, F-Arch-2, F-DRY-2.

## Suggested first sweep

To close the "is v0.2.0 actually aligned?" question in one PR:
1. Add a `tests/parity/` directory with a YAML-driven fixture of `(request, expected_peer_sequence, expected_error)` and have each SDK run it.
2. Fix F-Py-1, F-Rust-2, F-Rust-3, F-Rust-5 directly — they make the parity tests pass without architectural changes.
3. F-Rust-1 (typed error variants) is a semver-minor bump inside the Rust SDK; schedule as v0.3.0 rather than patching v0.2.x since callers will need `match` arm updates.

The rest are best addressed file-by-file as the three request loops are refactored (F-Node-3, F-Py-7, F-Rust-8). Those three refactors have high unit-test leverage — every subsequent fix becomes one-liner.
