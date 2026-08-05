# Changelog

All notable changes to the Cognitum SDK monorepo are documented here.
The format is based on [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

For per-SDK detail, see:

- [`sdks/node/CHANGELOG.md`](sdks/node/CHANGELOG.md)
- [`sdks/python/CHANGELOG.md`](sdks/python/CHANGELOG.md)
- [`sdks/rust/CHANGELOG.md`](sdks/rust/CHANGELOG.md)

## [Unreleased]

### Changed

- Relicensed the repository and all three SDK packages from MIT to Apache-2.0,
  adding an explicit patent grant for users and contributors.
- Added the public security, support, contribution, conduct, ownership, issue,
  and pull-request policies required before repository visibility changes.
- Added narrow exact-fixture Gitleaks exceptions so full-history scanning can
  block real findings without treating synthetic test canaries as credentials.
- Distinguished prepared source version `0.4.0` from registry version `0.3.0`.


## [0.4.0-rc.1] — 2026-08-05

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

- `upgrade_required` error kind and an `upgrade` affordance on `AgenticError`,
  across Node, Python and Rust (issue #128, ADR-0023 §D1).

### Changed

- A 402 carrying `code: "upgrade_required"` now maps to the new kind instead of
  `budget_exceeded`. A tier shortfall is not a spend problem, and reporting it
  as one sends users to look at usage when they need to look at their plan.
  An unrecognised 402 code still maps to `budget_exceeded`, so a future server
  code cannot become `upgrade_required` by accident.
- Every 402 now populates `code` from the response body, budget ones included.
  It was previously always absent. Callers using `code == null` to tell an SDK
  status mapping apart from a structured service error will see a value where
  they saw none.


## [0.3.0] — 2026-07-19

Cognitum Agentic SDK Integration — Node, Python, and Rust all gain new
product clients (Meta LLM, Meta Proxy, MetaHarness, HarnessaaS) on top
of a shared, frozen `agentic` contract module (credential providers,
error taxonomy, telemetry primitives). See each per-SDK CHANGELOG for
full detail; governing ADRs live in `docs/adr/`.

### Added

- Meta LLM client: real non-streaming support for all 5 serving
  protocols plus streaming for `chat.completions` (OpenAI SSE) and
  `messages.create` (native Anthropic events) on a shared SSE parser.
- Meta Proxy client: data-plane, non-streaming and streaming
  `chat.completions` forwarding, consent gating, browser-runtime guard.
- MetaHarness client: construction and full method surface as
  fail-closed stubs — the upstream bridge protocol doesn't exist yet.
- HarnessaaS client: `health`/`solve`/`lineage` against the real
  deployed synchronous surface.
- OAuth token credential provider + scope preflight (ADR-0022).
- Telemetry scaffolding: `TelemetrySink` interface + no-op default, W3C
  trace-context primitives, event/metric catalog, diagnostic capture
  policy — all type-only, zero product-client wiring yet.

### Published

- npm: `@cognitum-one/sdk@0.3.0` — https://www.npmjs.com/package/@cognitum-one/sdk
- crates.io: `cognitum-one@0.3.0` — https://crates.io/crates/cognitum-one
- PyPI: `cognitum-sdk@0.3.0` — https://pypi.org/project/cognitum-sdk/0.3.0/.
  **Correction**: an initial upload attempt under the `pyproject.toml`
  project name `cognitum` returned `403 Forbidden`. That name is not
  this org's project at all — it's owned by an unrelated third party
  (see PR #34, filed 2026-04-29: the PyPI name `cognitum` was taken by
  another user in 2024, so this SDK's distribution was manually
  published as `cognitum-sdk` back in v0.2.0, with the Python *import*
  name staying `cognitum`). `pyproject.toml`'s `name` field was out of
  sync with that decision; fixed to `cognitum-sdk` to match, and the
  `PYPI_TOKEN` in GCP Secret Manager (already correctly scoped to
  `cognitum-sdk`, per PR #34) published cleanly on the first retry.

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
