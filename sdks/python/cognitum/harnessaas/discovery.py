"""Discovery wire type: health (ADR-0027a, issue #67/#68 / M5 start).

Verified against ``cognitum-one/harnessaas@908e4a99:src/server.ts:286-304``.
``/health`` is served WITHOUT authentication (no ``authenticate()`` call in
the route handler) -- matching ``MetaLlmClient.health()``'s "process-level
response only, never identity or readiness" contract exactly.

IMPORTANT (2026-07-19 reconciliation audit, issue #67): the service also
answers on ``/healthz`` and ``/status``, but ``src/server.ts:290-292``'s own
comment documents that Cloud Run's frontend (GFE) RESERVES ``/healthz`` and
answers it with the platform's own 404 to EXTERNAL callers -- so
``/healthz`` is NOT reliably reachable from outside the container, even
though the README's local ``curl -s localhost:8080/healthz`` example works
(it never crosses a real Cloud Run frontend). ``/health`` and ``/status``
are the externally-reachable aliases. This client therefore calls
``GET /health`` as the canonical route.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class HarnessaaSHealth:
    """``health()`` response. No OpenAPI/JSON-Schema contract is published
    for this shape yet (ADR-0027a §D11 blocker #1), so only the fields
    verified directly against ``src/server.ts:293-303`` are typed;
    everything else (``genome``, ``sandbox_caps``, ...) is preserved in ``raw``.
    """

    status: str
    #: ``"mock"`` ($0, no network) or ``"live"``.
    mode: str | None = None
    backend: str | None = None
    #: Always ``"per-account"`` at HEAD.
    tenancy: str | None = None
    #: ``"firestore"`` (shared/consistent across instances) or ``"memory"`` (per-instance).
    store_backend: str | None = None
    #: Always ``True`` at HEAD.
    lineage_chain_ok: bool | None = None
    raw: dict[str, Any] = field(default_factory=dict)


def parse_harnessaas_health(data: dict[str, Any]) -> HarnessaaSHealth:
    known = {"status", "mode", "backend", "tenancy", "store_backend", "lineageChainOk"}
    return HarnessaaSHealth(
        status=str(data.get("status", "unknown")),
        mode=data.get("mode"),
        backend=data.get("backend"),
        tenancy=data.get("tenancy"),
        store_backend=data.get("store_backend"),
        lineage_chain_ok=data.get("lineageChainOk"),
        raw={k: v for k, v in data.items() if k not in known},
    )


__all__ = ["HarnessaaSHealth", "parse_harnessaas_health"]
