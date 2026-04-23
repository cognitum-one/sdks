# Changelog — cognitum-rs

Format: [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/).
This crate follows [Semantic Versioning](https://semver.org/).

## [0.2.1] — 2026-04-23

Security patch release. No functional changes — fixes one high
finding, one silent-bypass, and one high finding from the 0.2.0
post-release QE audit (`docs/qe/security-audit.md`). See the
[root CHANGELOG](../../../CHANGELOG.md) for the full cross-SDK
picture.

### Security

- **H1 — `SecretString::Serialize` now redacts by default.** The
  serde `Serialize` impl previously emitted the raw inner string,
  matching the `Deserialize` direction for `PairCreateResponse`
  round-trip. But nothing in the SDK actually serialises a response
  back to JSON — the wire flow is ingress-only — while
  `serde_json::to_string(&resp)` / `tracing::info!("{}", json!(resp))`
  paths silently exposed the pairing token. Node's SDK redacts via
  `toJSON`; Rust now matches. `Deserialize` is unchanged. Added
  `SecretString::serialize_raw` as an explicit opt-in for any
  future field that genuinely needs the raw value via
  `#[serde(serialize_with = ...)]`.
- **H5 — `SecretString::Drop` zeroise via volatile writes.** The
  previous Drop impl used `*b = 0` in a loop, which LLVM's dead-
  store elimination can legally delete on `-O2` release builds. On
  release the zero-on-drop contract was cosmetic. Replaced with
  per-byte `std::ptr::write_volatile` + a `compiler_fence(SeqCst)`
  so the optimiser cannot elide the scrub. No new deps. Zeroise
  logic extracted to `zeroise_string_in_place` so the contract can
  be unit-tested without racing the allocator.
- **Silent-bypass fix — accept seed's 16-char fingerprint.**
  `parse_hex_sha256` required exactly 64 hex chars, so
  `build_pin_map` silently skipped every real seed pin (seed
  firmware emits `fp={first 16 hex chars}`, see
  `seed/src/cognitum-agent/src/discovery.rs:162`). `PinMap` type
  changed from `BTreeMap<String, [u8; 32]>` to
  `BTreeMap<String, Vec<u8>>` to hold variable-length prefixes.
  New `parse_hex_pin()` accepts `[16, 64]` hex with bounds
  enforcement; `verify_server_cert` prefix-matches and re-validates
  length bounds at runtime (defense in depth).

### Changed

- `PinMap` — value type is now `Vec<u8>` (was `[u8; 32]`). Callers
  constructing pins directly via `pins.insert(host, digest)` need
  `digest.to_vec()` or `vec![0u8; N]`.
- `parse_hex_sha256` — retained for callers needing a fixed-size
  32-byte digest; still requires exactly 64 hex chars. New callers
  should prefer `parse_hex_pin`.

### Added

- `parse_hex_pin(hex: &str) -> Option<Vec<u8>>` — accepts
  `[PIN_MIN_BYTES * 2, PIN_MAX_BYTES * 2]` = `[16, 64]` hex chars.
- `PIN_MIN_BYTES` / `PIN_MAX_BYTES` — public constants (8 / 32).
- `SecretString::serialize_raw` — explicit opt-in for
  `#[serde(serialize_with = ...)]` on fields that genuinely need
  raw wire egress.

### Tests

- `tls_pin::tests` — 6 new cases covering `parse_hex_pin` bounds,
  `build_pin_map` with a 16-hex seed-form pin, and prefix-match
  behaviour in `verify_server_cert`.
- `token_book::tests` — 4 new cases: `SecretString::Serialize`
  redaction (alone and via `PairCreateResponse`),
  `zeroise_string_in_place` scrub correctness, and a Drop
  smoke-test.
- Existing integration tests in `tests/seed_fp_pin.rs` updated to
  pass `Vec<u8>` into `PinMap`.

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
- **`documentation`** pointer moved to `docs.rs/cognitum-rs`.
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
