# Changelog — cognitum (Python)

Format: [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/).
This package follows [Semantic Versioning](https://semver.org/).

## [0.4.0] — 2026-07-31

Fixes a defect that made the published Python and Rust SDKs unusable against
`api.cognitum.one`, and lands the error-taxonomy and `Retry-After` work that
accumulated behind it. **Minor, not patch:** several changes below are
observable to a caller, and one widens a TypeScript union.



### Added

- Cross-language request-body conformance corpus (`sdks/fixtures/wire/`),
  driven by all three SDK suites (issue #75, ADR-0030a §D1 Wire layer).

### Fixed

- **Request bodies no longer send `null` for optional fields the caller did
  not set.** They are now omitted, matching the wire contract. The published
  Python and Rust SDKs could not make a basic chat completion against
  `api.cognitum.one` because of this: `{"n": null}` returned
  `HTTP 400 Only n=1 is supported in v1.`, and `messages[].name: null`
  returned `HTTP 400 messages[0].name must be a string, got null.` Fixed and
  verified against production in both languages. Affects every request type,
  not only chat completions.
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
shared `cognitum.agentic` module (credential providers, error
taxonomy, retry/idempotency, capability sets, telemetry primitives).
See the [root CHANGELOG](../../CHANGELOG.md) for the full cross-SDK
picture and `docs/adr/` for governing ADRs.

### Added

- **`cognitum.agentic`** — `CredentialProvider` /
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
- **`cognitum.meta_llm`** — `MetaLlmClient` against the real Meta LLM
  serving surface: `chat.completions`, `messages.create`/
  `count_tokens`, legacy `completions`, `responses`, `embeddings`, all
  with idempotency-key retry and the full error-mapping table
  (ADR-0024a). Streaming for both `chat.completions_stream` (OpenAI-
  style SSE) and `messages.create_stream` (native Anthropic event
  types) on a shared protocol-agnostic SSE parser. Routing controls
  and read-only usage/receipt access (ADR-0024b §D11 step 1).
- **`cognitum.meta_proxy`** — `MetaProxyClient` data-plane (status/
  capabilities/routing intent), non-streaming and streaming
  `chat.completions` forwarding, consent gating for the
  `cognitum_cloud` routing plane, browser-runtime rejection guard
  (ADR-0025a). Sponsor/budget operations remain fail-closed stubs
  pending ADR-0025b (not started).
- **`cognitum.metaharness`** — `MetaHarnessClient` construction and
  the full §D2 method surface, all fail-closed by design: the
  upstream OSS `metaharness` bridge protocol this client would talk to
  does not exist yet (ADR-0026a §D7, 7 explicit blockers). Ships now
  so the shape is visible; no operation performs real I/O.
- **`cognitum.harnessaas`** — `HarnessaaSClient` scoped to the real,
  deployed synchronous surface (`health`/`solve`/`lineage`) rather
  than ADR-0027a's proposed-but-unbuilt async job/poll/SSE contract.
  Vertical-support capability gate on `solve()` (only `code-repair`
  fully modeled).

### Notes

- Every new submodule is additive; the existing `cognitum.seed`
  surface is unaffected. No breaking changes.
- This release is published as PyPI project `cognitum-sdk` (the Python
  *import* name stays `cognitum` — `from cognitum import Cognitum`
  still works unchanged) — see the root CHANGELOG for why.

## [0.2.0] — 2026-04-23

Aligned release across the Cognitum SDK monorepo. See the
[root CHANGELOG](../../CHANGELOG.md) for the full cross-SDK picture.

### Added

- **Phase 1 seed client** (sync `SeedClient` + `AsyncSeedClient`) — 12
  typed endpoints: `status`, `identity`, `pair.{status,create,delete,window}`,
  `witness.chain`, `custody.epoch`, `store.{status,query,ingest}`,
  `ota.{config,checkNow}`.
  See [ADR-0013a §"Phase 1 delivery (2026-04-22)"](docs/adr/0013a-python-sdk-module-layout-and-api.md).
- **Phase 1.5 mesh routing** — `PeerSet`, `TokenBook`, `SeedSession`,
  health probe, closest-first, cycle-on-5xx, pin-on-429.
  See [ADR-0013c §"Phase 1.5 delivery (2026-04-23)"](docs/adr/0013c-python-sdk-streaming-tests-packaging-migration.md).
- **Phase 2 observability + knobs** — `client.mesh.{status,peers,swarm_status,cluster_health}`,
  `CallOptions(peer=, prefer=, consistency=, timeout=, retries=, idempotent=)`
  accepted on every resource method, `client.rediscover()`.
  See [ADR-0013c §"Phase 2 delivery (2026-04-23)"](docs/adr/0013c-python-sdk-streaming-tests-packaging-migration.md).
- **Phase 3 discovery** — `ExplicitDiscovery`, `MdnsDiscovery` (opt-in
  extra: `pip install cognitum[mdns]`), `TailscaleDiscovery`. Per-peer
  `fp=sha256:<hex>` TLS cert pinning.
  See [ADR-0013c §"Phase 3 — mDNS discovery (2026-04-23)"](docs/adr/0013c-python-sdk-streaming-tests-packaging-migration.md).
- **MCP stdio transport** — matched Node's existing stdio transport so
  Python can launch a local MCP server subprocess and frame JSON over
  its stdin/stdout (OQ-4).
- **`README.md`, `LICENSE`, `CHANGELOG.md`** shipped in the sdist and wheel.

### Changed

- **Auth header canonicalised to `X-API-Key`** — dropped `Bearer`
  ([#10](https://github.com/cognitum-one/sdks/issues/10)).
- **Phase 1 wire-shape fixes** to match the live seed
  ([#12](https://github.com/cognitum-one/sdks/issues/12),
  [#13](https://github.com/cognitum-one/sdks/issues/13),
  [#14](https://github.com/cognitum-one/sdks/issues/14)).
- **ADR-0005 retry compliance** — equal-jitter backoff, 500 ms base,
  30 s cap, 60 s wall-clock; `Retry-After` body wins over header; POST
  auto-retry only on opt-in `idempotent=True`
  ([#6](https://github.com/cognitum-one/sdks/issues/6),
  [#11](https://github.com/cognitum-one/sdks/issues/11)).

### Fixed

- **Cold-start** — ~12 ms reclaimed via PEP 562 lazy `__getattr__`;
  `import cognitum.seed` no longer eagerly pulls the cloud module
  graph ([#20](https://github.com/cognitum-one/sdks/issues/20)).

### Security

- **`localhost` no longer auto-insecure** — callers must now opt into
  `SeedTLS(insecure=True)` explicitly, closing an audit finding that
  could have enabled MITM inside a shared host
  ([#17](https://github.com/cognitum-one/sdks/issues/17)).
- **Redacting `SecretString`** wraps pairing tokens and
  `PairCreateResponse.token`; `repr()` and `str()` never leak the raw
  value ([#21](https://github.com/cognitum-one/sdks/issues/21)).
- **Trust-score 3-strike cutoff** per-peer
  ([#16](https://github.com/cognitum-one/sdks/issues/16)).
- **mDNS `fp=sha256:<hex>` pinning** at the TLS handshake; mismatch
  is a hard `TlsPinError`.

### Verified

- `pytest` → 274 pass / 3 skip
- Live: Python 9/9 Phase 1 endpoints, 3/3 mesh cycle, 10/10 Phase 2+3 matrix

## [0.1.0] — pre-alignment

Initial seed-client alpha. Superseded by 0.2.0.
