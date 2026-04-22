# ADR 0013a: Python SDK — Module Layout, Public API, Typed Models

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** SDK working group
- **Scope:** sdks/python
- **Part of:** ADR-0013 (split into 0013a/0013b/0013c for size)
- **Implements:** ADR-0002, ADR-0006, ADR-0009, ADR-0011

## Context

ADR-0009 fixes the Python SDK's architecture (dual sync/async, `httpx` only,
`cognitum.seed` submodule for seed-direct traffic). ADR-0011 confirms the
one-package / subpath split. The current package under
`/home/ruvultra/projects/sdks/sdks/python/` is Cloud-only and is missing
the entire `cognitum.seed` submodule (no `seed/` directory exists). It also
has a weak unknown-field story: parsing today is either explicit
`.get()` (good, cf. `sdks/python/cognitum/devices.py:11-19`) or direct
`json()` pass-through that loses structure when a new field shows up.

This ADR (a) is the implementation blueprint for the layout and public
surface and (b) specifies the typed wire models against the seed HTTP
contract captured in ADR-0002 and grounded in
`/home/ruvultra/projects/sdks/seed/docs/seed/api-reference.md`.

## Decision

Rewrite the package in place (no separate crate) into the layout in §1.
The rewrite is MINOR-breaking under ADR-0006 §Pre-1.0 relaxation; the
first release carrying this ADR series is `cognitum==0.2.0`.

---

## 1. Module layout

```
sdks/python/
├── pyproject.toml
├── README.md                         # Cloud + seed tour, compat matrix
├── cognitum/
│   ├── __init__.py                   # Re-exports Cognitum, AsyncCognitum, errors, types
│   ├── py.typed                      # PEP 561 marker
│   ├── _version.py                   # __version__ = "0.2.0"
│   ├── _http.py                      # Sync+async HTTP core (retry, auth, error map)
│   ├── _auth.py                      # Credential resolution + redaction
│   ├── _retry.py                     # Equal-jitter backoff; Retry-After parsing
│   ├── _telemetry.py                 # Logging + redaction regex + correlation IDs
│   ├── _models.py                    # Base dataclass helpers (extra_fields, from_wire)
│   ├── _errors.py                    # 12-variant exception hierarchy (ADR-0004)
│   ├── errors.py                     # Public re-exports (backward compat)
│   ├── types.py                      # Cloud response dataclasses (existing, extended)
│   ├── client.py                     # Cognitum (sync) — cloud
│   ├── async_client.py               # AsyncCognitum (async) — cloud
│   ├── catalog.py                    # Cloud resource (existing)
│   ├── orders.py                     # Cloud resource (existing)
│   ├── leads.py                      # Cloud resource (existing)
│   ├── contact.py                    # Cloud resource (existing)
│   ├── devices.py                    # Cloud resource (existing, ACL for cloud↔seed)
│   ├── mcp.py                        # Cloud resource (existing)
│   ├── brain.py                      # Cloud resource (existing)
│   └── seed/
│       ├── __init__.py               # Re-exports SeedClient, AsyncSeedClient, seed models
│       ├── _pinning.py               # SeedPinnedVerifier (TLS trust)
│       ├── _transport.py             # Thin seed-flavoured httpx.Client factory
│       ├── client.py                 # SeedClient (sync)
│       ├── async_client.py           # AsyncSeedClient (async)
│       ├── models.py                 # Seed wire dataclasses (Status, StoreQueryResult…)
│       ├── status.py                 # GET /status, /identity
│       ├── pairing.py                # /pair, /pair/status, DELETE /pair/{name}
│       ├── store.py                  # /store/{status,ingest,query,delete,sync}
│       ├── optimizer.py              # /optimize/*, /boundary, /boundary/recompute
│       ├── custody.py                # /custody/*, /witness/chain, /witness/verify
│       ├── delivery.py               # /delivery/image, /delta/history, /delta/stream (501)
│       ├── sensor.py                 # /sensor/* (17 routes)
│       ├── coherence.py              # /coherence/* (5 routes)
│       ├── thermal.py                # /thermal/* (13 routes)
│       └── profiles.py               # /profiles, /demo/*
├── examples/
│   ├── cloud_tour.py
│   └── seed_tour.py
└── tests/
    ├── __init__.py
    ├── conftest.py
    ├── test_cloud_client.py
    ├── test_seed_client.py
    ├── test_retry.py
    ├── test_errors.py
    ├── test_auth_redaction.py
    ├── test_tls_pinning.py
    ├── fixtures/seed/*.json
    ├── conformance/
    └── benchmarks/
```

