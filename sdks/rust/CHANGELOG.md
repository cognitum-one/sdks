# Changelog — cognitum-rs

Format: [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/).
This crate follows [Semantic Versioning](https://semver.org/).

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
