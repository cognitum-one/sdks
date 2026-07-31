# Changelog — cognitum-rs

Format: [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/).
This crate follows [Semantic Versioning](https://semver.org/).

## [Unreleased]


### Added

- Cross-language error-mapping conformance corpus
  (`sdks/fixtures/error-mapping/`) driven by all three SDK suites, and an
  RFC 9110 `Retry-After` parser shared across them (issue #75, ADR-0030a §D1).

### Fixed

- `Retry-After` accepts an HTTP-date as well as delta-seconds (RFC 9110
  §10.2.3). Previously Node computed `NaN` (a NaN backoff fires immediately),
  Python raised an uncaught `ValueError` **while mapping an error**, Rust's
  non-streaming path parsed only seconds, and Rust's streaming paths never
  read the header at all -- so a rate-limited gateway was retried differently,
  and too soon, depending on which SDK you used. A malformed value now falls
  back to local retry policy rather than becoming a zero delay.
- **Compatibility:** a hint above 24h is now clamped to 24h rather than
  surfaced verbatim, and `Retry-After: 30.5` is rejected rather than coerced
  (RFC 9110 defines delta-seconds as `1*DIGIT`). Both change a caller-visible
  `retryAfterMs` and the telemetry derived from it. Only strict IMF-fixdate is
  accepted for the date form -- `UTC` for `GMT`, lowercase names, trailing
  junk, leap seconds and impossible dates like `31 Feb` are all rejected,
  because each platform's own date parser accepted a different subset of them
  and that is precisely how the three SDKs came to disagree.
### Added

- `upgrade_required` error kind, and an `upgrade` field on the common error
  shape carrying the server's affordance: `required_tier`, `held_tier`,
  `required_scope`, `upgrade_url`, and an optional `retry_with` hint
  (issue #128, ADR-0023 §D1).

### Changed

- 402 responses carrying `code: "upgrade_required"` now map to
  `upgrade_required` rather than `budget_exceeded`. The affordance is surfaced
  but never acted on -- the error stays non-retryable, because downgrading a
  caller's request to a cheaper tier is their decision, not the SDK's. Budget
  402s and unrecognised 402 codes still map to `budget_exceeded`.
- Every 402 now populates `code` from the response body, budget ones included.
  It was previously always absent. Callers using `code == null` to tell an SDK
  status mapping apart from a structured service error will see a value where
  they saw none.


## [0.3.0] — 2026-07-19

Cognitum Agentic SDK Integration — new product clients on top of the
shared `agentic` module (credential providers, error taxonomy, retry/
idempotency, capability sets, telemetry primitives). See the
[root CHANGELOG](../../CHANGELOG.md) for the full cross-SDK picture
and `docs/adr/` for governing ADRs.

### Added

- **`agentic` module** (unconditional base) — `CredentialProvider` /
  `StaticApiKeyCredentialProvider` / `OAuthTokenCredentialProvider`
  with origin/audience/product binding and scope preflight (ADR-0022),
  the shared error taxonomy with equal-jitter retry and idempotency
  binding (ADR-0023), `ExecutionReceipt`/`LineageReference` with real
  HMAC-SHA256 verification across a 5-level shape/digest/cryptographic/
  anchored ladder (ADR-0028 §D7-D9), the `SentinelSecretRedactor`
  bounded-depth secret scanner (§D13), and — new this release — a
  `TelemetrySink` interface with a functional no-op default, W3C
  `traceparent`/`tracestate` parse/generate/join primitives, an event/
  metric-name catalog, and a `DiagnosticPolicy`/manifest-preview API
  with a policy-independent hard block on credential/signed-URL
  capture (§D1-D4, §D10). **No product client wires telemetry
  emission yet** — this is frozen scaffolding, not an active pipeline.
- **`meta-llm` feature** — `MetaLlmClient` against the real Meta LLM
  serving surface: `chat.completions`, `messages.create`/
  `countTokens`, legacy `completions`, `responses`, `embeddings`, all
  with idempotency-key retry and the full error-mapping table
  (ADR-0024a). Streaming for both `chat.completions` (OpenAI-style SSE)
  and `messages.create` (native Anthropic event types) on a shared
  protocol-agnostic SSE parser. Routing controls and read-only
  usage/receipt access (ADR-0024b §D11 step 1).
- **`meta-proxy` feature** — `MetaProxyClient` data-plane (status/
  capabilities/routing intent), non-streaming and streaming
  `chat.completions` forwarding, consent gating for the
  `cognitum_cloud` routing plane, browser-runtime rejection guard
  (ADR-0025a). Sponsor/budget operations remain fail-closed stubs
  pending ADR-0025b (not started).
- **`metaharness` feature** — `MetaHarnessClient` construction and the
  full §D2 method surface, all fail-closed by design: the upstream OSS
  `metaharness` bridge protocol this client would talk to does not
  exist yet (ADR-0026a §D7, 7 explicit blockers). Ships now so the
  shape is visible; no operation performs real I/O.
- **`harnessaas` feature** — `HarnessaaSClient` scoped to the real,
  deployed synchronous surface (`health`/`solve`/`lineage`) rather
  than ADR-0027a's proposed-but-unbuilt async job/poll/SSE contract.
  Vertical-support capability gate on `solve()` (only `code-repair`
  fully modeled).

### Notes

- Every new feature is additive and independently gated behind its own
  Cargo feature (`meta-llm`, `meta-proxy`, `metaharness`, `harnessaas`)
  — enabling `seed` alone is unaffected.
- No breaking changes to the existing `seed` surface.

## [0.2.0] — 2026-04-23

Aligned release across the Cognitum SDK monorepo. See the
[root CHANGELOG](../../CHANGELOG.md) for the full cross-SDK picture.

### Added

- **Phase 1 seed client** (under `feature = "seed"`) — 12 typed endpoints
  on the `SeedClient`: `status`, `identity`, `pair().{status,create,delete,window}`,
  `witness().chain`, `custody().epoch`, `store().{status,query,ingest}`,
  `ota().{config,check_now}`.
  See [ADR-0014a §"Phase 1 delivery (2026-04-22)"](docs/adr/0014a-rust-sdk-implementation-foundations.md).
- **Phase 1.5 mesh routing** — `PeerSet`, `TokenBook`, `SeedSession`,
  async health probe, closest-first selection, cycle-on-5xx failover,
  pin-on-429.
  See [ADR-0014c §"Phase 1.5 delivery (2026-04-22)"](docs/adr/0014c-rust-sdk-implementation-release.md).
- **Phase 2 observability + knobs** — `client.mesh().{status,peers,swarm_status,cluster_health}`,
  a typed `CallOptions` builder with `peer` / `prefer` / `consistency` /
  `timeout` / `retries` / `idempotent` threaded through every resource
  method, `client.rediscover()`.
- **Phase 3 discovery** — `ExplicitDiscovery`, `MdnsDiscovery` (opt-in
  `feature = "mdns"` → `seed` + `mdns-sd`), `TailscaleDiscovery`. Per-peer
  `fp=sha256:<hex>` TLS cert pinning via a custom rustls
  `ServerCertVerifier` (`src/seed/tls_pin.rs`).
- **MCP stdio transport** — matched Node's existing stdio transport.
  `tokio::process`-backed MCP server subprocess with JSON-over-stdin/stdout
  framing (`src/mcp/stdio.rs`) (OQ-4).
- **`readme = "README.md"`** declared in `Cargo.toml` so crates.io renders
  the quick-start; explicit `include = [...]` allowlist so the crate
  tarball is clean.
- **`README.md`, `LICENSE`, `CHANGELOG.md`** shipped in the crate.

### Changed

- **`repository`** pointer moved to `cognitum-one/sdks` (canonical).
- **`documentation`** pointer moved to `docs.rs/cognitum-one`.
- **Auth** — `X-API-Key` is canonical; `Bearer` continues to forward
  behind a 2-minor-release deprecation window per
  [#10](https://github.com/cognitum-one/sdks/issues/10) and
  [ADR-0014c §"release"](docs/adr/0014c-rust-sdk-implementation-release.md).
- **ADR-0005 retry compliance** — equal-jitter backoff, 500 ms base,
  30 s cap, 60 s wall-clock; POST auto-retry only on opt-in
  `idempotent = true`; Retry-After body wins over header
  ([#7](https://github.com/cognitum-one/sdks/issues/7),
  [#11](https://github.com/cognitum-one/sdks/issues/11)).

### Fixed

- **Retried-POST CPU path** — 3.01× speedup via a serialize-once refactor
  ([#23](https://github.com/cognitum-one/sdks/issues/23)).
- **Jitter RNG** — `xorshift64*` replaces the modulo-biased
  `SystemTime.nanos` source
  ([#22](https://github.com/cognitum-one/sdks/issues/22)).
- **Debug-print token leak** — `SecretString` redacts pairing tokens
  from `{:?}` output
  ([#19](https://github.com/cognitum-one/sdks/issues/19)).

### Security

- **Redacting `SecretString`** around pairing tokens and
  `PairCreateResponse.token`; `Debug` / `Display` never leak raw value
  ([#21](https://github.com/cognitum-one/sdks/issues/21)).
- **Trust-score 3-strike cutoff** per-peer
  ([#16](https://github.com/cognitum-one/sdks/issues/16)).
- **mDNS `fp=sha256:<hex>` pinning** at the rustls handshake via
  `FingerprintPinVerifier`; mismatch is a hard `TlsPinError` and never
  falls back to insecure.

### Deprecated

- `Bearer` auth header — use `X-API-Key`. Forwarding continues for
  two minor releases.

### Verified

- `cargo test --features seed` → 84 lib + 23 client + 10 seed-integration
  suites green; 2 pre-existing cloud-PEM failures remain (out of scope)
- Live: Rust 9/9 Phase 1 endpoints, 3/3 mesh cycle, 10/10 Phase 2+3 matrix

## [0.1.0] — pre-alignment

Initial cloud + seed alpha. Superseded by 0.2.0.
