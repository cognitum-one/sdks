# Cognitum SDKs — Quality Experience & SFDIPOT Analysis

- **Scope:** `sdks/{node,python,rust}` at v0.2.0 (2026-04-23), ADRs under `docs/adr/`.
- **Audience:** developer users integrating against a Cognitum Seed.
- **Goal:** name the DX friction, generate a test-strategy grid, surface oracle problems, and prioritise for 0.3.0.

## Symbols used
- **S / M / L / XL** — severity: low / medium / high / critical.
- **Evidence** lines cite file paths. Everything is checkable.

---

## Part A — Developer Experience audit

### A1. Onboarding friction (time-to-first-call)

| Severity | Finding |
|----------|---------|
| **L** | Node + Python quick-start runs as-is against `https://cognitum.local:8443` with `tls: { insecure: true }`. Copy-paste works. |
| **M** | Rust quick-start doesn't compile as written — it calls `SeedClient::builder()` but `sdks/rust/README.md` never tells the reader to enable the `seed` feature on the `cognitum-rs` crate, AND the example imports `StoreQuery` with no `use` line. |
| **M** | Root README quick-starts do not set a pairing token, then go on to call `client.store.query(…)`. `query` is a paired-write per ADR-0003 — dev will get an `AuthError { reason: not_paired }` on first run and no README says where `COGNITUM_SEED_TOKEN` fits. |
| **H** | Root README claims "71 seed endpoints typed and wrapped" (line 81). The actual implementations expose ~16 per SDK (8 resource modules × ~1–4 methods each, per `src/seed/resources/`). "sensor / coherence / thermal / delivery" groups the README lists don't exist in any SDK. Developers who pick an SDK based on the feature table will be surprised. |
| **M** | Root README references `pair.window` — not implemented in any SDK (`grep -rn pair.window sdks/*/src` returns nothing). |
| **L** | Node CLI reports `VERSION = "0.1.2"` (`sdks/node/src/cli.ts:6`) while `package.json` is `0.2.0`. Also the CLI hits `api.cognitum.one` only — developers who install the CLI expecting to talk to a seed will find no seed commands. |

**Evidence**
- `sdks/node/src/cli.ts:6` — hardcoded `VERSION = "0.1.2"`.
- `sdks/node/src/seed/resources/*.ts` — 16 `request<…>()` sites total; no delivery/sensor/coherence/thermal.
- `sdks/rust/README.md:20–33` — imports `SeedClient` but not `StoreQuery`.
- `sdks/python/README.md`, `sdks/rust/README.md`, `sdks/node/README.md` — all three say "12 typed seed endpoints", contradicting the root-level "71".

**Fix for 0.3.0**
- Make the root README's "Features at a glance" section match the code — either trim to the real surface (12 phase-1 + 4 mesh), or add a "roadmap" column flagging unshipped endpoints.
- Add pair.create to every quick-start before the `store.query` line. Link `COGNITUM_SEED_TOKEN` in the same code block.
- Sync the Node CLI `VERSION` to `package.json` at build time, and document that the CLI is cloud-only.

---

### A2. Discoverability

| Severity | Finding |
|----------|---------|
| **M** | TLS modes are named three different ways across docs. Python's `SeedTLS` has `ca_pem` / `ca_path` / `verify` / `insecure` / `pinned_sha256` / `client_cert` — six knobs — but neither README nor quick-start mentions `ca_path`, the ergonomic option (most devs have a file, not a blob). |
| **M** | The `CallOptions` per-call override surface (`peer` / `prefer` / `consistency` / `timeout` / `retries`) is documented in ADR-0016b but only appears in the root README as a one-liner. None of the three SDK READMEs shows an example like `client.store.query(q, { peer: "https://seed-2.local:8443", consistency: "eventual" })`. |
| **M** | Mesh routing is described at the conceptual level (closest-first, session-sticky, failover on 5xx) but no README shows: `new SeedClient({ endpoints: ["...a", "...b", "...c"] })`. First-time users reading the Node README will think it's a single-seed client. |
| **L** | `MdnsDiscovery` / `TailscaleDiscovery` are listed as features but not shown. Installing `multicast-dns` / enabling `--features seed,mdns` / `pip install cognitum[mdns]` is stated but the *usage snippet* is missing from every README. |
| **L** | `client.rediscover()`, `client.peers()`, `client.session(peerKey)` are surfaced in the "Surface map" section of the root README but none of them appear in the SDK-specific READMEs. |

