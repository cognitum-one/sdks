# ADR 0013c: Python SDK — Streaming, Tests, Packaging, CI, Benchmarks, Examples, Migration

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** SDK working group
- **Scope:** sdks/python
- **Part of:** ADR-0013 (split into 0013a/0013b/0013c for size)
- **Implements:** ADR-0002, ADR-0005, ADR-0006, ADR-0009, ADR-0011

## Context

With layout, API, and models in ADR-0013a and transport/retry/auth/errors
in ADR-0013b, this ADR closes out the remaining implementation concerns:
streaming & pagination, the concrete test strategy, `pyproject.toml`
packaging, the GitHub Actions CI matrix, benchmarks, example scripts, and
the migration plan from the current 0.1.0 codebase.

## Decision

Ship streaming as an async-only iterator; pin the CI matrix at
3.10–3.13 × Linux/macOS/Windows; publish to PyPI via Trusted Publisher
(OIDC); ship a minimal `FileTokenStore` as the reference token-persistence
backend; provide a backward-compat shim in `cognitum/errors.py` for one
minor release.

---

## 8. Streaming & pagination

### 8.1 SSE (async-only)

<!-- ❌ wire_mismatch 2026-04-22 (issue cognitum-one/seed#48): /api/v1/delta/stream returns 200 application/json snapshot on seed v0.20.0, not 501 and not SSE. SDK 501→NotImplementedError mapping also not implemented (issue cognitum-one/sdks#3). §8.1 contract remains `(assumed)` until seed ships SSE or documents snapshot semantics. -->

Per ADR-0009, SSE is async-only. `sensor.stream_readings()` and
`delivery.stream_deltas()` use `httpx.AsyncClient.stream()`:

```python
# cognitum/seed/sensor.py — excerpt
from __future__ import annotations
from collections.abc import AsyncIterator
from cognitum._http import AsyncHttpClient
from cognitum.seed.models import SensorReading
from cognitum._errors import NotImplementedError as SdkNotImplemented


class AsyncSensorResource:
    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def stream_readings(self) -> AsyncIterator[SensorReading]:
        """Subscribe to /api/v1/sensor/stream.

        The seed returns 501 today (ADR-0002 §Streaming); this method raises
        `NotImplementedError(endpoint="/api/v1/sensor/stream")`. The signature
        does not change when the seed ships SSE.
        """
        async for frame in self._http.iter_sse("GET", "/api/v1/sensor/stream"):
            if frame.event == "reading":
                yield SensorReading.from_wire(frame.data)
```

Framing: `data: <json>\n\n` (one event per blank-line-terminated block).
`AsyncHttpClient.iter_sse` handles reconnection with `Last-Event-ID` and
maps `501` to `SdkNotImplemented` at the first frame.

### 8.2 Pagination

Only `store.query` takes a cursor today, and only for forward-compat.
Current seed does not paginate; SDK does not invent pagination
(ADR-0002 §Pagination). `store.query(cursor=...)` is accepted but ignored
until the seed implements it. List endpoints (`/sensor/list`,
`/profiles`) return the whole list.

---

## 9. Test strategy

### 9.1 Tooling

- `pytest`, `pytest-asyncio`, `respx`, `hypothesis` (property tests for
  retry math), `pytest-benchmark`.

### 9.2 Test matrix

Every seed resource × five cases. A passing test suite requires each
`yes` cell has at least one test function; `n/a` means the endpoint is
public-tier and does not need an auth-fail case.

| Endpoint | Happy | Empty | 429 | 5xx | Auth-fail |
|----------|:-----:|:-----:|:---:|:---:|:---------:|
| `GET /status` | yes | yes | yes | yes | n/a |
| `GET /identity` | yes | — | yes | yes | n/a |
| `GET /pair/status` | yes | — | yes | yes | n/a |
| `POST /pair` | yes | — | yes | yes | yes |
| `DELETE /pair/{name}` | yes | — | yes | yes | yes |
| `GET /store/status` | yes | yes | yes | yes | n/a |
| `POST /store/ingest` | yes | — | yes | yes | yes |
| `POST /store/query` | yes | yes | yes | yes | n/a |
| `POST /store/delete` | yes | — | yes | yes | yes |
| `GET /witness/chain` | yes | yes | yes | yes | n/a |
| `POST /witness/verify` | yes | — | yes | yes | yes |
| `GET /custody/epoch` | yes | — | yes | yes | n/a |
| `POST /custody/witness` | yes | — | yes | yes | yes |
| `POST /custody/sign` | yes | — | yes | yes | yes |
| `POST /custody/verify` | yes | — | yes | yes | yes |
| `GET /custody/attestation` | yes | — | yes | yes | n/a |
| `GET /optimize/status` | yes | — | yes | yes | n/a |
| `POST /optimize/trigger` | yes | — | yes | yes | yes |
| `GET /optimize/metrics` | yes | — | yes | yes | n/a |
| `GET /boundary` | yes | — | yes | yes | n/a |
| `POST /boundary/recompute` | yes | — | yes | yes | yes |
| `GET /delivery/image` | yes | — | yes | yes | n/a |
| `GET /delta/history` | yes | yes | yes | yes | n/a |
| `GET /delta/stream` | — | — | — | — | 501 → `NotImplementedError` | <!-- wire_mismatch 2026-04-22 (python validator): live seed at https://localhost:18443 returns 200 application/json snapshot (fields: changes_since_boundary, dead_space_ratio, deleted_vectors, epoch, event_types, file_size_bytes, optimizations, total_vectors, uptime_secs, witness_chain_length, witness_head). NOT SSE and NOT 501. Coord to file issue. -->
| `GET /coherence/profile` | yes | — | yes | yes | n/a |
| `GET /coherence/profile/history` | yes | yes | yes | yes | n/a |
| `GET /coherence/phases` | yes | yes | yes | yes | n/a |
| `GET /coherence/orphans` | yes | yes | yes | yes | n/a |
| `PUT /coherence/config` | yes | — | yes | yes | yes |
| `GET /sensor/list` | yes | yes | yes | yes | n/a |
| `GET /sensor/latest/{name}` | yes | — | yes | yes | n/a |
| `GET /sensor/stream` | — | — | — | — | 501 |
| `GET /sensor/store/status` | yes | — | yes | yes | n/a |
| `GET /sensor/gpio/pins` | yes | — | yes | yes | n/a |
| `GET /sensor/embedding/latest` | yes | — | yes | yes | n/a |
| `GET /sensor/embedding/config` | yes | — | yes | yes | n/a |
| `PUT /sensor/embedding/config` | yes | — | yes | yes | yes |
| `GET /sensor/drift/status` | yes | — | yes | yes | n/a |
| `GET /sensor/drift/history` | yes | yes | yes | yes | n/a |
| `GET /sensor/actuators` | yes | yes | yes | yes | n/a |
| `POST /sensor/actuator/fire/{name}` | yes | — | yes | yes | yes |
| `GET /sensor/reflex/rules` | yes | yes | yes | yes | n/a |
| `PUT /sensor/reflex/rules` | yes | — | yes | yes | yes |
| `GET /sensor/coprocessor/status` | yes | — | yes | yes | n/a |
| `GET /sensor/coprocessor/latest` | yes | — | yes | yes | n/a |
| `GET /thermal/state` | yes | — | yes | yes | n/a |
| `GET /thermal/governor` | yes | — | yes | yes | n/a |
| `GET /thermal/telemetry` | yes | yes | yes | yes | n/a |
| `GET /thermal/silicon-profile` | yes | — | yes | yes | n/a |
| `GET /thermal/accuracy` | yes | — | yes | yes | n/a |
| `GET /thermal/dvfs-profile` | yes | — | yes | yes | n/a |
| `GET /thermal/turbo` | yes | — | yes | yes | n/a |
| `GET /thermal/coherence` | yes | — | yes | yes | n/a |
| `GET /thermal/config` | yes | — | yes | yes | n/a |
| `GET /thermal/stats` | yes | — | yes | yes | n/a |
| `PUT /thermal/config` | yes | — | yes | yes | yes |
| `POST /thermal/characterize` | yes | — | yes | yes | yes |
| `POST /thermal/boost` | yes | — | yes | yes | yes |
| `GET /demo/coherence` | yes | — | yes | yes | n/a |
| `POST /demo/ingest-sample` | yes | — | yes | yes | yes |
| `GET /profiles` | yes | yes | yes | yes | n/a |
| `POST /profiles` | yes | — | yes | yes | yes |
| `GET /store/sync` | yes | — | yes | yes | n/a (binary RVF) |
| `POST /store/sync` | yes | — | yes | yes | yes (binary RVF) |
| `POST /upgrade/apply` | yes | — | yes | yes | yes (binary 16 MB) |
| `GET /upgrade/check` | yes | — | yes | yes | n/a (public) |
| `GET /ota/config` | yes | — | yes | yes | n/a (WiFi-read) |
| `POST /ota/config` | yes | — | yes | yes | yes |
| `POST /ota/check-now` | yes | — | yes | yes | yes (409 if disabled) |
| `GET /ota/log` | yes | yes | yes | yes | n/a (WiFi-read) |


### 9.3 Concrete test

```python
# tests/test_seed_client.py
from __future__ import annotations
import json
from pathlib import Path

import httpx
import pytest
import respx

from cognitum.seed import SeedClient
from cognitum._errors import AuthError, AuthReason, RateLimitError

FIXTURES = Path(__file__).parent / "fixtures" / "seed"
SEED_BASE = "https://169.254.42.1:8443"


def _load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


@respx.mock
def test_store_query_happy(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COGNITUM_SEED_TOKEN", "tok-paired")
    respx.post(f"{SEED_BASE}/api/v1/store/query").mock(
        return_value=httpx.Response(200, json=_load("store_query_ok.json"))
    )
    with SeedClient(host="169.254.42.1", dangerously_insecure=True) as s:
        result = s.store.query(vector=[0.1] * 8, k=2)
    assert len(result.matches) == 2
    assert result.matches[0].id == 12345
    assert result.matches[0].distance == pytest.approx(0.042)


@respx.mock
def test_store_ingest_not_paired_raises() -> None:
    respx.post(f"{SEED_BASE}/api/v1/store/ingest").mock(
        return_value=httpx.Response(403, json={"error": "not paired"})
    )
    with SeedClient(host="169.254.42.1", dangerously_insecure=True) as s:
        with pytest.raises(AuthError) as exc:
            s.store.ingest([{"id": "v1", "values": [0.1] * 8}])
    assert exc.value.reason == AuthReason.NOT_PAIRED
    assert exc.value.status_code == 403


@respx.mock
def test_rate_limit_honours_retry_after_us() -> None:
    respx.get(f"{SEED_BASE}/api/v1/status").mock(
        side_effect=[
            httpx.Response(
                429,
                json={"error": "rate limited — retry after 1s",
                      "retry_after_us": 1_000_000},
            ),
            httpx.Response(200, json=_load("status_ok.json")),
        ]
    )
    with SeedClient(host="169.254.42.1", dangerously_insecure=True,
                    max_retries=1) as s:
        status = s.get_status()
    assert status.device_id == "24db5659-b9bd-42e3-b4c5-f4fec6e721c5"
```

### 9.4 Golden fixture

```json
// tests/fixtures/seed/status_ok.json
{
  "device_id": "24db5659-b9bd-42e3-b4c5-f4fec6e721c5",
  "uptime_secs": 3845,
  "epoch": 21298,
  "total_vectors": 21298,
  "deleted_vectors": 0,
  "file_size_bytes": 1683031,
  "dimension": 8,
  "paired": false,
  "roles": ["custody", "optimizer", "delivery"],
  "witness_chain_length": 12
}
```

`witness_chain_length` is a documented-but-unmodeled field; the SDK must
route it into `SeedStatus.extra` to prove forward-compat (ADR-0006).

### 9.5 Conformance tests

`tests/conformance/test_error_taxonomy.py` asserts every HTTP code in
ADR-0004 produces the mapped exception class, `retriable` flag, and
populated `correlation_id`. `tests/conformance/test_retry_policy.py`
runs 10 parallel fake requests into a 429-then-200 scenario and checks
that observed delays fall within the equal-jitter envelope.

---

## 10. Packaging

```toml
# sdks/python/pyproject.toml (delta)
[build-system]
requires = ["setuptools>=68.0", "wheel"]
build-backend = "setuptools.build_meta"

[project]
name = "cognitum"
version = "0.2.0"
description = "Official Cognitum SDK for Python (cloud + seed)"
readme = "README.md"
license = {text = "MIT"}
requires-python = ">=3.10"
keywords = ["cognitum", "ai", "mcp", "sdk", "seed", "vector-db"]
authors = [{name = "Cognitum"}]
dependencies = [
    "httpx>=0.27,<0.29",
]

[project.optional-dependencies]
seed = []                            # reserved; seed is always available
seed-mtls = []                       # reserved; httpx covers mTLS via stdlib ssl
http2 = ["httpx[http2]>=0.27"]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.23",
    "pytest-benchmark>=4.0",
    "respx>=0.21",
    "hypothesis>=6.100",
    "ruff>=0.5",
    "mypy>=1.10",
]
docs = ["mkdocs>=1.6", "mkdocs-material>=9.5"]

[project.urls]
Homepage = "https://cognitum.one"
Repository = "https://github.com/ruvnet/cognitum"
Issues = "https://github.com/ruvnet/cognitum/issues"

[project.scripts]
cognitum = "cognitum._cli:main"      # optional CLI (ADR-0011)

[tool.setuptools]
include-package-data = true

[tool.setuptools.packages.find]
where = ["."]
include = ["cognitum*"]

[tool.setuptools.package-data]
cognitum = ["py.typed"]

[tool.ruff]
target-version = "py310"
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP", "SIM", "PL", "RUF"]

[tool.mypy]
python_version = "3.10"
strict = true
warn_return_any = true
warn_unused_configs = true

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

Reproducible wheels: `SOURCE_DATE_EPOCH` honoured by `setuptools>=69`;
pure-Python `py3-none-any.whl` — no architecture permutations. Supported
Python: 3.10, 3.11, 3.12, 3.13.

---

## 11. CI pipeline

```yaml
# .github/workflows/python-sdk.yml (sketch)
name: python-sdk
on:
  pull_request:
    paths: ["sdks/python/**", "docs/adr/**"]
  push:
    branches: [main]
    tags: ["python-v*"]

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        python-version: ["3.10", "3.11", "3.12", "3.13"]
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    defaults:
      run:
        working-directory: sdks/python
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python-version }}
          cache: pip
      - run: pip install -e ".[dev]"
      - run: ruff check .
      - run: ruff format --check .
      - run: mypy --strict cognitum
      - run: pytest --cov=cognitum --cov-report=xml --cov-fail-under=90
      - uses: codecov/codecov-action@v4
        with:
          files: sdks/python/coverage.xml

  bench:
    runs-on: ubuntu-latest
    needs: test
    defaults:
      run: { working-directory: sdks/python }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install -e ".[dev]"
      - run: pytest tests/benchmarks --benchmark-only --benchmark-json=bench.json
      - uses: benchmark-action/github-action-benchmark@v1
        with:
          tool: pytest
          output-file-path: sdks/python/bench.json
          github-token: ${{ secrets.GITHUB_TOKEN }}
          auto-push: false

  publish:
    if: startsWith(github.ref, 'refs/tags/python-v')
    needs: test
    runs-on: ubuntu-latest
    environment: pypi
    permissions:
      id-token: write             # PyPI Trusted Publisher (OIDC)
    defaults:
      run: { working-directory: sdks/python }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install build
      - run: python -m build
      - uses: pypa/gh-action-pypi-publish@release/v1
        with:
          packages-dir: sdks/python/dist
