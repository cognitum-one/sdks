# ADR 0009: Python SDK Architecture

- **Status:** Accepted (Cloud scope). Seed-direct module Proposed (ADR-0011).
- **Date:** 2026-04-22
- **Scope:** sdks/python
- **Package:** `cognitum` on PyPI (`sdks/python/pyproject.toml:6`)

## Context

`sdks/python/` ships a **single dual-paradigm package** that exposes both
synchronous (`Cognitum`) and asynchronous (`AsyncCognitum`) clients over
`httpx`. Python 3.10+ required. Dependency footprint is a single line:
`httpx>=0.25.0` (`pyproject.toml:12`).

Existing source of truth:

- `client.py` — sync entry, resource composition (`client.py:21-68`).
- `async_client.py` — async entry (symmetric).
- `_http.py` — both `SyncHttpClient` and `AsyncHttpClient` with retries and
  error mapping (`_http.py:1-234`).
- `errors.py` — five exception types (`errors.py:1-49`).
- Seven resources: `catalog.py`, `orders.py`, `leads.py`, `contact.py`,
  `devices.py`, `mcp.py`, `brain.py`. Each pairs sync + async classes.
- `types.py` — dataclasses with `from __future__ import annotations`.
- `py.typed` marker shipped so callers get type hints.
- Tests: `tests/test_client.py` with `respx` mocks.

## Decision

### Transport

- `httpx` for both sync and async. No `requests` fallback; `httpx` covers
  both cases and avoids double-maintained code paths.
- SSL/TLS: default `verify=True` for cloud; for seed-direct, a dedicated
  `httpx.Client(verify=seed_trust_ctx())` where `seed_trust_ctx()` accepts
  the pinned self-signed cert for `169.254.42.1`/`cognitum.local` and
  enforces CA verification elsewhere (ADR-0007).
- HTTP/2: left off by default; the seed is HTTP/1.1 only
  (`seed/src/cognitum-agent/src/http.rs:102-108`). Python requires the
  extra `h2` install for HTTP/2, so opt-in is the right default here —
  unlike Node's undici (H2 stable in-tree) where it's on for cloud.
  Cross-SDK matrix: Node on (cloud) / off (seed); Python off by default
  both ways; Rust `http2_prior_knowledge()` (cloud) / off (seed).

### Auth

- `Cognitum(api_key=..., base_url=...)` and
  `AsyncCognitum(api_key=..., base_url=...)` for cloud (`client.py:39-52`).
- For seed-direct, add a `SeedClient` / `AsyncSeedClient` pair under
  `cognitum.seed`:
  ```py
  from cognitum.seed import SeedClient
  seed = SeedClient(host="169.254.42.1", pairing_token=...)
  ```
- Env var resolution: `COGNITUM_API_KEY` and `COGNITUM_SEED_PAIRING_TOKEN`.
- Header: `X-API-Key` (already compliant, `_http.py:68`). <!-- verified 2026-04-22 (python validator): X-API-Key header sent on every seed call, intercepted via httpx event_hooks. -->
- <!-- verified 2026-04-22 (Phase 1 delivery, python Team): cognitum.seed.SeedClient and AsyncSeedClient implemented. See sdks/python/cognitum/seed/_client.py and _async_client.py. Tracks issue #2 (sdks). -->
- <!-- verified 2026-04-22 (Phase 1 delivery): SeedPinnedVerifier implemented (cognitum/seed/_transport.py); SeedTLS(ca_pem=, ca_path=, insecure=, pinned_sha256=, client_cert=) supported; fail-fast ConfigError on non-default host without trust material. Tracks issue #4 (sdks). -->


### Retry / rate-limit

Per ADR-0005:

- `max_retries=3`, `timeout=30.0` (retain, `client.py:46-51`).
- Extend `_RETRYABLE_STATUS_CODES` from `{429, 500, 503}` to
  `{429, 500, 502, 503, 504}` (`_http.py:18`). <!-- verified 2026-04-22 (Phase 1 delivery): seed-path retriable set is {429, 500, 502, 503, 504} at sdks/python/cognitum/seed/_retry.py:_RETRIABLE_STATUS; unit tests in tests/seed/unit/test_seed_retry.py::TestIsRetriableStatus cover every code; retry loop in cognitum/seed/_client.py exercises 502+504 via respx. Closes issue #8 (sdks). -->
- Change `_backoff_delay` base from `0.5 * 2**attempt` with cap 30 s to the
  equal-jitter formula in ADR-0005:
  ```py
  base = 0.5
  cap = 30.0
  raw = min(cap, base * (2 ** attempt))
  delay = max(server_hint, raw + random.uniform(0, base))
  ```
- Respect `Retry-After` header (already done, `_http.py:104-110`). <!-- verified 2026-04-22 (python validator): respx 429 with Retry-After: 2 surfaces retry_after_seconds=2.0 on RateLimitError. -->
- Add seed-specific 429: parse JSON body `retry_after_us`.

### Type / schema strategy

- `@dataclass(frozen=True)` for every response type in `types.py`.
- Parse via explicit `.get(..., default)` — never `TypedDict(**raw)` —
  because the wire format differs between cloud (camelCase like
  `deviceId`) and seed (snake_case like `device_id`). Current parser
  handles both (`devices.py:12-19`). Keep that pattern.
- No Pydantic. Adds 3 MB to the install and is overkill for a thin SDK.
- `from __future__ import annotations` everywhere so forward refs work on
  3.10+ without runtime cost.