**Fix for 0.3.0**
- Each SDK README gets three runnable snippets: single-seed, multi-seed, discovery-driven. Each snippet demonstrates one production concern (CA pinning, per-call override, fingerprint pinning).
- Add a "Knob reference" table to each README: every field on `SeedClientOptions` / `ClientConfig` / `ClientBuilder` in one sortable grid.

---

### A3. Error messages (actionable vs symptom-only)

| Severity | Finding |
|----------|---------|
| **S** | `ConfigError("at least one endpoint is required")` in Node (`seed/config.ts:213`). Good — tells you the fix. |
| **S** | `AuthError("apiKey is required — pass config.apiKey or set COGNITUM_API_KEY")` in Node (`client.ts:254`). Textbook: both resolution paths named. |
| **S** | Python's `ConfigError("TLS trust material required for non-default hosts (pass tls=SeedTLS(ca_pem=...) or insecure=True)")` in `seed/_transport.py:96-99` — exact copy of the Node style, names the fix. |
| **M** | Rust's `Error::Validation(String)` is a single anonymous string (`src/error.rs:33-34`). The error taxonomy ADR (0004) mandates `Error::Validation { field?, message }` with an optional `field`. Rust's impl is pre-ADR-0004 shape. Callers can't pattern-match on the field. |
| **M** | Rust's cloud `Error` enum lacks `NotImplemented`, `Conflict`, `ServiceUnavailable`, `Timeout`, `Parse`, `TlsPin`, `TrustScoreBlocked` variants that Node/Python both expose. Code reviewed at `src/error.rs:1-66` — 7 variants vs the 12 the ADR calls for. The *seed* sub-module's `seed/error.rs` (284 lines) is closer to the ADR, but the cloud-level `Error` diverges. Callers writing `match` against an `Error` today will hit the `#[non_exhaustive]` wall unpredictably. |
| **M** | `TrustScoreBlockedError.retryableAfter = null` (Node, `errors.ts:219`) — the field's comment explains the design but the value `null` is surprising. An explicit `RetryVerdict.DoNotRetry` enum would read better than a null-is-sentinel bool pattern. |
| **L** | `TlsPinError` messages are great ("expected `<sha>`, got `<sha>`"). But none of the three includes a *remediation* tail. A good tail: "— if you rotated the seed's cert, clear the pin via `client.peers.clearFingerprint(<peerKey>)`." |
| **M** | Python's `NotImplementedError` shadows the builtin. Documented in the docstring, but `try: … except NotImplementedError:` in user code will silently catch a builtin bug. |

**Fix for 0.3.0**
- Bring Rust's top-level `Error` enum into ADR-0004 parity. The `seed::Error` module already has the shape — promote the taxonomy to crate root.
- Add a "remediation" attribute on each error class, auto-appended to `toString()` / `__str__` / `Display`.
- Rename Python `NotImplementedError` → `EndpointNotImplementedError` (shadow is an avoidable footgun).

---

### A4. Config resolution (apiKey / pairingToken precedence)

This is the biggest ADR-vs-reality gap in v0.2.0.

| Severity | Finding |
|----------|---------|
| **L** | Node honours the documented order: explicit arg → `COGNITUM_API_KEY` / `COGNITUM_SEED_TOKEN` → typed error. Cloud: `src/client.ts:247-256`. Seed: `src/seed/config.ts:243-248`. |
| **L** | Node's error message names both sources. |
| **H** | **Python does NOT read `COGNITUM_SEED_TOKEN`** anywhere in production code. `grep -rn os.environ sdks/python/cognitum --include='*.py'` returns one hit, in `mcp/transports/_stdio.py`, passing parent env to subprocess. The root README and ADR-0007 §Credential provisioning both say Python must accept `COGNITUM_SEED_TOKEN`. This is a **documented feature that is unimplemented**. |
| **H** | **Rust reads no credential env vars at all.** Only `COGNITUM_SUPPRESS_BEARER_WARNING` (`src/client.rs:116`). No `COGNITUM_API_KEY`, no `COGNITUM_SEED_TOKEN`. Same documentation-vs-impl gap as Python. |
| **M** | A dev following the root README verbatim will assume "set the env var" works in Python and Rust. It does not. Failure mode: silent — Rust sends a blank `X-API-Key`; first call returns `Error::Auth("…")` with no hint that the env var was expected to populate. |

