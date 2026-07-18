"""Shared per-call request context (ADR-0019 §D5) and budget policy
(ADR-0022 §D6).

Type-only scaffolding (issue #52 / M1).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from cognitum.agentic.credentials import CredentialProvider
    from cognitum.agentic.errors import CancellationToken, TimeBudget

#: How the SDK should treat an operation whose cost estimate is unknown.
OnUnknownEstimate = Literal["reject", "allow_server_enforcement"]


@dataclass(frozen=True)
class BudgetPolicy:
    """Client-side spend guard, not an accounting authority (ADR-0022 §D6)."""

    on_unknown_estimate: OnUnknownEstimate
    max_estimated_cost: float | None = None
    max_committed_cost: float | None = None
    currency: str | None = None
    max_tier: str | None = None
    allow_escalation: bool | None = None
    reservation_ttl_ms: int | None = None


@dataclass(frozen=True)
class TenantContext:
    """Resolved tenant binding for a request.

    Never a generic caller override (ADR-0022 §D4) -- the authenticated
    service derives account/tenant from the credential; this type only
    carries the already-resolved, opaque binding.
    """

    tenant_id: str | None = None
    delegated_subtenant_id: str | None = None


@dataclass(frozen=True)
class RequestContext:
    """Per-call request context shared across every agentic product client
    (ADR-0019 §D5): identity, correlation, idempotency, budget, timeouts,
    and cancellation.

    Product-specific fields (routing plane, safety mode, solve input, etc.)
    do NOT belong here.
    """

    request_id: str
    normalized_origin: str
    correlation_id: str | None = None
    idempotency_key: str | None = None
    tenant: TenantContext | None = None
    credential_provider: CredentialProvider | None = None
    budget_policy: BudgetPolicy | None = None
    time_budget: TimeBudget | None = None
    cancellation: CancellationToken | None = None
    #: Optional trace-context carrier (e.g. W3C traceparent/tracestate).
    tracing_carrier: dict[str, str] | None = None


__all__ = [
    "OnUnknownEstimate",
    "BudgetPolicy",
    "TenantContext",
    "RequestContext",
]
