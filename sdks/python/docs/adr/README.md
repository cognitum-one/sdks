# Python SDK — ADRs

Architecture and implementation decisions for `cognitum`
(`/home/ruvultra/projects/sdks/sdks/python/`).

## Prerequisite reading (cross-cutting, in `docs/adr/`)

Start here — these apply to **all** SDKs and are referenced throughout:

- [`../../../../docs/adr/ddd/seed-domain.md`](../../../../docs/adr/ddd/seed-domain.md) — domain model + ubiquitous language
- [`../../../../docs/adr/0002-seed-wire-protocol.md`](../../../../docs/adr/0002-seed-wire-protocol.md) — HTTP contract
- [`../../../../docs/adr/0003-cross-cutting-auth-model.md`](../../../../docs/adr/0003-cross-cutting-auth-model.md) — X-API-Key, pairing, mTLS
- [`../../../../docs/adr/0004-cross-cutting-error-taxonomy.md`](../../../../docs/adr/0004-cross-cutting-error-taxonomy.md) — 12-variant error taxonomy
- [`../../../../docs/adr/0005-cross-cutting-retry-backoff.md`](../../../../docs/adr/0005-cross-cutting-retry-backoff.md) — equal-jitter, 500ms base, 30s cap
- [`../../../../docs/adr/0006-cross-cutting-versioning.md`](../../../../docs/adr/0006-cross-cutting-versioning.md) — SemVer, forward-compat unknown fields
- [`../../../../docs/adr/0007-cross-cutting-security-model.md`](../../../../docs/adr/0007-cross-cutting-security-model.md) — TLS pinning, credential redaction
- [`../../../../docs/adr/0011-sdk-scope-cloud-vs-seed.md`](../../../../docs/adr/0011-sdk-scope-cloud-vs-seed.md) — submodule `cognitum.seed`

## Python-specific ADRs

| # | File | Topic |
|---|------|-------|
| 0009 | [`0009-python-sdk-architecture.md`](0009-python-sdk-architecture.md) | Architecture: httpx sync + async, `cognitum.seed` submodule, dataclasses, `py.typed` |
| 0013a | [`0013a-python-sdk-module-layout-and-api.md`](0013a-python-sdk-module-layout-and-api.md) | Implementation: module layout, public API (`Cognitum` / `AsyncCognitum` / `SeedClient` / `AsyncSeedClient`), typed models |
| 0013b | [`0013b-python-sdk-transport-retry-auth-errors.md`](0013b-python-sdk-transport-retry-auth-errors.md) | Implementation: exception hierarchy (12 variants + `AuthReason`), transport, retry, auth, `SeedPinnedVerifier` |
| 0013c | [`0013c-python-sdk-streaming-tests-packaging-migration.md`](0013c-python-sdk-streaming-tests-packaging-migration.md) | Implementation: SSE, test matrix (~64 seed endpoints × 5 cases, OTA rows pending), `pyproject.toml`, CI, benches, migration |

## Key Python-specific decisions (from 0013x)

| Area | Decision |
|------|----------|
| Transport | `httpx` sync + async, connection pooling via `httpx.Limits`, HTTP/2 opt-in |
| Data classes | `@dataclass(slots=True, frozen=True)` with `extra: dict` for forward compat |
| Exceptions | Full 12-variant hierarchy + `AuthReason` enum; `raw_body` + `correlation_id` on base |
| Retriable set | Widened to `{429, 500, 502, 503, 504}` (was missing 502/504) |
| TLS pinning | `verify: Union[bool, str, Path, ssl.SSLContext, SeedPinnedVerifier]` |
| Idempotency | Explicit `idempotent=True` kwarg — `store.query` opts in; POSTs don't auto-retry |
| Auth-fail cutoff | 3rd consecutive 401/403 aborts (matches seed trust-score protection) |
| Python floor | 3.10+ (union syntax + `slots=True` on dataclass) |
| Packaging | `py.typed` marker, PyPI Trusted Publisher, CI matrix 3.10–3.13 × Linux/macOS/Windows |

## Open questions (Python)

- **OQ-P1** `PairStatus` wire shape (modeled from ADR-0002 §Pairing flow; server doesn't print JSON body).
- **OQ-P2** `WitnessEntry` wire shape (modeled from `ddd/seed-domain.md:105`).
- **OQ-P3** `retry_after_us` placement (chose top-level + fallback regex over `error` string).
- **OQ-P4** `TokenStore` concrete implementation deferred (stdlib file vs `keyring`).
- **OQ-4** (shared) **Answered 2026-04-23** — Python ships both HTTP and
  stdio transports via `cognitum.mcp` (`McpClient`, `StdioTransport`,
  `HttpTransport`, `Transport` Protocol). See
  [`0013c-python-sdk-streaming-tests-packaging-migration.md`](0013c-python-sdk-streaming-tests-packaging-migration.md)
  §"MCP stdio parity".