Files moved from current tree keep their public module path; nothing
public from `cognitum.*` is removed. Private helpers (`_http`, `errors`)
are split so the cloud and seed halves share a single transport.

Cited current-state files:

- `sdks/python/cognitum/__init__.py:1-76` — re-exports
- `sdks/python/cognitum/client.py:1-84` — sync cloud client
- `sdks/python/cognitum/async_client.py:1-84` — async cloud client
- `sdks/python/cognitum/_http.py:1-234` — transport
- `sdks/python/cognitum/errors.py:1-49` — errors
- `sdks/python/cognitum/types.py:1-200` — cloud dataclasses
- `sdks/python/cognitum/devices.py:11-19` — parser pattern to generalize
- `sdks/python/pyproject.toml:1-20` — packaging
- `sdks/python/tests/test_client.py:1-337` — cloud tests baseline

---

## 2. Public API surface

All signatures use `from __future__ import annotations`. All keyword args
are keyword-only. All public entry points are context managers.

### 2.1 `cognitum.Cognitum` (sync, cloud)

```python
from __future__ import annotations
from types import TracebackType
from cognitum._http import SyncHttpClient
from cognitum._auth import Credentials
from cognitum.types import HealthResponse

class Cognitum:
    catalog: "CatalogResource"
    orders: "OrdersResource"
    leads: "LeadsResource"
    contact: "ContactResource"
    devices: "DevicesResource"
    mcp: "McpResource"
    brain: "BrainResource"

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = "https://api.cognitum.one",
        timeout: float = 30.0,
        max_retries: int = 3,
        max_elapsed: float = 60.0,
        http_client: "httpx.Client | None" = None,
    ) -> None: ...

    def health(self) -> HealthResponse: ...
    def close(self) -> None: ...
    def __enter__(self) -> "Cognitum": ...
    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None: ...
```

`api_key` resolution (ADR-0003): explicit arg → `COGNITUM_API_KEY` →
raise `AuthError(reason=NoCredentials)` before the first request.

### 2.2 `cognitum.AsyncCognitum` (async, cloud)

Symmetric to `Cognitum` with `async def` methods and
`__aenter__ / __aexit__`. Every resource class has an `Async…` twin. See
`sdks/python/cognitum/async_client.py:1-84` for the baseline shape.

