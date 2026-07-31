"""HarnessaaS client (ADR-0027a). Product namespace per ADR-0019 §D2:
``cognitum.harnessaas``.

Issue #67/#68 / M5 start: ``HarnessaaSClient`` construction, wire types, and
real ``health()`` / ``solve()`` / ``lineage()`` implementations against the
REAL, deployed, synchronous upstream surface -- see
``cognitum.harnessaas.client``'s module docstring for the full scope note
(ADR-0027a's proposed async job/poll/SSE/approval/cancel/artifact contract
is explicitly NOT implemented here; neither is the webhook admin surface,
the MicroLoRA flywheel API, or the ``/api/v1/*`` IBO-console relay).

Per ADR-0019 §D4, this package depends on ``cognitum.agentic`` and MUST NOT
be imported by any other product module (``cognitum.meta_llm``,
``cognitum.meta_proxy``, ``cognitum.metaharness``).

This package is imported eagerly by callers of ``cognitum.harnessaas`` but
is NOT imported by ``cognitum/__init__.py`` itself, preserving the
cold-start import graph fix from issue #20 (matching
``cognitum.meta_llm``'s convention).
"""

from __future__ import annotations

from cognitum.harnessaas.client import HarnessaaSClient
from cognitum.harnessaas.config import (
    HarnessaaSClientConfig,
    HarnessaaSTelemetryEvent,
    HarnessaaSTelemetryHooks,
)
from cognitum.harnessaas.discovery import HarnessaaSHealth, parse_harnessaas_health
from cognitum.harnessaas.envelope import HarnessaaSResponseMeta, HarnessaaSResult
from cognitum.harnessaas.http_errors import map_harnessaas_http_error
from cognitum.harnessaas.types import (
    HarnessaaSConformanceAttestation,
    HarnessaaSCostReceipt,
    HarnessaaSLineageRecord,
    HarnessaaSLineageResult,
    HarnessaaSSolveRequest,
    HarnessaaSSolveResponse,
    HarnessaaSVertical,
    parse_conformance_attestation,
    parse_cost_receipt,
    parse_lineage_result,
    parse_solve_response,
)

__all__ = [
    "HarnessaaSClient",
    "HarnessaaSClientConfig",
    "HarnessaaSTelemetryEvent",
    "HarnessaaSTelemetryHooks",
    "HarnessaaSHealth",
    "parse_harnessaas_health",
    "HarnessaaSResponseMeta",
    "HarnessaaSResult",
    "map_harnessaas_http_error",
    "HarnessaaSVertical",
    "HarnessaaSSolveRequest",
    "HarnessaaSCostReceipt",
    "HarnessaaSConformanceAttestation",
    "HarnessaaSSolveResponse",
    "HarnessaaSLineageRecord",
    "HarnessaaSLineageResult",
    "parse_cost_receipt",
    "parse_conformance_attestation",
    "parse_solve_response",
    "parse_lineage_result",
]
