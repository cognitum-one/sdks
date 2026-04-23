# Changelog — @cognitum/sdk

Format: [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/).
This package follows [Semantic Versioning](https://semver.org/).

## [0.2.1] — 2026-04-23

Security patch release. No functional changes — fixes two findings
from the 0.2.0 post-release QE audit (`docs/qe/security-audit.md`).
See the [root CHANGELOG](../../../CHANGELOG.md) for the full
cross-SDK picture.

### Security

- **C1 — `fp=` length bounds `[16, 64]` hex.** `parseFingerprint`
  (`src/seed/discovery/mdns.ts`) and `matchFingerprint`
  (`src/seed/transport.ts`) previously accepted any even-length hex.
  An attacker advertising `fp=ab` via mDNS could match 1/256 of any
  self-signed cert because the transport layer uses `startsWith`
  against the actual SHA-256. The floor is now 16 hex (8 bytes,
  matching the seed firmware's truncated TXT form per
  `seed/src/cognitum-agent/src/discovery.rs:162`); the ceiling is
  64 hex (full SHA-256). Defense-in-depth: the match layer also
  enforces the bounds so a hand-rolled `PeerSet` bypassing the mDNS
  parser cannot install a short pin.
- **H2 — Trust-score counter concurrency race.** Added per-peer
  `authInFlight: Map<string, number>` alongside `authFailures`. The
  pre-dispatch gate now evaluates `confirmed + inFlight >= LIMIT` so
  N concurrent 401s cannot all pass the gate before any response
  arrives. Reservation is made synchronously before the first `await`
  and released in a `try/finally` covering every exit path. Under
  10 concurrent 401s: only 3 requests reach the wire (was 10).

### Tests

- `tests/seed/unit/discovery-mdns-fp.test.ts` — floor rejection
  (`fp=ab`) and ceiling rejection (>64 hex).
- `tests/seed/unit/transport-fp-pin.test.ts` — defense-in-depth at
  the match layer.
- `tests/seed/unit/trust-score.test.ts` — 10 concurrent 401s cap
  dispatch at 3; in-flight 2xx releases its reservation.

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
  (subpath export `@cognitum/sdk/seed/discovery/mdns`, peer dep on
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
