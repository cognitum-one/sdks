# Changelog — @cognitum-one/sdk

Format: [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/).
This package follows [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-07-19

Cognitum Agentic SDK Integration — new product clients on top of the
shared `agentic` subpath export (credential providers, error taxonomy,
retry/idempotency, capability sets, telemetry primitives). See the
[root CHANGELOG](../../CHANGELOG.md) for the full cross-SDK picture
and `docs/adr/` for governing ADRs.

### Added

- **`@cognitum-one/sdk/agentic`** — `CredentialProvider` /
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
- **`@cognitum-one/sdk/meta-llm`** — `MetaLlmClient` against the real
  Meta LLM serving surface: `chat.completions`, `messages.create`/
  `countTokens`, legacy `completions`, `responses`, `embeddings`, all
  with idempotency-key retry and the full error-mapping table
  (ADR-0024a). Streaming for both `chat.completionsStream` (OpenAI-
  style SSE) and `messages.createStream` (native Anthropic event
  types) on a shared protocol-agnostic SSE parser. Routing controls
  and read-only usage/receipt access (ADR-0024b §D11 step 1).
- **`@cognitum-one/sdk/meta-proxy`** — `MetaProxyClient` data-plane
  (status/capabilities/routing intent), non-streaming and streaming
  `chat.completions` forwarding, consent gating for the
  `cognitum_cloud` routing plane, browser-runtime rejection guard
  (ADR-0025a). Sponsor/budget operations remain fail-closed stubs
  pending ADR-0025b (not started).
- **`@cognitum-one/sdk/metaharness`** — `MetaHarnessClient`
  construction and the full §D2 method surface, all fail-closed by
  design: the upstream OSS `metaharness` bridge protocol this client
  would talk to does not exist yet (ADR-0026a §D7, 7 explicit
  blockers). Ships now so the shape is visible; no operation performs
  real I/O.
- **`@cognitum-one/sdk/harnessaas`** — `HarnessaaSClient` scoped to
  the real, deployed synchronous surface (`health`/`solve`/`lineage`)
  rather than ADR-0027a's proposed-but-unbuilt async job/poll/SSE
  contract. Vertical-support capability gate on `solve()` (only
  `code-repair` fully modeled).

### Notes

- Every new subpath export is additive; the existing `/seed` and root
  exports are unaffected.
- No breaking changes.

## [0.2.0] — 2026-04-23

Aligned release across the Cognitum SDK monorepo. See the
[root CHANGELOG](../../CHANGELOG.md) for the full cross-SDK picture.

### Added

- **Phase 1 seed client** — 12 typed endpoints: `status`, `identity`,
  `pair.{status,create,delete,window}`, `witness.chain`,
  `custody.epoch`, `store.{status,query,ingest}`, `ota.{config,checkNow}`.
  See [ADR-0015a §"Phase 1 delivery (2026-04-22)"](docs/adr/0015a-node-sdk-implementation.md).
- **Phase 1.5 mesh routing** — `PeerSet`, `TokenBook`, `SeedSession`,
  health probe, closest-first selection, cycle-on-5xx failover, pin-on-429.
  See [ADR-0015c §"Phase 1.5 delivery (2026-04-23)"](docs/adr/0015c-node-sdk-implementation.md).
- **Phase 2 observability + knobs** — `src/seed/resources/mesh.ts`
  (`status` / `peers` / `swarmStatus` / `clusterHealth`),
  `src/seed/callOptions.ts` with
  `peer? / prefer? / consistency? / timeoutMs? / retries? / signal? / idempotent?`,
  `client.rediscover()`.
  See [ADR-0015c §"Phase 2 delivery (2026-04-23)"](docs/adr/0015c-node-sdk-implementation.md).
- **Phase 3 discovery** — `ExplicitDiscovery`, `MdnsDiscovery`
  (subpath export `@cognitum-one/sdk/seed/discovery/mdns`, peer dep on
  `multicast-dns`), `TailscaleDiscovery`. Per-peer
  `fp=sha256:<hex>` TLS cert pinning.
  See [ADR-0015c §"Phase 3 — mDNS discovery (2026-04-23)"](docs/adr/0015c-node-sdk-implementation.md).
- **`README.md`, `LICENSE`, `CHANGELOG.md`** shipped in the npm tarball.

### Changed

- **Auth header canonicalised to `X-API-Key`** — dropped `Bearer`
  ([#10](https://github.com/cognitum-one/sdks/issues/10)).
- **Phase 1 wire-shape fixes** to match the live seed
  ([#12](https://github.com/cognitum-one/sdks/issues/12),
  [#13](https://github.com/cognitum-one/sdks/issues/13),
  [#14](https://github.com/cognitum-one/sdks/issues/14)).
- **ADR-0005 retry compliance** on POST — auto-retry is opt-in via
  `idempotent: true`; Retry-After body wins over header
  ([#5](https://github.com/cognitum-one/sdks/issues/5),
  [#11](https://github.com/cognitum-one/sdks/issues/11)).
- **Files allowlist** now includes `README.md`, `LICENSE`, and
  `CHANGELOG.md` so the npm tarball is self-contained.

### Fixed

- **Hot-path overhead** — cached `undici.Agent`, reduced per-call
  header allocation; ~50% p50 delta reduction vs raw `fetch`
  ([#24](https://github.com/cognitum-one/sdks/issues/24)).

### Security

- **No more process-wide TLS disable** — replaced
  `NODE_TLS_REJECT_UNAUTHORIZED=0` with a scoped `undici.Agent` so
  `tls.insecure = true` is confined to this client
  ([#18](https://github.com/cognitum-one/sdks/issues/18)).
- **Redacting `SecretString`** around pairing tokens and
  `PairCreateResponse.token`; `console.log` never leaks raw tokens
  ([#21](https://github.com/cognitum-one/sdks/issues/21)).
- **Trust-score 3-strike cutoff** — 3rd consecutive 401/403 on a peer
  raises `TrustScoreBlockedError`
  ([#16](https://github.com/cognitum-one/sdks/issues/16)).
- **mDNS `fp=sha256:<hex>` pinning** at the TLS handshake; mismatch
  is a hard `TlsPinError` and never falls back to insecure.

### Verified

- `npm test` → 201 pass / 1 pre-existing unrelated fail
- Live: Node 7/9 Phase 1 endpoints, 3/3 mesh cycle, 10/10 Phase 2+3 matrix

## [0.1.3] — pre-alignment

Unpublished patch increments during the cross-SDK parity push. Superseded
by 0.2.0.