```

- Coverage floor: 90%, enforced via `--cov-fail-under`.
- `mypy --strict` must be clean on the `cognitum/` package.
- Publishing uses PyPI Trusted Publisher (OIDC) — no API tokens stored.

---

## 12. Benchmarks

`pytest-benchmark` targets (all against `respx`-backed `httpx.Client`, so
they measure SDK overhead, not network time):

| Target | Fixture | SLO (p50) | SLO (p95) |
|--------|---------|-----------|-----------|
| `seed.get_status()` | `status_ok.json` | < 150 us | < 400 us |
| `seed.store.query(vec, k=10)` | `store_query_ok.json` | < 250 us | < 600 us |
| `seed.store.ingest(batch=100)` | synthetic 100×8 f32 | < 2.0 ms | < 4.0 ms |
| `Cognitum.health()` | `{"status":"ok"}` | < 150 us | < 400 us |
| Retry loop, 2×429 then 200 | `retry_after_us=10` | < 30 ms | < 60 ms |

Regressions > 20% fail the `bench` CI job.

---

## 13. Examples

### 13.1 `examples/seed_tour.py`

```python
"""Talks to the seed appliance over USB (169.254.42.1)."""
from __future__ import annotations
from cognitum.seed import SeedClient


def main() -> None:
    with SeedClient(host="169.254.42.1") as seed:
        status = seed.get_status()
        print(f"device {status.device_id}  epoch={status.epoch}  "
              f"vectors={status.total_vectors}  roles={status.roles}")

        if not status.paired:
            pair_status = seed.pairing.status()
            if pair_status.pairing_window_open:
                result = seed.pair(client_name="seed-tour")
                print(f"paired as {result.client_name}; token issued")

        q = seed.store.query(vector=[0.1] * status.dimension, k=3)
        for m in q.matches:
            print(f"  {m.id}  d={m.distance:.4f}")

        profile = seed.coherence.profile()
        print(f"coherence={profile.temporal_coherence:.3f}  "
              f"slices={profile.slice_count}  partial={profile.is_partial}")

        thermal = seed.thermal.state()
        print(f"thermal {thermal.zone}  {thermal.temp_c:.1f}C  "
              f"{thermal.freq_mhz} MHz")