<!-- ❌ failing 2026-04-22 (issue cognitum-one/sdks#2): cognitum.seed package does NOT exist. No SeedClient, no AsyncSeedClient, no seed/_pinning.py, no seed/models.py. Validator harness drove cognitum._http.SyncHttpClient directly against https://localhost:18443 (11 seed endpoints — 10/11 status==200 verified, /api/v1/delta/stream wire_mismatch → issue cognitum-one/seed#48). -->

### 2.3 `cognitum.seed.SeedClient` (sync, seed-direct)

```python
from __future__ import annotations
import ssl
from pathlib import Path
from typing import Union
from cognitum.seed._pinning import SeedPinnedVerifier
from cognitum.seed.models import (
    SeedStatus, PairStatus, PairResult, StoreStatus,
    StoreQueryResult, WitnessChain, CoherenceProfile,
    ThermalState, DriftStatus,
)

VerifyOption = Union[bool, str, Path, ssl.SSLContext, SeedPinnedVerifier]

class SeedClient:
    status: "StatusResource"
    pairing: "PairingResource"
    store: "StoreResource"
    optimizer: "OptimizerResource"
    custody: "CustodyResource"
    delivery: "DeliveryResource"
    sensor: "SensorResource"
    coherence: "CoherenceResource"
    thermal: "ThermalResource"
    profiles: "ProfilesResource"

    def __init__(
        self,
        *,
        host: str = "169.254.42.1",
        port: int = 8443,
        pairing_token: str | None = None,
        client_cert: tuple[str, str] | None = None,  # (cert_pem_path, key_pem_path)
        verify: VerifyOption = True,                 # True = pin self-signed for default hosts
        timeout: float = 30.0,
        max_retries: int = 3,
        max_elapsed: float = 60.0,
        dangerously_insecure: bool = False,
    ) -> None: ...

    # Convenience surface — forwards to resources
    def get_status(self) -> SeedStatus: ...
    def pair(self, client_name: str) -> PairResult: ...
    def close(self) -> None: ...
    def __enter__(self) -> "SeedClient": ...
    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None: ...
```

### 2.4 `cognitum.seed.AsyncSeedClient`

Same shape as `SeedClient`, with `async def`, `__aenter__ / __aexit__`,
and async iterators for stream endpoints (§streaming in ADR-0013c).

### 2.5 Representative method body — `store.query`

Shows retry + auth + error mapping composed into one real method.
Helpers are defined in ADR-0013b §transport and §retry.

```python
# cognitum/seed/store.py
from __future__ import annotations
from collections.abc import Sequence
from typing import Any, Literal
from cognitum._http import SyncHttpClient
from cognitum.seed.models import StoreQueryResult, QueryMatch

class StoreResource:
    def __init__(self, http: SyncHttpClient) -> None:
        self._http = http

    def query(
        self,
        vector: Sequence[float],
        *,
        k: int = 10,
        metric: Literal["cosine", "euclidean", "dot"] = "cosine",
        filter: dict[str, Any] | None = None,
    ) -> StoreQueryResult:
        """POST /api/v1/store/query — k-NN over the seed vector store.

        Raises
        ------
        ValidationError
            `k <= 0`, or `len(vector)` does not match `store/status.dimension`.
        AuthError
            Caller lacks a pairing token when the seed requires one.
        RateLimitError
            Rate limit exceeded; `retry_after_ms` is set.
        NetworkError, TimeoutError
            Transport failure (retried internally per ADR-0005).
        ApiError
            Any other 5xx after retry exhaustion.
        """
        if k <= 0:
            from cognitum._errors import ValidationError
            raise ValidationError("k must be >= 1", field="k")
        if not vector:
            from cognitum._errors import ValidationError
            raise ValidationError("vector must not be empty", field="vector")

        payload: dict[str, Any] = {
            "vector": list(vector),
            "k": k,
            "metric": metric,
        }
        if filter is not None:
            payload["filter"] = filter

        data = self._http.request(
            "POST", "/api/v1/store/query", json=payload, idempotent=True,
        )
        raw_matches = data.get("results", [])
        return StoreQueryResult(
            matches=tuple(
                QueryMatch(
                    id=int(m["id"]),
                    distance=float(m["distance"]),
                    metadata=m.get("metadata") or {},
                    extra={k: v for k, v in m.items()
                           if k not in ("id", "distance", "metadata")},
                )
                for m in raw_matches
            ),
            query_ms=float(data.get("query_ms", 0.0)),
            extra={k: v for k, v in data.items()
                   if k not in ("results", "query_ms")},
        )
```

`idempotent=True` on a `POST` is explicit because the query is
semantically safe; ADR-0005 §Idempotency rule otherwise forbids automatic
POST retries. The SyncHttpClient retry loop honours this flag by
pretending the request body was not sent between attempts.

<!-- failing 2026-04-22 (python validator): idempotent= kwarg NOT present on SyncHttpClient.request / .post. Respx probe: POST with a 500 response was retried 3x (max_retries=2) by default — violates ADR-0005 §Idempotency. Coord to file issue. -->

---

## 3. Typed models

All models are `@dataclass(slots=True, frozen=True)`. Each carries an
`extra: Mapping[str, Any] = field(default_factory=dict)` hatch for
forward-compat (ADR-0006 §Unknown-field). A shared helper converts wire
JSON to dataclass.

### 3.1 Base wire helper

```python
# cognitum/_models.py
from __future__ import annotations
from collections.abc import Mapping
from dataclasses import dataclass, field, fields
from typing import Any, ClassVar, TypeVar

T = TypeVar("T", bound="WireModel")

@dataclass(slots=True, frozen=True)
class WireModel:
    """Base for wire-facing dataclasses.

    - Reads are permissive: unknown fields go to `extra`.
    - Writes (`to_wire`) forbid unknown fields (ADR-0006).
    """
    _strict_write: ClassVar[bool] = True

    @classmethod
    def from_wire(cls: type[T], data: Mapping[str, Any]) -> T:
        known = {f.name for f in fields(cls)} - {"extra"}
        kwargs: dict[str, Any] = {}
        extra: dict[str, Any] = {}
        for k, v in data.items():
            if k in known:
                kwargs[k] = v
            else:
                extra[k] = v
        if "extra" in known:
            kwargs["extra"] = extra
        return cls(**kwargs)  # type: ignore[arg-type]
```

### 3.2 Seed models

Source shapes pulled verbatim from
`/home/ruvultra/projects/sdks/seed/docs/seed/api-reference.md:30-42,
120-128, 402-413, 449-461` and
`/home/ruvultra/projects/sdks/seed/src/cognitum-agent/src/http.rs:136-137`.

```python
# cognitum/seed/models.py
from __future__ import annotations
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from cognitum._models import WireModel

# GET /api/v1/status
@dataclass(slots=True, frozen=True)
class SeedStatus(WireModel):
    device_id: str
    uptime_secs: int
    epoch: int
    total_vectors: int
    deleted_vectors: int
    file_size_bytes: int
    dimension: int
    paired: bool
    roles: tuple[str, ...] = ()
    extra: Mapping[str, Any] = field(default_factory=dict)

# GET /api/v1/identity
@dataclass(slots=True, frozen=True)
class Identity(WireModel):
    device_id: str
    public_key: str
    extra: Mapping[str, Any] = field(default_factory=dict)

# GET /api/v1/pair/status
@dataclass(slots=True, frozen=True)
class PairStatus(WireModel):
    paired: bool
    client_count: int
    pairing_window_open: bool
    window_remaining_secs: int = 0
    extra: Mapping[str, Any] = field(default_factory=dict)

# POST /api/v1/pair request body
@dataclass(slots=True, frozen=True)
class PairInit(WireModel):
    client_name: str
    _strict_write: bool = True  # writes forbid unknown fields

# POST /api/v1/pair response
@dataclass(slots=True, frozen=True)
class PairResult(WireModel):
    paired: bool
    token: str
    client_name: str
    extra: Mapping[str, Any] = field(default_factory=dict)

# POST /api/v1/store/ingest request
@dataclass(slots=True, frozen=True)
class VectorUpsert(WireModel):
    id: str
    values: tuple[float, ...]
    metadata: Mapping[str, Any] | None = None

@dataclass(slots=True, frozen=True)
class StoreUpsert(WireModel):
    vectors: tuple[VectorUpsert, ...]

# POST /api/v1/store/query response match
@dataclass(slots=True, frozen=True)
class QueryMatch(WireModel):
    id: int                 # numeric content-addressed ID (DDD §5.4)
    distance: float
    metadata: Mapping[str, Any] = field(default_factory=dict)
    extra: Mapping[str, Any] = field(default_factory=dict)

@dataclass(slots=True, frozen=True)
class StoreQueryResult(WireModel):
    matches: tuple[QueryMatch, ...]
    query_ms: float
    extra: Mapping[str, Any] = field(default_factory=dict)

# GET /api/v1/store/status
@dataclass(slots=True, frozen=True)
class StoreStatus(WireModel):
    total_vectors: int
    deleted_vectors: int
    dimension: int
    file_size_bytes: int
    epoch: int
    extra: Mapping[str, Any] = field(default_factory=dict)

# GET /api/v1/witness/chain  (entry shape)
@dataclass(slots=True, frozen=True)
class WitnessEntry(WireModel):
    index: int
    parent_hash: str
    action_hash: str
    signature: str
    epoch: int
    extra: Mapping[str, Any] = field(default_factory=dict)

@dataclass(slots=True, frozen=True)
class WitnessChain(WireModel):
    entries: tuple[WitnessEntry, ...]
    chain_length: int
    extra: Mapping[str, Any] = field(default_factory=dict)

# POST /api/v1/witness/verify response
@dataclass(slots=True, frozen=True)
class WitnessProof(WireModel):
    valid: bool
    chain_length: int
    head_hash: str | None = None
    extra: Mapping[str, Any] = field(default_factory=dict)

# GET /api/v1/coherence/profile
@dataclass(slots=True, frozen=True)
class CoherenceProfile(WireModel):
    temporal_coherence: float
    coherence_trend: float
    epoch_range: tuple[int, int]
    compute_ms: float
    slice_count: int
    is_partial: bool
    phase_boundaries: tuple[Mapping[str, Any], ...] = ()
    global_rupture: bool = False
    extra: Mapping[str, Any] = field(default_factory=dict)

# GET /api/v1/thermal/state
@dataclass(slots=True, frozen=True)
class ThermalState(WireModel):
    temp_mdeg: int
    temp_c: float
    zone: str                        # Cool | Warm | Hot | Critical
    d_temp: float
    throttle_flags: int
    undervolt_count: int
    time_to_next_zone_s: float | None
    freq_mhz: int
    peak_temp_mdeg: int
    extra: Mapping[str, Any] = field(default_factory=dict)

# GET /api/v1/sensor/drift/status
@dataclass(slots=True, frozen=True)
class DriftStatus(WireModel):
    drift_detected: bool
    drift_severity: float
    detector_states: Mapping[str, Any] = field(default_factory=dict)
    hd_gate_status: Mapping[str, Any] = field(default_factory=dict)
    extra: Mapping[str, Any] = field(default_factory=dict)

# Seed error body (ADR-0002 §Response envelope)
@dataclass(slots=True, frozen=True)
class SeedErrorBody(WireModel):
    error: str
    retry_after_us: int | None = None
    extra: Mapping[str, Any] = field(default_factory=dict)
```

### 3.3 Write-side strictness

Write-side dataclasses (`PairInit`, `StoreUpsert`, `VectorUpsert`) do
**not** carry an `extra` field; their `from_wire` is unused and their
`asdict` serializer rejects unexpected kwargs at construction, per
ADR-0006 §Unknown-field.

---

## Consequences

### Positive

- `cognitum.seed` submodule lands at the same `pip install cognitum` entry
  point; users discover it via `from cognitum.seed import SeedClient`.
- Forward-compat is a structural invariant (`extra` field on every read
  model), not a promise.

### Negative / trade-offs

- Package line count roughly doubles. Mitigation: per-resource modules
  keep files under 400 lines.
- `WireModel.from_wire` is slightly slower than direct `json.loads` + dict
  access. The overhead is sub-microsecond per call; benchmarked in
  ADR-0013c §Benchmarks.

### Neutral

- `py.typed` marker already shipped at
  `sdks/python/cognitum/py.typed` — no change.

## Alternatives considered

| Option | Pros | Cons | Why rejected |
|--------|------|------|--------------|
| Separate `cognitum-seed` package | Clean dependency boundary | Two installs; silent parallel universes | ADR-0011 |
| Use `pydantic` for models | Free validation + docs | 3 MB install, overkill, weaker forward-compat story | ADR-0009 |
| `TypedDict` instead of dataclasses | Zero-cost | No default values, no methods, poor IDE support | ADR-0009 |
| Drop sync surface; async only | Simpler | Breaks Jupyter/script callers | ADR-0009 |

## Compliance / verification

- `mypy --strict cognitum` clean.
- Every seed endpoint row in ADR-0002 §Endpoint inventory has at least
  one typed model or documented reason it is a pass-through.
- Forward-compat test: `SeedStatus.from_wire({..., "witness_chain_length": 12})`
  round-trips with `.extra["witness_chain_length"] == 12`.

## References

- `/home/ruvultra/projects/sdks/docs/adr/0002-seed-wire-protocol.md`
- `/home/ruvultra/projects/sdks/docs/adr/0006-cross-cutting-versioning.md`
- `/home/ruvultra/projects/sdks/docs/adr/0009-python-sdk-architecture.md`
- `/home/ruvultra/projects/sdks/docs/adr/0011-sdk-scope-cloud-vs-seed.md`
- `/home/ruvultra/projects/sdks/docs/adr/ddd/seed-domain.md`
- `/home/ruvultra/projects/sdks/seed/docs/seed/api-reference.md`
- `/home/ruvultra/projects/sdks/seed/src/cognitum-agent/src/http.rs:120-156`
- `/home/ruvultra/projects/sdks/sdks/python/cognitum/` (baseline)
- Companion ADRs: **ADR-0013b** (transport, retry, auth, errors),
  **ADR-0013c** (streaming, tests, packaging, CI, benchmarks, migration)
