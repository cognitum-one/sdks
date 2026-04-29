# Changelog

All notable changes to the Cognitum SDK monorepo are documented here.
The format is based on [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

For per-SDK detail, see:

- [`sdks/node/CHANGELOG.md`](sdks/node/CHANGELOG.md)
- [`sdks/python/CHANGELOG.md`](sdks/python/CHANGELOG.md)
- [`sdks/rust/CHANGELOG.md`](sdks/rust/CHANGELOG.md)


## [0.2.1] — 2026-04-29

### Changed

- **Renamed npm package** from `@cognitum/sdk` to `@cognitum-one/sdk` to
  align with the GitHub org. The `@cognitum/sdk` entries on npm (≤0.1.3)
  are abandoned but left in place for any existing consumers.
- **Renamed Rust crate** from `cognitum-rs` to `cognitum-one`. Old crate
  on crates.io (≤0.1.0) is left in place.
- No API changes — drop-in for anyone migrating; just update the package
  name in your manifests.

### Published

- npm: `@cognitum-one/sdk@0.2.1` — https://www.npmjs.com/package/@cognitum-one/sdk
- crates.io: `cognitum-one@0.2.1` — https://crates.io/crates/cognitum-one (docs: https://docs.rs/cognitum-one)
- PyPI: still on `cognitum@0.0.1.dev2` — release pending PyPI token in GCP Secret Manager

## [0.2.0] — 2026-04-23

First aligned release across all three SDKs. Ships the full seed-client
surface against seed firmware `v0.20.0`, end-to-end live-verified across
Node, Python, and Rust. Closes [PR #25](https://github.com/cognitum-one/sdks/pull/25)
(19 commits, 28 issues closed).

### Added

- **Phase 1 — seed client (all 3 SDKs).** 12 typed endpoints per SDK:
  `status`, `identity`, `pair.{status,create,delete,window}`,
  `witness.chain`, `custody.epoch`, `store.{status,query,ingest}`,
  `ota.{config,checkNow}`. Live-verified against the real seed
  (`ad7d7e7b-56e7-4e03-b078-939209858144`): Node 7/9, Python 9/9, Rust 9/9.
- **Phase 1.5 — mesh routing (all 3 SDKs).** `PeerSet`, `TokenBook`,
  `SeedSession`, opt-in background health probe, closest-first selection
  with session-sticky reads, failover state machine that cycles peers on
  5xx / network errors and pins on 429. 7 ADR-0017 §5 conformance tests
  green on each SDK. Mixed-peer cycle-on-503 validated live 3/3.
- **Phase 2 — `client.mesh()` observability (all 3 SDKs).** Typed wrappers
  for `mesh.status`, `mesh.peers`, `mesh.swarmStatus`, `mesh.clusterHealth`
  (all 200 on live seed). Per-call `CallOptions` (`peer` / `prefer` /
  `consistency` / `timeout` / `retries`) threaded through every resource
  method. `rediscover()` for runtime peer refresh via discovery provider.
- **Phase 3 — discovery providers (all 3 SDKs).** `ExplicitDiscovery`
  (default), `MdnsDiscovery` against `_cognitum._tcp.local.`, and
  `TailscaleDiscovery` (consumes `tailscale status --json` and filters
  peers by `cognitum-*` hostname prefix). Per-peer TLS fingerprint pinning
  via `fp=sha256:<hex>` TXT records.
- **MCP stdio transport parity (OQ-4).** Python and Rust joined Node in
  offering both HTTP and stdio transports for the MCP client. Launches
  a local MCP server as a subprocess and frames JSON over stdin/stdout.
- **Per-SDK `README.md`, `LICENSE`, `CHANGELOG.md`.** Added to
  `sdks/{node,python,rust}/` so published artifacts carry the license
  and a quick-start.
- **Root `README.md` quickstart + feature map** (landed mid-cycle via
  commit `434e40e`).

### Changed

- **Auth canonicalised to `X-API-Key`** across all 3 SDKs (closes
  [#10](https://github.com/cognitum-one/sdks/issues/10)). Node and
  Python dropped `Bearer`; Rust keeps `Bearer` behind a
  2-minor-release deprecation and forwards both headers for now.
- **Phase 1 wire divergences resolved** (closes [#2](https://github.com/cognitum-one/sdks/issues/2),
  [#3](https://github.com/cognitum-one/sdks/issues/3),
  [#4](https://github.com/cognitum-one/sdks/issues/4),
  [#8](https://github.com/cognitum-one/sdks/issues/8),
  [#9](https://github.com/cognitum-one/sdks/issues/9),
  [#12](https://github.com/cognitum-one/sdks/issues/12),
  [#13](https://github.com/cognitum-one/sdks/issues/13),
  [#14](https://github.com/cognitum-one/sdks/issues/14)) — the three
  SDKs now agree on field names, retry semantics, and error taxonomy.
- **ADR-0005 retry compliance** (closes [#5](https://github.com/cognitum-one/sdks/issues/5),
  [#6](https://github.com/cognitum-one/sdks/issues/6),
  [#7](https://github.com/cognitum-one/sdks/issues/7),
  [#11](https://github.com/cognitum-one/sdks/issues/11)): equal-jitter
  backoff, 500 ms base, 30 s cap, 60 s wall-clock ceiling. Honours
  `Retry-After` header and the seed's `retry_after_us` JSON body
  (body wins). POST methods no longer auto-retry unless the caller
  opts in via `idempotent: true`.

### Fixed

- **Node cold-path overhead** — ~50% hot-path reduction (0.024 ms →
  0.011 ms p50 delta vs raw `fetch`) by caching `undici.Agent` and
  avoiding per-call header allocation (closes
  [#24](https://github.com/cognitum-one/sdks/issues/24)).
- **Python cold-start** — 12 ms reclaimed via PEP 562 lazy
  `__getattr__` so importing `cognitum.seed` no longer eagerly pulls
  the cloud module graph (closes
  [#20](https://github.com/cognitum-one/sdks/issues/20)).
- **Rust jitter RNG** — xorshift64* replaces the modulo-biased
  `SystemTime.nanos`; retried-POST CPU path gained 3.01× from a
  serialize-once refactor (closes
  [#22](https://github.com/cognitum-one/sdks/issues/22),
  [#23](https://github.com/cognitum-one/sdks/issues/23)).

### Security

- **Token leak fix** — removed accidental pairing-token echo in a Rust
  `Debug` impl (closes [#15](https://github.com/cognitum-one/sdks/issues/15),
  [#19](https://github.com/cognitum-one/sdks/issues/19)).
- **Python localhost TLS** — `localhost` no longer auto-insecure; an
  audit finding that could have enabled MITM inside a shared host
  (closes [#17](https://github.com/cognitum-one/sdks/issues/17)).
- **Node TLS no longer process-wide** — replaced
  `NODE_TLS_REJECT_UNAUTHORIZED=0` with a scoped `undici.Agent` so
  dev-mode `insecure: true` never leaks past the SDK's own client
  (closes [#18](https://github.com/cognitum-one/sdks/issues/18)).
- **Trust-score 3-strike cutoff** enforced per-peer on all 3 SDKs
  (closes [#16](https://github.com/cognitum-one/sdks/issues/16)).
- **Redacting `SecretString`** around pairing tokens and
  `PairCreateResponse.token` on all 3. 14 conformance tests pin the
  redaction contract against drift (closes
  [#21](https://github.com/cognitum-one/sdks/issues/21)).
- **mDNS `fp=sha256:<hex>` cert pinning** enforced at the TLS
  handshake; mismatch is a hard `TlsPinError` and never falls back
  to insecure.

### Verified

- `npm test` → 201 pass / 1 pre-existing unrelated fail
- `pytest` → 274 pass / 3 skip
- `cargo test --features seed` → 84 lib + 23 client + 10 seed-integration
  suites green (2 pre-existing cloud-PEM failures remain out of scope)
- Live cross-SDK matrix: 30/30 Phase 2+3 scenarios pass; Phase 1.5
  cycle-on-503 3/3 SDKs pass

## [0.1.x] — pre-0.2.0

Per-SDK trickle releases prior to alignment. Tracked individually in
each SDK's `CHANGELOG.md`.