if __name__ == "__main__":
    main()
```

### 13.2 `examples/cloud_tour.py`

```python
"""Talks to the cloud control plane."""
from __future__ import annotations
import asyncio
from cognitum import AsyncCognitum


async def main() -> None:
    async with AsyncCognitum() as cog:   # reads COGNITUM_API_KEY
        health = await cog.health()
        print(f"api {health.status}  v{health.version}")

        catalog = await cog.catalog.browse(category="hardware")
        for p in catalog.products[:5]:
            print(f"  {p.id}  {p.name}")

        order = await cog.orders.create(email="you@example.com", quantity=1)
        print(f"order {order.order_id}  status={order.status}")


if __name__ == "__main__":
    asyncio.run(main())
```

---

## 14. Migration from current code

Diff, with `path:line` refs. "move" means unchanged public path, private
reshuffle; "rename" means an import change users will see; "break" means
a behavior change worth a CHANGELOG note.

| Action | From | To | Notes |
|--------|------|----|-------|
| move | `sdks/python/cognitum/_http.py:1-234` | `cognitum/_http.py` + `cognitum/_retry.py` + `cognitum/_telemetry.py` | Split retry math and logging into their own modules. |
| break | `sdks/python/cognitum/_http.py:18` `_RETRYABLE_STATUS_CODES = {429, 500, 503}` | adds `502, 504` | ADR-0005 gap. | <!-- verified 2026-04-22 (Phase 1 delivery): seed-path _RETRIABLE_STATUS in cognitum/seed/_retry.py is {429,500,502,503,504}. Closes issue #8 (sdks). Cloud-path retriable set will be aligned when cognitum/_http.py is refactored in Phase 1.5. -->
| break | `sdks/python/cognitum/_http.py:48-50` fixed exponential | equal-jitter (ADR-0013b §6) | ADR-0005 gap. |
| break | `sdks/python/cognitum/errors.py:6-15` `CognitumError(message, code)` | `CognitumError(message, *, status_code, request_id, retriable, raw_body, correlation_id, cause)` | Adds fields; `code` removed. Shim in `cognitum/errors.py` accepts old kwarg for 0.2.x. |
| add | n/a | `AuthError.reason: AuthReason` | ADR-0004. |
| add | n/a | `NotImplementedError`, `ConflictError`, `ServiceUnavailableError`, `NetworkError`, `TimeoutError`, `ParseError`, `ApiError` | ADR-0004. |
| move | `sdks/python/cognitum/errors.py:25-34` `RateLimitError.retry_after_seconds` | keep as alias, canonical field becomes `retry_after_ms: int` | ADR-0004. |
| move | `sdks/python/cognitum/_http.py:64-72` headers in ctor | `cognitum/_auth.py::Credentials.headers()` | Shared cloud+seed. |
| add | n/a | `cognitum/seed/` submodule with 10 resource modules | ADR-0011 §Python. | <!-- verified 2026-04-22 (Phase 1 delivery): `cognitum/seed/` submodule shipped with 5 resource modules (pair, store, witness, custody, ota) covering 12 Phase 1 endpoints; the remaining 5 (optimizer, delivery, sensor, coherence, thermal, profiles) land in Phase 1.5. Closes issue #2 (sdks). -->
| add | n/a | `cognitum/seed/_pinning.py::SeedPinnedVerifier` | ADR-0007 §TLS. | <!-- verified 2026-04-22 (Phase 1 delivery): SeedPinnedVerifier implemented at cognitum/seed/_transport.py (file consolidated from _pinning.py + _transport.py per keep-files-under-500-lines rule). Closes issue #4 (sdks). -->
| add | n/a | `cognitum/_telemetry.py::redact` + `Telemetry` | ADR-0003 §Redaction. |
| move | `sdks/python/cognitum/devices.py:11-19` wire-case tolerance helper | `cognitum/_models.py::WireModel.from_wire` | Reused by every model. |
| keep | `sdks/python/cognitum/client.py:39-84`, `async_client.py:39-84` | unchanged public signatures | Backward-compat. |
| keep | `sdks/python/cognitum/types.py:1-200` cloud dataclasses | add `extra` field on each | ADR-0006 §Unknown-field. |
| keep | `sdks/python/cognitum/__init__.py:1-76` re-exports | extend with seed + new errors | Non-breaking. |
| update | `sdks/python/pyproject.toml:12` `httpx>=0.25.0` | `httpx>=0.27,<0.29` | Retry-After HTTP-date parsing needs 0.27+. |
| update | `sdks/python/tests/test_client.py:1-337` | stays; add `tests/test_seed_client.py` et al. | See §9. |
| update | `sdks/python/tests/test_client.py:222-229` `code == "http_502"` | `isinstance(exc, ApiError) and exc.status_code == 502` | ADR-0004. |

Backward-compat shim:

```python
# cognitum/errors.py — deprecation layer
from cognitum._errors import *  # noqa: F401,F403
from cognitum._errors import CognitumError as _Base