**Evidence**
- `grep -rn 'COGNITUM_SEED_TOKEN\|COGNITUM_API_KEY' sdks/python/cognitum` → zero matches in production code.
- `grep -rn 'env::var' sdks/rust/src` → one match, for the deprecation warning.
- Root `README.md:159-166` documents the precedence as a cross-SDK contract.

**Fix for 0.3.0 (critical)**
- Python: `SeedClient.__init__` falls back to `os.environ.get("COGNITUM_SEED_TOKEN")` when `auth.pairing_token is None`. Symmetric for `api_key`.
- Rust: `ClientBuilder::build()` calls `std::env::var("COGNITUM_API_KEY")` when `api_key.is_empty()`; seed builder likewise for the pairing token. Match Node's error text verbatim so cross-language behaviour is identical.
- Add a conformance test row: "omit credential → error message names the env var".

---

### A5. Dev-mode footguns (`insecure: true`)

| Severity | Finding |
|----------|---------|
| **M** | All three SDKs warn **once per process** when insecure mode is enabled. ADR-0007 §TLS says: "MUST log a warning on every request while active". Every SDK violates the ADR letter. `grep -n 'WARNED\|warnedInsecure'`: Node `src/seed/transport.ts:30/46`, Rust `src/client.rs:26/228`, Python `_transport.py:35-56`. |
| **H** | No SDK forbids `insecure` on a non-loopback host. Python has a localhost carve-out that was closed (good — `_transport.py:26-30` comment) but non-default hostnames can still be accessed with `insecure=True` silently. A developer can ship `insecure: true` pointing at a public internet seed and the SDK won't stop them. |
| **H** | If a user ships `insecure: true` to prod, we don't notice. No metric, no telemetry, no structured log. The one-shot warning lands in stderr on process start and is trivially swallowed by most logging setups. |
| **M** | Rust's `danger_accept_invalid_certs(true)` method name is good (the word "danger" at the call site). Node's `tls: { insecure: true }` and Python's `SeedTLS(insecure=True)` are blander — `dangerouslyInsecure: true` would match the Rust naming and force the footgun into the call site. |
| **L** | The `tls.insecure` warning on Python uses `warnings.warn(..., UserWarning)` which respects the user's filter config — nice. Node uses `console.warn` which cannot be filtered. Rust uses `eprintln!` which cannot be filtered. |

**Fix for 0.3.0**
- Add a `hostname` guard: if `insecure` is set AND the endpoint's host is not `127.0.0.1` / `::1` / a link-local (`169.254.*`, `fe80:*`) / `.local`, throw `ConfigError` at construction. Document how to bypass with `allowInsecureNonLoopback: true` for the rare test case.
- Rename to `dangerouslyInsecure` / `danger_accept_invalid_certs` across the surface.
- Emit a structured log record at request-time (not just startup) with `{reason: "tls.insecure", peer, elapsed_ms}` so ops can grep for it.

---

### A6. Feature flags / optional extras consistency

| Severity | Finding |
|----------|---------|
| **M** | The three gates have three different names for the same thing: Node `@cognitum/sdk/seed/discovery/mdns` subpath import, Python `pip install cognitum[mdns]`, Rust `features = ["seed", "mdns"]`. Cross-SDK docs can't reuse a single sentence without branching per SDK. |
| **M** | Rust `seed` is **non-default** (`Cargo.toml:26`); Python's seed is always imported; Node's seed lives behind a subpath. A developer who copies the root `README` quick-start for Rust and adds `cognitum-rs = "0.2"` without `features = ["seed"]` gets no compile error — just a completely empty surface. |
| **L** | `live-seed-tests` feature exists in Rust but not documented in `sdks/rust/README.md` — researchers who want to repro the live matrix can't find the flag. |
| **L** | Node's `multicast-dns` is a peer dependency — good (correctly optional). But the install instruction is `npm install multicast-dns` with no mention of the *required* version constraint (`^7.2.5` per `package.json`). A stale install will silently pick a wrong major. |

**Fix for 0.3.0**
- Add a "Which install line do I need?" decision table to each SDK README. Rows: single-seed HTTPS, mDNS discovery, Tailscale, stdio MCP.
- Rust: flip `seed` to default (or at minimum, a compile_error shim that says "enable `seed`" when calling `cognitum::seed::SeedClient`).
- Pin peer-dep versions in the Node README install snippet.

---

### A7. Redaction UX — printing a `pair.create` response

