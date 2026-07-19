"""Data-plane routing intent and decode-time receipt verification (ADR-0025a §D5).

The SDK communicates supported intent and verifies the Proxy's decision; it
does NOT implement another router (§D5: "it does not implement another
router"). There is deliberately no planner, selector, or plane-choosing
logic in this module -- only a description of what the caller is willing to
accept (:class:`RoutingIntent`) plus the single decode-time check §D5 rule 7
mandates (:func:`assert_routing_receipt_matches_intent`).

``RoutingPlane`` and ``WorkloadPolicy`` are re-exported from
:mod:`cognitum.meta_proxy.status` -- they are declared there (referenced by
``MetaProxyStatus``) and are NOT redefined here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from cognitum.agentic import AgenticError
from cognitum.meta_proxy.status import (
    MetaProxyRoutingReceipt,
    RoutingPlane,
    WorkloadPolicy,
)

if TYPE_CHECKING:
    pass

_PRODUCT = "meta-proxy"


@dataclass(frozen=True)
class RoutingIntent:
    """The plane/policy envelope a caller is willing to accept for one
    inference call (ADR-0025a §D5).

    This is a declaration, not an instruction: the Proxy owns the actual
    routing decision. The SDK only (a) communicates this intent and (b)
    verifies the returned receipt against it
    (:func:`assert_routing_receipt_matches_intent`).

    ``workload_policy`` defaults to ``"standard"`` -- the neutral policy in
    §D5's ``critical | standard | economy`` set (``critical`` suppresses
    automatic failover per rule 3, so it is never a safe silent default).
    """

    #: If set, the receipt's ``selected_plane`` MUST equal this or the call
    #: is a protocol violation "even if output succeeds" (§D5 rule 7).
    required_plane: RoutingPlane | None = None
    #: Planes the caller will accept. Empty means "no explicit restriction
    #: beyond ``required_plane``"; the SDK does not enforce this list itself
    #: (no SDK router, §D5) -- it is transmitted for the Proxy to honor.
    allowed_planes: list[RoutingPlane] = field(default_factory=list)
    workload_policy: WorkloadPolicy = "standard"
    #: Utilization ceiling above which the caller prefers not to route to an
    #: automatic plane. Implementation data, not an SDK constant (§D5).
    max_utilization: float | None = None
    #: ADR-0022 consent grant IDs the caller is presenting. Credential
    #: presence is not consent (§D9); these are the explicit grants.
    consent_grants: list[str] = field(default_factory=list)
    #: Whether the caller opts into training contribution. Independent of
    #: routing and reported without content (§D9).
    training_share: bool = False
    #: Whether an unavailable required/allowed plane should fail rather than
    #: silently degrade. Pairs with §D5 rule 5 ("local failure does not
    #: authorize cloud egress").
    fail_if_unavailable: bool = True


def assert_routing_receipt_matches_intent(
    intent: RoutingIntent | None,
    receipt: MetaProxyRoutingReceipt,
) -> None:
    """Decode-time verification of §D5 rule 7: a ``required_plane`` mismatch
    is a protocol violation "even if output succeeds".

    Raises a non-retryable ``AgenticError("protocol", ...)`` when
    ``intent.required_plane`` is set and does not equal
    ``receipt.selected_plane`` -- this MUST fire even when the HTTP call was
    a well-formed 200, because the SDK "never infers plane" and treats a
    receipt contradicting caller intent as a protocol error (§D4/§D5).

    A ``None`` intent, or an intent with no ``required_plane``, is a no-op:
    the SDK does not run its own router, so it has nothing to assert beyond
    the caller's explicit ``required_plane`` demand.
    """
    if intent is None or intent.required_plane is None:
        return
    if receipt.selected_plane != intent.required_plane:
        raise AgenticError(
            "protocol",
            "Meta Proxy routing receipt contradicts caller intent: "
            f'required_plane "{intent.required_plane}" but the Proxy reported '
            f'selected_plane "{receipt.selected_plane}" (ADR-0025a §D5 rule 7: a '
            "required_plane mismatch is a protocol violation even if output "
            "succeeds)",
            product=_PRODUCT,
            operation="chat.completions",
            request_id=receipt.request_id or None,
            retryable=False,
        )


__all__ = [
    "RoutingPlane",
    "WorkloadPolicy",
    "RoutingIntent",
    "assert_routing_receipt_matches_intent",
]