- `py.typed` already present.

### Error model

Per ADR-0004:

- Keep `CognitumError`, `AuthError`, `RateLimitError`, `ValidationError`,
  `NotFoundError`. <!-- verified 2026-04-22 (python validator): 401->AuthError, 403->AuthError, 404->NotFoundError, 422->ValidationError, 429->RateLimitError all confirmed via respx. -->
- Add `NotImplementedError` (subclass of `CognitumError`, not of Python's
  built-in — to avoid clashes), `ConflictError`, `ServiceUnavailableError`,
  `NetworkError`, `TimeoutError`, `ParseError`. <!-- verified 2026-04-22 (Phase 1 delivery): all 12 variants implemented in sdks/python/cognitum/_errors.py; cognitum/errors.py re-exports for 0.1.x backward compat. seed/_client.py::map_error covers 400/401/403(×4 reasons)/404/405/409/422/429/500/501/502/503/504. Unit tests in tests/seed/unit/test_seed_errors.py. Closes issue #3 (sdks). -->
- Add `AuthError.reason: Literal[...]` typed field.
- `__cause__` is already set via `raise ... from exc` (`_http.py:93, 120`).
- Attach `error.raw_body: bytes`, `error.correlation_id: str` to the base
  class.

### Streaming & pagination

- Async-only streaming. Sync caller who needs SSE must use a worker thread
  or migrate to async.
- `AsyncHttpClient.stream_sse` (`_http.py:226-233`) already exists as a
  raw-line iterator. Wrap it in a typed yield for each endpoint:
  - `async for ev in seed.sensor.stream_readings(): ...`
  - `async for delta in seed.delta.stream(): ...`
  Both raise `NotImplementedError` today since the seed returns 501. <!-- wire_mismatch 2026-04-22 (python validator): live seed at /api/v1/delta/stream returns 200 application/json snapshot (fields: changes_since_boundary, event_types, ...), NOT 501 and NOT SSE. Coord to file issue (seed-side + SDK NotImplementedError mapping). -->
- No pagination; lists are returned whole.

### Testing strategy

- `pytest` + `pytest-asyncio` + `respx` (already configured,
  `pyproject.toml:16`).
- Integration tests tagged `@pytest.mark.integration` gated behind
  `COGNITUM_API_KEY` for cloud and `COGNITUM_SEED_HOST` for seed.
- Conformance tests (ADR-0004, ADR-0005) live in `tests/conformance/`.

### API surface shape

```py
from cognitum import Cognitum, AsyncCognitum
from cognitum.seed import SeedClient, AsyncSeedClient
from cognitum.errors import AuthError, RateLimitError

with Cognitum(api_key="sk-...") as c:
    products = c.catalog.browse()

async with AsyncCognitum(api_key="sk-...") as c:
    await c.orders.create(...)

with SeedClient(host="169.254.42.1", pairing_token=...) as s:
    s.store.ingest([{"id": "v1", "values": [0.1]*8}])
    result = s.store.query(vector=[0.1]*8, k=5)
    state = s.thermal.state()
    profile = s.coherence.profile()
```

Parity rules:

- Every sync method has an async counterpart and vice versa.
- `__enter__` / `__exit__` and `__aenter__` / `__aexit__` on both clients.
- Resource classes return dataclasses, not dicts, at the public boundary.

### Packaging

- `setuptools` build (`pyproject.toml:1-3`).
- `cognitum*` discovery (`pyproject.toml:18-20`).
- Runtime deps: `httpx>=0.25.0`. No transitive madness.
- Optional extras: `cognitum[dev]` = pytest + pytest-asyncio + respx.
  Add `cognitum[seed-mtls]` for the optional mTLS client cert deps
  (only `httpx` + `ssl` from stdlib — so actually no extra; keeps as docs).
- Wheel: pure-Python, `Any`-arch.

## Consequences

### Positive

- Single package owns both sync and async with shared code paths.
- `httpx` gives HTTP/1.1+2, SSE support, and clean mocking via `respx`.
- Zero non-stdlib deps besides `httpx`.

### Negative

- Dual sync/async doubles class count per resource. Mitigation: shared
  parse helpers (`_parse_device` pattern, `devices.py:11-19`).
- Async SSE iterator plus sync client means some callers can't use SSE —
  acceptable, documented.

## Alternatives considered

| Option | Why rejected |
|--------|--------------|
| Only async | Forces Jupyter / script users into `asyncio.run(...)` for every call. |
| Pydantic models | Install bloat, overkill. |
| `requests` + `aiohttp` instead of `httpx` | Two libraries, two auth paths, two SSL trust-store patterns. |

## Compliance

- `mypy --strict` clean on `cognitum/`.
- `ruff check` clean.
- Conformance tests green (ADR-0004, ADR-0005).
- `python -c "import cognitum; print(cognitum.__version__)"` with no side
  effects.

## References

- DDD model: `docs/adr/ddd/seed-domain.md`
- Client: `sdks/python/cognitum/client.py:1-84`
- Async client: `sdks/python/cognitum/async_client.py`
- Transport: `sdks/python/cognitum/_http.py:1-234`
- Errors: `sdks/python/cognitum/errors.py:1-49`
- Packaging: `sdks/python/pyproject.toml:1-20`
- Related: ADRs 0002, 0003, 0004, 0005, 0006, 0007, 0011.