**All three SDKs get the redaction part right.** The pair-create response wraps `token` in `SecretString` (Node `seed/resources/pair.ts:92-98`, Python `seed/_models/pair.py:40-66`, Rust `seed/models/pair.rs:52-77`). `console.log` / `repr()` / `{:?}` all print `SecretString(<redacted, N bytes>)`.

| Severity | Finding |
|----------|---------|
| **S** | Redaction is consistent. Conformance tests pin the contract (14 tests across 3 SDKs per CHANGELOG). |
| **L** | The redacted form says `<redacted, 48 bytes>` — useful for diagnosing truncation. The surrounding object still shows `client_name`, `expires_at`, and `extras` — useful to confirm "pairing succeeded, this many bytes of token, expires at X". Informative without being leaky. |
| **M** | `PairCreateResponse.token` is a full `SecretString` in Python + Rust but in Node it's just wrapped — no `.as_str()` / `.reveal()` parity annotation in the response type's docstring. Devs will have to read the tokenBook.ts module to discover `.reveal()`. |
| **M** | `JSON.stringify(response)` in Node returns `{"client_name":"...", "token":"<redacted>", "expires_at":"..."}` — the token redacts, but the *container* is plain JSON. A well-meaning developer who writes `fs.writeFileSync("pair.json", JSON.stringify(response))` *thinks* they're persisting the pairing and gets back a file with a useless `"<redacted>"` string. We need a `.toPersistable()` or an explicit "use `tokenBook.set()` to persist" callout in the PairCreateResponse jsdoc. |

**Fix for 0.3.0**
- Add a "persisting a pairing" section to each SDK README. Pattern: `tokenBook.set(peerKey, response.token)`, then how to export the book.
- Attach a `.reveal()` / `.as_str()` mention to the `PairCreateResponse.token` jsdoc / docstring so VS Code hover shows it.

---

## Part B — SFDIPOT test ideas (James Bach HTSM product factors)

One row per factor. Action verbs; every idea is executable with the tooling already on disk (vitest, pytest, cargo test, a single seed appliance, or mock clients).

### Structure

