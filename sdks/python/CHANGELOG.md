# Changelog — cognitum (Python)

Format: [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/).
This package follows [Semantic Versioning](https://semver.org/).

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