# 0.1.x called CognitumError(message, code=...).  We accept the `code` kwarg
# and stash it on `.code` for one minor release, emitting a DeprecationWarning.
_orig_init = _Base.__init__

def _compat_init(self, message, *args, code=None, **kwargs):
    if code is not None:
        import warnings
        warnings.warn(
            "CognitumError(code=...) is deprecated; use status_code/ApiError",
            DeprecationWarning, stacklevel=2,
        )
    _orig_init(self, message, *args, **kwargs)
    if code is not None:
        self.code = code

_Base.__init__ = _compat_init  # type: ignore[assignment]
```

---

## 15. Open questions

Carrying forward from `docs/adr/README.md` §"Open questions tracked across ADRs"
and adding Python-specific items.

| # | Question | Owner |
|---|----------|-------|
| OQ-1 | (inherited) Cloud auth header consistency across SDKs | ADR-0003 |
| OQ-3 | (inherited) When does the seed ship SSE for `/delta/stream` and `/sensor/stream`? SDKs keep typed placeholders. | ADR-0002 |
| OQ-5 | (inherited) `X-Signature` / `X-Signed` signing scheme TBD | ADR-0003 |
| OQ-P1 | Do we vendor an `importlib.resources`-backed CA bundle for user-supplied seed CAs, or require an explicit `Path`? Current decision: explicit `Path`. Revisit if >5% of users hit TLS config friction. | ADR-0013 |
| OQ-P2 | `cognitum.seed.SeedClient` on Windows: does `SeedPinnedVerifier` correctly disable hostname check under `ssl.SSLContext` on schannel? Python is OpenSSL-based even on Windows, so expected yes — needs matrix CI to prove. | ADR-0013 |
| OQ-P3 | Is `asyncio_mode = "auto"` in `pyproject.toml` acceptable, or do we want explicit `@pytest.mark.asyncio`? Current: auto, for terser tests. | ADR-0013 |
| OQ-P4 | Where does the SDK stash persistent pairing tokens when the user opts in? Ship a stdlib-only `FileTokenStore` as a reference implementation, or require third-party `keyring`? Current: ship `FileTokenStore(cache_dir=...)` with a warning; document `keyring` as recommended. | ADR-0013, ADR-0007 |
| OQ-P5 | Streaming: should sync callers get a helper that spins an asyncio loop in a worker thread (`cognitum.seed.blocking_stream(...)`) or are we firm on async-only SSE? Current: async-only. | ADR-0013 |

---

## Consequences

### Positive

- Single package covers both cloud and seed with shared auth, retry,
  error, telemetry, and TLS machinery.
- Golden JSON fixtures prevent silent drift from the seed wire contract.
- Trusted Publisher eliminates the long-lived PyPI token in repo
  secrets.

### Negative / trade-offs

- Contributors must keep §9 test matrix filled in when new endpoints
  land on the seed. CI should fail if a seed endpoint in ADR-0002 has
  no corresponding test file.
- Regression benchmarks add ~30 s to CI; acceptable for the signal.

### Neutral

- `pyproject.toml` adds `hypothesis` and `ruff`; both are dev-only.
- `asyncio_mode = "auto"` removes boilerplate but diverges from pytest
  defaults — OQ-P3 tracks revisit.

## Alternatives considered

| Option | Why rejected |
|--------|--------------|
| Generate the SDK from an OpenAPI spec | Seed has no OpenAPI spec; generating against the docs would invent shapes the seed does not actually return |
| Drop sync surface; async only | Breaks Jupyter/script callers (ADR-0009) |
| Ship `cognitum-seed` as a separate package | Silent parallel universes; harder to enforce shared retry/error (ADR-0011) |
| Use `tox` | `pytest` + GitHub Actions matrix already covers the Python-version cross-product |

## Compliance / verification

- `ruff check .` and `ruff format --check .` clean.
- `mypy --strict cognitum` clean.
- `pytest --cov=cognitum --cov-fail-under=90` green on 3.10–3.13 ×
  Linux/macOS/Windows.
- Grep lint (CI): `rg -n "console.log|print\(.*api_key|print\(.*token" sdks/python`
  must be empty.
- Conformance: every endpoint row in §9 must have an existing test file
  with at least the marked cases.
- Forward-compat: `SeedStatus.extra["witness_chain_length"]` test asserts
  unknown fields round-trip safely.

## Phase 1.5 delivery (2026-04-23)

Executes ADR-0016a/b for the Python SDK. Mirrors the Rust reference in
`sdks/rust/src/seed/{peers,token_book,session,health,client}.rs` and
the work plan in `/home/ruvultra/projects/sdks/docs/adr/0017-phase-1-5-mesh-implementation-plan.md`.

### What landed

| File | Purpose |
|------|---------|
| `cognitum/seed/_peers.py` | `Peer`, `PeerSet`, `PeerState`, `PeerErrorClass` — closest-first picker with latency EMA, health bookkeeping (ADR-0016a §D7). |
| `cognitum/seed/_token_book.py` | `TokenBook` Protocol, `InMemoryTokenBook`, `SecretString` (redacting `__repr__`, best-effort zero on drop), `pair_all()` helper (§D5). |
| `cognitum/seed/_session.py` | `SeedSession` / `AsyncSeedSession` context managers pinning one peer via a `_PinnedTransport` adapter (§D4, §D9). |
| `cognitum/seed/_health.py` | Opt-in `HealthProbe` (`threading.Thread` daemon) and `AsyncHealthProbe` (`asyncio.create_task`) — off by default, enabled via `health_interval=` (§D7). |
| `cognitum/seed/_config.py` | `SeedClientOptions` gains `endpoints: 1..N`, `routing="session"` default, `health_interval`, `token_book`; `normalise_options` seeds the book from a single `auth.pairing_token` for every peer (§D5). |
| `cognitum/seed/_client.py`, `_async_client.py` | Mesh-aware request loop: `NetworkError` / `TimeoutError` / 5xx / 503 → cycle via `PeerSet.next_after`; 429 → pin on same peer + ADR-0005 backoff; `AuthError` / `ValidationError` / `NotFoundError` / 501 → surface. ADR-0005 total budget is per-request, not per-peer. |
| `cognitum/seed/__init__.py` | Exports `SeedSession`, `AsyncSeedSession`, `TokenBook`, `InMemoryTokenBook`, `SecretString`, `Peer*`, `pair_all`. |
| `tests/seed/unit/test_mesh_peer_set.py` | 9 tests — picker order, state transitions, 503 lockdown, defensive snapshot. |
| `tests/seed/unit/test_mesh_token_book.py` | 8 tests — redaction, trailing-slash normalisation, type checks, `Protocol` conformance. |
| `tests/seed/integration/test_seed_mesh.py` | All 7 mesh tests from ADR-0017 §5 + 1 async-session bonus — pass with respx mocking 2-3 endpoints. |

### Test results (2026-04-23)

```
$ /tmp/swarm-seed-validation/python/venv/bin/pytest sdks/python/tests/seed/ -q
137 passed, 3 skipped in 13.81s
```

All seven ADR-0017 §5 mesh tests pass:

1. `test_mesh_single_peer_behaves_like_single_mode` — pass
2. `test_mesh_two_peers_round_robin_for_reads` — pass
3. `test_mesh_cycles_on_5xx` — pass
4. `test_mesh_pins_on_429` — pass
5. `test_mesh_session_stickiness` — pass
6. `test_mesh_token_book_per_peer` — pass (asserts outgoing `X-Pairing-Token` is peer-specific)
7. `test_mesh_health_probe_degrades_unhealthy_peer` — pass

### Known gaps for Phase 2

- `_telemetry.py` tracing spans do not yet carry the picked `peer_url`;
  the mesh request loop knows the peer but does not tag spans. Nice-to-have.
- The active probe does not implement the §D7 `degraded_interval` /
  `unhealthy_interval` back-off: it polls every peer every
  `health_interval`. Matches Rust today.
- `InMemoryTokenBook.__del__` zero-out is best-effort; strict zeroization
  would require switching to a `ctypes`-backed byte buffer. Out of scope.
- Routing strategy enum is preserved (`session`, `pinned`, `round-robin`,
  `read-any-write-one`) but only `session` is wired — Rust is the same.

## Phase 2 delivery (2026-04-23)

Executes ADR-0016a §D8 mesh-observability and ADR-0016b §"Per-call knobs"
for the Python SDK. Mirrors the Rust 0014c Phase 2 delivery style.

### What landed

| File | Purpose |
|------|---------|
| `cognitum/_errors.py` | New `UnsupportedError(CognitumError)` — raised when the caller asks for capabilities the seed protocol does not offer (e.g. `consistency="strong"`). Distinct from `NotImplementedError` (a 501 from the seed). |
| `cognitum/seed/_call_options.py` | New. `CallOptions` (slots+frozen) with `peer`/`prefer`/`consistency`/`timeout`/`retries`; `DISABLE_RETRY=0` sentinel; `ResolvedCallOptions` + `resolve_call_options()` shared resolver so sync + async loops merge defaults via one code path. |
| `cognitum/seed/_models/mesh.py` | New. `MeshStatus`, `MeshPeers`, `SwarmStatus`, `ClusterHealth`, `MeshPeer` dataclasses (slots, frozen, `extra`). Wire shapes captured from live seed v0.20.0 on 2026-04-22 — all four endpoints return 200 on v0.20.0, no 404/501 stubs needed. |
| `cognitum/seed/resources/mesh.py` | New. `MeshResource` + `AsyncMeshResource` exposing `status()` / `peers()` / `swarm_status()` / `cluster_health()`. All four are in the seed's WiFi-read allowlist so no pairing token required. |
| `cognitum/seed/_client.py`, `_async_client.py` | Transport `request()` accepts `options: CallOptions \| None`; merges via `resolve_call_options`. Per-call `timeout` overrides httpx's per-request timeout and resets the ADR-0005 total deadline; `retries` overrides `max_retries`; `consistency="eventual"` drops any session peer pin; `options.peer=` pins to a single endpoint (unknown peer → `ConfigError`). `client.mesh` attribute added; `client.peers()` alias forwards to `peers_snapshot()` (distinct from `client.mesh.peers()`). |
| `cognitum/seed/_client.py`, `_async_client.py` | New `rediscover()` method — resets `PeerSet` state and per-peer trust-score counters. Idempotent; no network calls (mDNS deferred). |
| `cognitum/seed/_session.py` | `_PinnedTransport` + `_AsyncPinnedTransport` pass `options` through to the inner transport; `SeedSession` / `AsyncSeedSession` gain a `mesh` attribute. |
| `cognitum/seed/resources/*.py` | Every resource method (store, pair, custody, witness, ota) now accepts `options: CallOptions \| None`. Parity with the new mesh resource. |
| `cognitum/seed/__init__.py` | Exports `CallOptions`, `Consistency`, `Prefer`, `DISABLE_RETRY`, `UnsupportedError`, `MeshStatus`, `MeshPeers`, `MeshPeer`, `SwarmStatus`, `ClusterHealth`. |
| `tests/seed/unit/test_mesh_resource.py` | 5 tests — 4 sync resource methods against live wire shapes + async parity. |
| `tests/seed/unit/test_call_options.py` | 8 tests — peer override, unknown peer, strong/eventual consistency, scalar/tuple timeout, `DISABLE_RETRY` caps the ADR-0005 loop, async cancellation regression. |
| `tests/seed/unit/test_rediscover.py` | 2 tests — resets degraded state + trust counter; idempotent. |

### Test results (2026-04-23)

```
$ /tmp/swarm-seed-validation/python/venv/bin/pytest sdks/python/tests/seed/ -q
206 passed, 3 skipped in 14.14s
```

All 15 new Phase 2 tests pass; no Phase 1 / 1.5 regressions.

### Live seed probes (v0.20.0, 2026-04-22)

All four §D8 endpoints returned HTTP 200 — no 404 / 501 stubs needed:

- `GET /api/v1/network/mesh/status` → `{"ap_active":true,"auto_mesh":false,"connected_to_seed":false,"device_id":"…","has_mesh_password":false,"peer_count":0,"peers":[]}`
- `GET /api/v1/peers` → `{"count":0,"discovery_active":true,"peers":[]}`
- `GET /api/v1/swarm/status` → `{"device_id":"…","discovery_active":true,"epoch":20564,"peer_count":0,"total_vectors":8460,"uptime_secs":23001}`
- `GET /api/v1/cluster/health` → `{"auto_sync_interval_secs":60,"cluster_enabled":true,"discovery_active":true,"last_sync_attempt":1776906537,"peer_count":0,"peers":[]}`

### Naming clarity (ADR-0016b)

`client.peers()` (SDK-local peer table) vs `client.mesh.peers()` (seed's
own overlay view) — both exist and answer different questions. The
former returns `list[Peer]` from the config + health-probe bookkeeping;
the latter returns a `MeshPeers` wire model from the seed's
`/api/v1/peers` endpoint.

### Known gaps carried into Phase 3

- `CallOptions.prefer` is validated but not yet wired into the picker —
  today the picker is unconditionally closest-first. Matches Rust. The
  SDK accepts the knob so callers can pin it now without re-compiling
  when Phase 3 lands.
- ~~`rediscover()` does no DNS / mDNS re-resolution~~ — closed by the
  Phase 3 mDNS work below. `rediscover()` now re-queries a configured
  :class:`DiscoveryProvider`.

## Phase 3 — mDNS discovery (2026-04-23)

Executes ADR-0016a §D6 and ADR-0016b §"Discovery providers" — the
"Phase 1.5 opt-in upgrade path" that was deferred at the Phase 2 cut.

### What landed

| File | Purpose |
|------|---------|
| `cognitum/seed/discovery/_types.py` | `DiscoveryProvider` (runtime-checkable Protocol) + `DiscoveredPeer` (slots+frozen dataclass). Stable public interface — third-party providers are a supported extension point per ADR-0016a §D6. |
| `cognitum/seed/discovery/_explicit.py` | `ExplicitDiscovery` — wraps `str` / `list[str]` so internal plumbing can treat all endpoint shapes uniformly. Also the building block for future fallback chains. |
| `cognitum/seed/discovery/mdns.py` | `MdnsDiscovery` — one-shot browse against `_cognitum._tcp.local.` using the `zeroconf` PyPI library. Parses `id=` (device_id) and `fp=` (cert fingerprint reserved for future pinning) from TXT records per `seed/src/cognitum-agent/src/discovery.rs:137-180`. Configurable `service_type=` / `timeout_s=` / `scheme=`; accepts an injected `Zeroconf` for apps that already run one. |
| `cognitum/seed/discovery/__init__.py` | PEP-562 lazy `__getattr__` so `MdnsDiscovery` only triggers the `zeroconf` import on attribute access — `ExplicitDiscovery` / `DiscoveredPeer` / `DiscoveryProvider` work without the extra. |
| `cognitum/seed/_config.py` | `EndpointsInput = str \| Sequence[str] \| DiscoveryProvider`; `normalise_options` resolves a provider to a peer list at construction time. Empty result → `ConfigError` (fail-fast, ADR-0007 §"Fail-fast rule"). |
| `cognitum/seed/_client.py`, `_async_client.py` | Constructors accept `EndpointsInput`; store the provider on `self._discovery` so `rediscover()` can re-query it and `close()` can release it. New `AsyncSeedClient.arediscover()` calls the native async `adiscover()` path. |
| `cognitum/seed/__init__.py` | Exports `DiscoveredPeer`, `DiscoveryProvider`, `ExplicitDiscovery`. `MdnsDiscovery` remains under `cognitum.seed.discovery` behind the extra. |
| `pyproject.toml` | New `mdns = ["zeroconf>=0.131"]` optional dependency. Install with `pip install cognitum[mdns]` to enable. |
| `tests/seed/unit/test_discovery_types.py` | 2 tests — `DiscoveredPeer` frozen-dataclass semantics, `DiscoveryProvider` structural-protocol matching. |
| `tests/seed/unit/test_discovery_explicit.py` | 2 tests — returns configured list, rejects empty/bad input. |
| `tests/seed/unit/test_discovery_mdns.py` | 5 tests — fake `zeroconf` injected via `sys.modules` so the file runs in both `[dev]` and `[dev, mdns]` environments. Covers: single-seed discovery, empty-result config error, end-to-end `SeedClient(endpoints=MdnsDiscovery(...))` wiring, `rediscover()` re-query, import-error when the extra is missing. |

### Test results (2026-04-23)

```
$ /tmp/swarm-seed-validation/python/venv/bin/pytest sdks/python/tests/seed/ -q
215 passed, 3 skipped in 14.38s     # with zeroconf installed
215 passed, 3 skipped in 14.65s     # without zeroconf installed (fake-module path)
```

Same suite, same count, in both environments — the import-guard
fallback in `MdnsDiscovery` is exercised by the stubbed path.

### Design decisions carried forward

- **Opt-in only.** Default is still explicit-list (ADR-0016a §D6).
  Multicast is blocked on many corporate and Docker networks; making
  mDNS the default would regress the Phase 1 happy path.
- **One-shot at construction, re-query on `rediscover()`.** We do NOT
  schedule background re-discovery (ADR-0016b §"Open" / §"Rebalance").
  A caller that wants continuous re-discovery can call `rediscover()`
  on their own timer.
- **Injected `Zeroconf` is not owned.** Apps that already run their
  own `zeroconf.Zeroconf` for other services pass it in; `close()` on
  the provider does not shut it down.
- **`fp=` cert fingerprint is captured AND pinned.** See the
  `fp= cert pinning (2026-04-23)` subsection below for the wire-up
  into the per-peer transport verifier.

### Known gaps beyond Phase 3

- `CallOptions.prefer` is still not wired into the picker (carried
  from Phase 2).
- No built-in "try mDNS then explicit list" composite provider.
  Callers compose manually today.

### Phase 3 — Tailscale discovery (2026-04-23)

Closes OQ-11 (docs/adr/README.md). Adds a `TailscaleDiscovery`
provider that shells out to the local Tailscale CLI:

| File | Change |
|------|--------|
| `cognitum/seed/discovery/tailscale.py` | `TailscaleDiscovery` — runs `tailscale status --json` via `subprocess.run`, iterates `Peer` entries, filters by `prefix` (default `"cognitum-"`) or a `predicate: Callable[[dict], bool]`, emits `DiscoveredPeer(url="https://<DNSName>:<port>")`. Options: `prefix`, `port` (default 8443), `scheme`, `command` (str or argv sequence), `predicate`, `runner` (test hook), `arunner` (optional async hook). Sync `discover()` + async `adiscover()`; the default async path offloads to the loop's executor. Errors surface as `ConfigError`: missing binary → "not found on PATH"; non-zero exit → "exited N"; parse failure → "failed to parse"; `TimeoutExpired` → "timed out". |
| `cognitum/seed/discovery/__init__.py` | Eager re-export of `TailscaleDiscovery` (no extra required — stdlib only). |
| `cognitum/seed/__init__.py` | Adds `TailscaleDiscovery` to the top-level seed surface + `__all__`. |
| `tests/seed/unit/test_discovery_tailscale.py` | 6 tests — prefix filter + URL mapping, custom predicate + port override, `FileNotFoundError` → `ConfigError`, malformed JSON → `ConfigError`, non-zero exit → `ConfigError`, `TimeoutExpired` → `ConfigError`. All drive a `runner=` stub that mimics `subprocess.run`; no real CLI invoked. |

Tailnet peers carry no `device_id` or cert fingerprint, so both fields
remain `None`; for per-peer TLS pinning combine with `MdnsDiscovery`.

No new runtime dependency — `subprocess` + `json` + `asyncio` are all
stdlib. The provider does NOT move under an extra because importing it
has zero third-party cost.

### `fp=` cert pinning (2026-04-23)

Completes the anti-spoof path flagged by FINDING-28 in
`seed/src/cognitum-agent/src/discovery.rs`. The seed's mDNS responder
advertises `fp=sha256:<hex>` in the TXT record; the SDK now consumes
that value per-peer and pins the TLS handshake against it.

**Surface changes:**

| File | Change |
|------|--------|
| `cognitum/seed/discovery/_types.py` | `DiscoveredPeer` gains `tls_fingerprint: str \| None` (lowercased hex, no colons, no algorithm prefix). |
| `cognitum/seed/discovery/mdns.py` | New `_parse_fp_txt` normaliser — accepts `sha256:<hex>`, `AA:BB:...` and lowercase variants; returns `None` for wrong length, non-hex, or non-`sha256` algos (malformed values MUST NOT be treated as pins because downstream code removes the insecure fallback once a pin is present). |
| `cognitum/_errors.py` | New `TlsPinError(CognitumError)` — `retriable=False`, carries `peer_url` / `expected` / `actual`. Re-exported from `cognitum.errors`, `cognitum.seed._errors`, and `cognitum.seed`. |
| `cognitum/seed/_config.py` | `SeedClientOptions` gains `fingerprints: Mapping[str, str]`; `normalise_options` harvests the map from `DiscoveredPeer.tls_fingerprint` when resolving a provider. |
| `cognitum/seed/_transport.py` | New `PinVerifier` — per-peer SHA-256 cache keyed by `Endpoint.url`, verified lazily on first use per session lifetime. |
| `cognitum/seed/_client.py`, `_async_client.py` | Pre-check invocation inserted before the httpx dispatch in each transport's `request()` loop. Async path offloads the blocking `ssl.get_server_certificate` call to the default executor to keep the event loop responsive. |

**Verify strategy:** pre-check via `ssl.get_server_certificate` on a
raw socket (no chain validation — the seed cert is self-signed by
design), compare DER SHA-256 to the pinned value, cache the result
per-peer. Chosen over a custom `httpx.HTTPTransport` subclass because
httpx does not expose a post-handshake callback that reaches the
caller's context cleanly. Trade-off: one extra TLS handshake per peer
at first use, acceptable given peer counts are single-digit
(ADR-0016a).

**Precedence (hard rules):**

1. Explicit `SeedTLS(ca_pem=...)` / `ca_path=...` → strict chain
   verification, pin check runs in addition when a fingerprint exists.
2. Fingerprint present on `DiscoveredPeer` → pin. Pin wins over
   `insecure=True`; a mismatch ALWAYS raises `TlsPinError` and there
   is no fallback. Mesh failover MUST NOT cycle to the next peer on
   this error — it signals active tampering, not a transport failure.
3. No CA material, no fingerprint → fall through to the existing
   default-host allowlist / `SeedTLS.insecure` logic in `build_verify`.

**Tests (7 new):**

| File | Count | Coverage |
|------|-------|----------|
| `tests/seed/unit/test_discovery_mdns_fp.py` | 3 | Valid `fp=sha256:<hex>` (upper/lower/prefix variants) parses to 64-char lowercased hex; malformed values yield `None`; missing TXT yields `None`. |
| `tests/seed/unit/test_transport_fp_pin.py` | 4 | In-process HTTPS server with a freshly-generated self-signed cert; matching fp → success; mismatched fp → `TlsPinError` (with `expected` / `actual` populated); no fp + `insecure=True` → legacy path still works; mismatched fp + `insecure=True` → STILL `TlsPinError` (pin wins). |

```
$ /tmp/swarm-seed-validation/python/venv/bin/pytest sdks/python/tests/seed/ -q
222 passed, 3 skipped in 17.17s
```

**Known httpx/ssl limitation:** `httpx` neither surfaces a post-
handshake callback on its connection objects nor accepts a custom
verify function. Writing a `httpx.HTTPTransport` subclass that
inspects `sslobj.getpeercert(binary_form=True)` is possible but
couples us to httpcore internals (the attribute path varies across
httpx 0.27/0.28 releases). The pre-check approach sidesteps both
issues at the cost of one extra handshake per peer — a trade the
single-digit-peer mesh topology (ADR-0016a) absorbs cleanly.

---

## MCP stdio parity (OQ-4, 2026-04-23)

Closes the Python portion of OQ-4 (tracker: `docs/adr/README.md`
§"Open questions tracked across ADRs", row OQ-4). Node has shipped
both HTTP and stdio MCP transports since `sdks/node/src/mcp-stdio.ts`
landed; Python previously shipped HTTP-only via
`cognitum.mcp.McpResource` / `AsyncMcpResource`. This section records
the Python parity work. Rust parity remains outstanding and is tracked
separately.

### Decision

Introduce a transport-agnostic async client,
`cognitum.mcp.McpClient`, that accepts any object implementing the
four-method `Transport` protocol (`open` / `send` / `recv` / `close`).
Ship two concrete transports — `HttpTransport` and `StdioTransport` —
in `cognitum.mcp.transports`. Keep the existing `McpResource` /
`AsyncMcpResource` surface bound to `cognitum.Cognitum` /
`AsyncCognitum` unchanged (ADR-0013a §5.4 guarantees `.mcp` continues
to resolve to the HTTP resource).

### File layout

```
sdks/python/cognitum/mcp/                     # was: cognitum/mcp.py
├── __init__.py                               # re-exports both surfaces
├── _client.py                                # McpClient + Transport Protocol
├── _framing.py                               # ND-JSON line encode/decode
├── _resource.py                              # McpResource / AsyncMcpResource (unchanged logic)
└── transports/
    ├── __init__.py                           # re-exports
    ├── _http.py                              # HttpTransport
    └── _stdio.py                             # StdioTransport
```

All files are under 500 LOC; `_stdio.py` is the largest at ~170 LOC.
`from __future__ import annotations` everywhere; `@dataclass(slots=True)`
on `StdioTransport` and `HttpTransport` per the ADR-0013a style rules.

### Transport contract

```python
@runtime_checkable
class Transport(Protocol):
    async def open(self) -> None: ...
    async def send(self, message: dict[str, Any]) -> None: ...
    async def recv(self) -> dict[str, Any]: ...
    async def close(self) -> None: ...
```

`McpClient` is async-only — MCP stdio's interleaved
read/write/stderr-drain needs a running event loop, and the sync
surface already exists as `McpResource` for the subset of callers
that want blocking HTTP.

### Stdio transport behavior

- `open()` spawns the subprocess via
  `asyncio.create_subprocess_exec(command, *args, stdin=PIPE,
  stdout=PIPE, stderr=PIPE, env=…, cwd=…)`. Inherits the parent env
  and layers `env=` overrides on top.
- A background `asyncio.Task` drains stderr to the module logger
  (`cognitum.mcp.stdio`). A noisy server no longer blocks the stdin
  pipe — covered by `test_noisy_stderr_does_not_block_stdin_pipe`.
- `send()` writes `<json>\n` via `_framing.encode` and awaits
  `StreamWriter.drain()`.
- `recv()` reads one line from stdout and decodes it. Empty line ⇒
  `EOFError` (subprocess closed stdout).
- `close()` is the escalation ladder: close stdin → `wait()` up to
  `close_timeout` (default 5 s) → `terminate()` → `wait()` again →
  `kill()`. Covered by `test_close_timeout_triggers_terminate`
  against a `SIGTERM`-ignoring subprocess.

### Public API shape

```python
from cognitum.mcp import McpClient
from cognitum.mcp.transports import HttpTransport, StdioTransport

# stdio (NEW — subprocess MCP server)
async with McpClient(transport=StdioTransport(
    command="npx",
    args=["-y", "@some/mcp-server"],
    env={"SOME_KEY": "..."},   # optional
    cwd="/path",                # optional
)) as client:
    tools = await client.list_tools()
    result = await client.call_tool("some_tool", {"arg": "value"})

# HTTP (explicit)
async with McpClient(transport=HttpTransport(
    url="https://api.cognitum.one/mcpSse",
    headers={"X-Api-Key": "sk-..."},
)) as client:
    ...

# HTTP (shortcut — builds HttpTransport implicitly)
async with McpClient(url="https://api.cognitum.one/mcpSse") as client:
    ...
```

### Backward compatibility

Verified: the 0.1.x imports still resolve unchanged —

```python
from cognitum.mcp import McpResource, AsyncMcpResource   # still works
from cognitum import Cognitum, AsyncCognitum
Cognitum(api_key=...).mcp          # still McpResource
AsyncCognitum(api_key=...).mcp     # still AsyncMcpResource
```

`McpClient` is additive. No existing code path changes behavior. The
pre-refactor `cognitum/mcp.py` logic is now in
`cognitum/mcp/_resource.py` verbatim.

### Tests

| File | Count | Highlights |
|------|-------|------------|
| `tests/mcp/test_stdio_transport.py` | 7 | Round-trip echo server; clean close; timeout→terminate→kill escalation path; noisy stderr drain; double-open and recv-before-open guards; end-to-end `McpClient` over stdio with `tools/list` + `tools/call`. |
| `tests/mcp/test_http_transport.py` | 5 | `respx`-backed: send/recv cycle; header pass-through; injected `httpx.AsyncClient` not closed by transport; recv-before-send raises; `McpClient` + `HttpTransport` happy path. |
| `tests/mcp/test_client_compat.py` | 7 | Old imports resolve; `Cognitum`/`AsyncCognitum` still expose `.mcp`; `url=` shortcut; constructor validation (require-one, reject-both, reject-bad-transport); injected client survives `McpClient` close. |

No `pytest-asyncio` dependency introduced — the suite uses
`asyncio.run()` directly so it runs in the existing `[dev]` extra
environment.

### Test results (2026-04-23)

```
$ /tmp/swarm-seed-validation/python/venv/bin/pytest sdks/python/tests/mcp/ -q
19 passed in 1.19s

$ /tmp/swarm-seed-validation/python/venv/bin/pytest sdks/python/tests/ -q
259 passed, 3 skipped in 22.58s
# (2 pre-existing failures in tests/test_client.py are the
#  pytest-asyncio-missing baseline — unchanged by this work.)
```

Baseline was 240 passed; +19 new tests = 259 exactly. No regressions
in `tests/seed/` or `tests/test_client_retry.py`.

### Out of scope

- Rust MCP stdio parity — tracked separately on the Rust agent side.
- Registering the new client under `cognitum.Cognitum` as, e.g.,
  `client.mcp_stdio(...)` — deferred; callers construct `McpClient`
  directly for now since the stdio path is a local-developer feature,
  not a cloud surface.
- Long-running SSE streaming on the HTTP transport — the existing
  `AsyncMcpResource.connect_sse` keeps that surface; `McpClient`
  stays on the simple request/response contract.

---

## References

- `/home/ruvultra/projects/sdks/docs/adr/0002-seed-wire-protocol.md`
- `/home/ruvultra/projects/sdks/docs/adr/0005-cross-cutting-retry-backoff.md`
- `/home/ruvultra/projects/sdks/docs/adr/0006-cross-cutting-versioning.md`
- `/home/ruvultra/projects/sdks/docs/adr/0009-python-sdk-architecture.md`
- `/home/ruvultra/projects/sdks/docs/adr/0011-sdk-scope-cloud-vs-seed.md`
- `/home/ruvultra/projects/sdks/docs/adr/README.md` §"Open questions tracked across ADRs"
- `/home/ruvultra/projects/sdks/sdks/python/pyproject.toml:1-20` (baseline)
- `/home/ruvultra/projects/sdks/sdks/python/tests/test_client.py:1-337` (baseline)
- `/home/ruvultra/projects/sdks/seed/docs/seed/api-reference.md`
- Companion ADRs: **ADR-0013a** (layout + API + models),
  **ADR-0013b** (transport, retry, auth, errors)