| # | Test idea |
|---|-----------|
| 1 | Compile `cognitum-rs` with `--no-default-features`, `--features rustls`, `--features seed`, `--features "seed,mdns,stream,blocking"` and confirm each build succeeds **and** that `cognitum::seed` is absent from the first two and present in the last two. |
| 2 | Install `@cognitum/sdk` via `npm pack && npm install ./cognitum-sdk-0.2.0.tgz` into a fresh project, then import from `@cognitum/sdk/seed` and `@cognitum/sdk/seed/discovery/mdns`. Observe that subpath exports resolve under both ESM and CJS consumer configurations. |
| 3 | Measure `@cognitum/sdk` published tarball size via `npm pack --dry-run`. Assert it stays under 50 KB gzipped (it's pure TS today). |
| 4 | Build Rust with `--features seed` and run `cargo build --timings` to confirm compile time under 15s on CI reference machine. |
| 5 | `pip install cognitum` into a clean venv, confirm import of `cognitum.seed` completes in <100ms (lazy `__getattr__` is in the CHANGELOG as a 12ms win — regress if import time grows). |
| 6 | Run `npm install --production --dry-run` and confirm only `undici` ships as a runtime dep (no stray devDependency leak). |
| 7 | Import `@cognitum/sdk` into a webpack app with `sideEffects: false`; bundle and inspect that the seed subpath is tree-shaken out when only `HttpClient` is used. |
| 8 | Delete `sdks/rust/src/seed/discovery/mdns.rs` temporarily and run `cargo check --features seed` (no mdns). Confirm no cross-module unused-import warnings — validates `mdns` feature gate isolation. |

### Function

| # | Test idea |
|---|-----------|
| 1 | Invoke every 12 documented seed endpoint against a live seed; confirm each returns within 5s and the parsed response matches the typed interface. |
| 2 | Drive `SeedClient` with `endpoints: [a, b, c]` where `b` returns 503; observe the failover state machine cycles a→c, marks `b` Degraded, never cycles through `b` again during a 60s window. |
| 3 | Submit `store.query({ vector, k })` with `CallOptions({ peer: b, consistency: "strong" })`; confirm the call raises `UnsupportedError` **before** any HTTP dispatch (no socket opened). |
| 4 | Force 3 consecutive 401 responses against peer `a`; observe the 4th call raises `TrustScoreBlockedError(peer=a)`, NOT `AuthError`. Confirm a subsequent 2xx against `a` resets the counter (5th call with a valid token succeeds). |
| 5 | Mount an `MdnsDiscovery` against a simulated `_cognitum._tcp.local.` responder that advertises `fp=sha256:<hex>`. Observe the discovered peer carries `tlsFingerprint`, and a 2nd run where the responder swaps certs triggers `TlsPinError`. |
| 6 | Start an `McpClient(StdioTransport)` wrapping a hanging subprocess; call `listTools()` with a 2s timeout; confirm the subprocess is reaped, no zombies. |
| 7 | Issue `pair.create` twice with the same `clientName` against a seed in pairing-window-closed state; observe the second call raises `AuthError { reason: PairingWindowClosed }`, NOT a 500. |
| 8 | Configure `retries: null` on a specific `store.ingest` call and fail the first attempt with a 503; observe **zero** retry even though the client-wide default is 3. |
| 9 | Call `client.mesh().clusterHealth()` with `prefer: "local-first"`; confirm peer selection picks the RFC-1918 peer first, regardless of its EMA latency. |
| 10 | Register a custom `TokenBook` that throws on `get()`; issue any write; observe a typed `ConfigError` (not an unhandled exception propagating to user code). |

### Data

| # | Test idea |
|---|-----------|
| 1 | Round-trip a `SecretString` through `JSON.stringify` / `json.dumps` / `serde_json::to_string` and confirm the output is the literal string `"<redacted>"` in all three runtimes. |
| 2 | Serialise a `PairCreateResponse` with `token` of lengths {0, 1, 48, 1024}; confirm the redacted form reports exact byte counts and never the value. |
| 3 | Submit `store.query({ vector: Array(4096).fill(0.1), k: 10 })` and measure the JSON body size; confirm no request-body truncation under 1MB (seed doc says 2MB cap). |
| 4 | Submit a query with `vector: [NaN, Infinity, -Infinity]` and observe a client-side `ValidationError` with `field: "vector"`, not a wire-level 400 round-trip. |
| 5 | Construct a `SeedClient` with `endpoints: "https://côgnitum.local:8443/"` (UTF-8 hostname) and confirm it normalises to IDNA-punycode in the peer key (`xn--cgnitum-w2a.local`) — or raises a typed error. |
| 6 | Parse a `Retry-After: 2.5` header (fractional seconds); confirm the retry delay is 2500ms, not 2000 or 3000. |
| 7 | Parse a seed body containing `retry_after_us: 1500000` together with a `Retry-After: 1` header; observe the body wins (1500ms, not 1000ms) per ADR-0005 §"body wins over header". |
| 8 | Submit `store.query` with `vector` containing denormal floats (e.g. `5e-324`); observe they serialise losslessly through JSON (Node's `JSON.stringify` preserves them; confirm Python and Rust do the same). |
| 9 | Drive `TokenBook.set` with a URL-shape-equivalent-but-non-normalised peer key (`https://host:8443/`, trailing slash); observe `get("https://host:8443")` returns the same token (normalisation is canonical). |
| 10 | Ingest a custody record containing a non-UTF-8 byte string via `store.ingest`; observe a typed `ParseError { expected: "utf-8" }` from the SDK, not a reqwest/httpx low-level error. |

### Interfaces

| # | Test idea |
|---|-----------|
| 1 | Drive the Node `cognitum` CLI with `--help`, confirm output lists commands (`health`, `catalog`, `mcp`, …) and exits 1 when no command given. |
| 2 | Invoke `cognitum health` with no credentials and verify the error message includes the string `COGNITUM_API_KEY`. |
| 3 | Construct a Python `AsyncSeedClient` and a sync `SeedClient` against the same mock; confirm `.status()` returns structurally identical dataclasses (same fields, same values). |
| 4 | Import `cognitum-rs` without `features = ["seed"]` and attempt to construct `cognitum::seed::SeedClient`; observe a compile error (not a runtime surprise). |
| 5 | Launch an `McpClient(StdioTransport)` from Node, Python, and Rust in sequence against the same binary; confirm all three frame JSON-RPC identically (byte-for-byte compare of the first `initialize` message). |
| 6 | Import the TypeScript declarations of `@cognitum/sdk/seed` into a strict-mode TS 5.4 project; observe no `any` leaks in the public surface (all exports fully typed). |
| 7 | Construct a `SeedClient` with `fetch:` injected as a vitest mock; assert the injected fn is called verbatim (not re-wrapped) so test assertions on URL/headers remain stable. |
| 8 | Invoke `cognitum health --json` and confirm the output is parseable as JSON (no banner, no extra whitespace). |

### Platform

| # | Test idea |
|---|-----------|
| 1 | Run the full `vitest run` suite on Node 18.x, 20.x, and 22.x; confirm zero failures on each. |
| 2 | Run `pytest` on Python 3.10, 3.11, 3.12, 3.13; confirm the lazy `__getattr__` path works on 3.10 (PEP 562 lands in 3.7 so it's safe, but verify). |
| 3 | Compile `cognitum-rs` on the stated MSRV with `--features seed`; confirm no `#[feature]` surprises. Cargo.toml lacks `rust-version` today (gap — add it). |
| 4 | Launch `cognitum-rs` test suite on `aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`, and `x86_64-pc-windows-msvc`; confirm the mDNS feature compiles on all three. |
| 5 | Start the Node SDK inside a 50MB Alpine container; measure RSS after `import + first status()` < 80MB. |
| 6 | Run the Python SDK inside an AWS Lambda `python3.11` cold start; confirm import + client construction < 500ms. |
| 7 | Run the Rust SDK inside a `scratch` container with musl-linked binary; confirm no dynamic-library surprises from `rustls`. |
| 8 | Compile the Node SDK target to a worker (`--target node18` + `cloudflare:workers` shim) — note this is not claimed to work, but observe which specific import breaks (undici) so the README can say so. |

### Operations

| # | Test idea |
|---|-----------|
| 1 | Start a `SeedClient` with `healthInterval: 5000`; SIGTERM the process; confirm the background probe stops and the process exits within 500ms (no hang from stuck keepalive). |
| 2 | Run a long-lived `SeedClient` against 3 peers, then kill peer-2 mid-request; observe the failover log line names the reason (e.g. `"NetworkError"`) and the successor peer. |
| 3 | Tail stderr while running a test with `insecure: true`; assert the warning appears at least once per process. **Also** assert that subsequent requests do NOT emit additional warnings (one-shot is current behaviour; if ADR-0007 is ever enforced, flip this test). |
| 4 | Grep a full debug-log dump of a test run for the literal pairing token from `pair.create`; confirm zero matches. |
| 5 | Run the Python `SeedClient` for 30 minutes with `healthInterval: 1000`; confirm memory does not grow more than 2MB (no leak from unref'd timers or lingering aiohttp sessions). |
| 6 | Enumerate the metrics surface: today there is no metrics emission hook. Document the gap and propose a spec (Prometheus counters? OTLP? hook API?) — a test idea in itself: "confirm that a caller-supplied logger receives at least N structured records per seed call". |
| 7 | Drive a failover where peer-A → 503, peer-B → 503, peer-C → 200; observe total wall-clock under 60s (ADR-0005 budget) and that the log for each attempt names the peer. |
| 8 | Call `client.close()` mid-flight (an in-flight `store.query`); confirm the pending promise rejects with a deterministic `NetworkError` (not a silent hang). |

### Time

| # | Test idea |
|---|-----------|
| 1 | Inject a clock that advances only on demand; start a retry loop with a 60s budget; confirm the retry terminates **exactly** when elapsed ≥ 60s, regardless of how many transient 503s the server produces. |
| 2 | Serve a `Retry-After` header where the HTTP-date is 30s in the past (clock skew); observe the SDK treats it as 0ms delay (clamp-to-now) rather than a negative. |
| 3 | Advance a paused mDNS TTL clock past expiry; call `client.rediscover()`; observe a fresh `_cognitum._tcp.local` query is issued rather than returning stale peers. |
| 4 | Configure a 10s `healthInterval` + 100ms `probeTimeoutMs`; run for 5 minutes with a peer that never accepts connections; observe probe errors arrive at 10s cadence (not tighter), and the peer reaches `Unhealthy` state within 3 probe cycles. |
| 5 | With a session-sticky read pinned to peer-B, wait 2 hours; confirm the session handle still routes to B (no implicit TTL expiring it silently). |
| 6 | Set `timeouts: { connect: 100, read: 200, total: 500 }` and call against an unreachable seed; observe a `TimeoutError { phase: "connect" }` at ~100ms, not ~500. |
| 7 | Run 1000 parallel `store.query` calls with randomised per-call `timeoutMs`; confirm each honours its own override independent of the client-wide default. |
| 8 | Against a `TailscaleDiscovery` provider, pause the `tailscale status` daemon; confirm `client.rediscover()` surfaces a `NetworkError` with a pointer at the tailscale binary, not a hang. |

---

## Part C — Oracle problems

Situations where the SDK's "right answer" is ambiguous — you can't test them against a single reference.

### C1. Did failover pick the *right* peer, or just *a* peer?

- **Problem.** With 3 peers, all healthy, a client-wide EMA latency map, and a session-stick, the failover pick after peer-A's 503 could reasonably be B or C. The spec says "closest-first by EMA" but EMAs converge at similar values under load.
- **Why hard.** No single "correct" peer exists without a ground-truth RTT. Network conditions vary between the time the SDK last measured and the time it picks.
- **Proposed oracle.**
  - **Consistency check:** over N=1000 failovers in a controlled jig where one peer is artificially 50ms slower, the picker chooses the faster peer at least P(99%). Any deviation is a bug.
  - **Metamorphic relation:** swap the two peers' URLs, rerun the same workload, observe the pick also swaps. If it doesn't, the picker depends on URL ordering and not latency — a regression.

### C2. Did `pair.create` actually pair, or did it *look* like it paired?

- **Problem.** `pair.create` returns `{ paired: true, token: <SecretString>, client_name }`. The SDK has no way to verify the token *works* without a second call, and `paired: true` is just the seed's self-report.
- **Why hard.** The *proof* of pairing is the seed accepting a subsequent `X-Pairing-Token`. The SDK can't prove it in-band without making a second call — which might succeed for a different reason (e.g. an old cached token on the seed).
- **Proposed oracle.**
  - **Reference model:** after `pair.create`, the SDK issues one tagged no-op paired write (e.g. `POST /api/v1/store/query` with an empty vector filter) using ONLY the just-returned token. If it succeeds with 200, pairing is verified. Surface as `SeedClient.verifyPairing(token)`.
  - **Consistency check:** `GET /api/v1/pair/status` after a successful pair MUST show `paired: true` with `client_count` incremented by one. Run before + after; diff.

### C3. Is the redaction complete, or are we redacting only the obvious path?

- **Problem.** `SecretString` redacts `toString`, `toJSON`, `repr`, `Debug`. But a token could still leak via: `structuredClone`, V8 heap dump, a test fixture that spreads the object (`{ ...response }`), a third-party serialiser that calls its own `serialize()`.
- **Why hard.** We can only disprove leakage by enumerating serialisers, and new ones arrive constantly.
- **Proposed oracle.**
  - **Metamorphic relation:** for every `PairCreateResponse` created in the test suite, assert the raw token byte-string does not appear anywhere in the process's stdout/stderr AND in any `fs.writeFile` buffer invoked before the test teardown. This is a grep-based oracle that survives serialiser churn.
  - **Differential test:** Node, Python, Rust each print a fresh `pair.create` response to stderr N=100 times. The literal token bytes must appear zero times in the concatenated output. If one SDK leaks and the others don't, we have a regression.

### C4. Did the retry loop honour the 60s budget, or did it blow through because of a clock read?

- **Problem.** ADR-0005 says "60s wall-clock ceiling". Each SDK reads wall-clock via `Date.now()` / `time.monotonic()` / `Instant::now()`. Under heavy GC or a frozen laptop lid, a single `Date.now()` read could jump by minutes.
- **Why hard.** You can't tell from a passing retry-loop test whether the clock behaved — only that the loop terminated.
- **Proposed oracle.**
  - **Consistency check:** inject a test-only clock that records every read. After a retry loop, assert: (a) the budget check reads the clock between attempts, (b) the total elapsed computed from the injected clock ≤ budget + 1 attempt worth of RTT. Use `monotonic` explicitly in Python + Rust (Python's `time.monotonic()` is already in `_retry.py`; Node uses `Date.now()` — a potential bug if the user's clock drifts backwards mid-loop).
  - **Fuzz oracle:** generate retry scenarios with injected clock jumps of {-1h, -1min, +1s, +1h}. Assert the loop never retries *fewer* times than the minimum-guaranteed count (so clock jumps cannot starve the caller).

### C5. Did the SDK pick the *right* TLS posture, or did it silently downgrade?

- **Problem.** A client constructed with `tls: { insecure: true }` and then handed an mDNS-discovered peer with a `fp=sha256:<hex>` TXT record will *pin* (per the ADR — fingerprint pin wins over `insecure`). But nothing forces the SDK to log *which* posture it used. A bug that silently dropped the fingerprint pin would look identical to the insecure path from the user's side.
- **Why hard.** The right observable is "what TLS code path executed", which is internal. We can only observe it indirectly (handshake succeeds with a different server cert than advertised → we're insecure; fails → we pinned).
- **Proposed oracle.**
  - **Differential test:** construct two peers with the same hostname and different self-signed certs. Only peer-A's cert fingerprint matches the mDNS advertisement. Request `status()` against each. The pinned code path MUST reject peer-B (even if peer-A's cert is also self-signed and `insecure: true` would have accepted both). If both succeed → the pin was silently bypassed.
  - **Reference model:** expose `client.tlsPolicy(peerKey) → { mode: "pinned-fp" | "pinned-ca" | "system" | "insecure" }` so tests can assert the posture without relying on handshake side-effects. Today this information is buried; surfacing it makes the oracle problem cheap to solve.

---

## Top-5 prioritised DX improvements for 0.3.0

Priority reflects severity × user-visibility × fix effort.

### 1. Close the env-var gap in Python + Rust (Severity H, fix ~1 day)

Both SDKs advertise `COGNITUM_API_KEY` and `COGNITUM_SEED_TOKEN` fallback but neither reads them. Add `os.environ.get(…)` / `std::env::var(…)` in the resolution path. Match Node's error message verbatim. Add a conformance test row. **This is a documented feature that does not work** — the single biggest trust-eroding DX bug in v0.2.0.

### 2. Trim (or honour) the "71 endpoints" claim (Severity H, fix ~2 hours)

Root README overstates the surface by ~4.5×. Either ship the missing resource groups (sensor, coherence, thermal, delivery — which would be a v1.0 undertaking) or rewrite the feature table to show what's actually there (12 phase-1 + 4 mesh observability = 16) with a roadmap column for what's coming. Also remove `pair.window` from the code listing — it doesn't exist in any SDK.

### 3. Ship the "runnable multi-seed + discovery" README snippet (Severity M, fix ~3 hours)

Every SDK README gets three executable snippets: single-seed, multi-seed (explicit list), discovery-driven. Add a knob-reference table. A developer looking at the Python README today cannot tell that mesh routing exists without reading ADR-0016a.

### 4. Close the Rust error-taxonomy gap (Severity M, fix ~1 day)

`src/error.rs` has 7 variants; ADR-0004 specifies 12. The `seed::Error` module already has most of them — promote to crate root with `#[non_exhaustive]` so callers pattern-matching on `Error` can handle every documented case. Node and Python already conform.

### 5. Guard insecure-mode against non-loopback hosts + add structured log at request time (Severity H, fix ~half-day)

If a user ships `insecure: true` pointing at a non-loopback / non-`.local` / non-link-local host, either (a) refuse at construction (default), or (b) require an explicit `allowInsecureNonLoopback: true`. At request time, emit a structured record on every call in insecure mode (not just a one-shot stderr warning). This closes the "shipped dev mode to prod and nobody noticed" footgun and brings the impl in line with ADR-0007 §TLS.

### Runner-up (bump to top-5 if bandwidth allows)

Rename `@cognitum/sdk` CLI `VERSION = "0.1.2"` → `0.2.0`. Two-minute fix; it's a trust signal on first run.

---

## File trail (everything referenced)

- Source: `sdks/{node,python,rust}/src/**`, `sdks/python/cognitum/**`
- Errors: `src/errors.ts`, `cognitum/_errors.py`, `src/error.rs`, plus `src/seed/error.rs` (Rust)
- Config resolution: `src/seed/config.ts:230-270`, `src/client.ts:247-256`, `cognitum/seed/_config.py:60-180`, `src/client.rs:1-240`
- Redaction: `src/seed/tokenBook.ts:24-63`, `cognitum/seed/_token_book.py:17-71`, `src/seed/token_book.rs:24-108`
- TLS / insecure: `src/seed/transport.ts:30-123`, `cognitum/seed/_transport.py:25-180`, `src/client.rs:215-240`
- ADRs: `docs/adr/0003-cross-cutting-auth-model.md` (env-var spec), `docs/adr/0004-cross-cutting-error-taxonomy.md`, `docs/adr/0005-cross-cutting-retry-backoff.md`, `docs/adr/0007-cross-cutting-security-model.md`
- CHANGELOG: `CHANGELOG.md` v0.2.0 2026-04-23.
