# Changelog — cognitum (Python)

Format: [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/).
This package follows [Semantic Versioning](https://semver.org/).

## [0.2.1] — 2026-04-23

Security patch release. No functional changes — fixes two critical
findings, one silent-bypass, and one remaining allowlist bug from
the 0.2.0 post-release QE audit (`docs/qe/security-audit.md`). See
the [root CHANGELOG](../../../CHANGELOG.md) for the full cross-SDK
picture.

### Security

- **C2 — TLS pin TOCTOU.** `PinVerifier` previously opened a
  separate raw TLS socket via `ssl.get_server_certificate` to
  compute the expected digest, cached `_verified=True`, and let
  httpx open a DIFFERENT socket for the real request. An attacker
  answering handshake #1 with the real cert and handshake #2 with a
  forged cert bypassed the pin permanently. Replaced with
  `_PinnedToCertContext(ssl.SSLContext)` + per-peer `httpx.Client`
  cache: the overridden `wrap_socket` runs on the SAME handshake
  httpx uses, compares the peer cert DER against the pinned DER,
  and closes the socket before any request bytes cross the wire if
  mismatched. No cached "verified" boolean; every connection is
  re-validated. `PinVerifier` removed.
- **C3 — `cognitum.local` dropped from the auto-insecure
  allowlist.** `_DEFAULT_SEED_HOSTS` no longer contains
  `cognitum.local`; the allowlist is now `{"169.254.42.1"}` plus the
  `169.254.*` and `fe80:*` link-local prefix checks. `cognitum.local`
  is mDNS-resolvable on any local network — an attacker on the same
  wifi could publish a PTR pointing at their laptop and the SDK
  would silently accept a forged self-signed cert via
  `verify_mode = CERT_NONE`. Callers must now pass
  `tls=SeedTLS(insecure=True)` for dev or `tls=SeedTLS(ca_pem=...)` /
  `fp=` pinning for production.
- **Silent-bypass fix — accept seed's 16-char fingerprint.**
  `_parse_fp_txt` required exactly 64 hex chars, so every real seed
  pin was silently dropped during discovery (seed firmware emits
  `fp={first 16 hex chars}`, see
  `seed/src/cognitum-agent/src/discovery.rs:162`). Now accepts
  `[16, 64]` hex chars with even-length + hex-char validation.
  `build_pinned_ssl_context` also enforces these bounds on the
  expected pin and prefix-matches `actual_hex[:len(expected)]`
  against the expected digest.

### Added

- `_PinnedToCertContext` (`cognitum.seed._transport`) — SSLContext
  subclass that overrides `wrap_socket` to verify the peer cert's
  DER bytes match an expected pin on the live handshake.
- `build_pinned_ssl_context(expected_sha256, host, port)` — public
  builder that pre-fetches the cert, verifies the digest prefix,
  and returns a context that rejects any cert whose DER differs.
- `build_sync_pinned_client` / `build_async_pinned_client` — httpx
  client builders that accept a custom SSLContext.

### Removed

- `cognitum.seed._transport.PinVerifier` — superseded by
  `_PinnedToCertContext`. Not exported publicly; removal is
  internal.

### Tests

- `tests/seed/unit/test_pinned_ssl_context.py` — 5 tests exercising
  the primitive against real local TLS servers with real cert swaps.
- `tests/seed/unit/test_pin_end_to_end.py` — 7 tests exercising the
  full integration through `SeedClient` (including the 16-char
  seed-form path and regression guards that `PinVerifier` is gone).
- `tests/seed/unit/test_fp_parser_bounds.py` — 14 tests covering
  `_parse_fp_txt` bounds and `build_pinned_ssl_context` prefix-
  compare correctness.
- `tests/seed/unit/test_tls_localhost_strict.py` — 4 new tests
  covering `cognitum.local` strict-by-default + explicit opt-in.

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
