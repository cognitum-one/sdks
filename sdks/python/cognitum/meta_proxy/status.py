"""Status, capabilities, and plane-evidence wire types (ADR-0025a §D4).

No service-owned OpenAPI contract exists yet for ``/status`` (§D11 gate #1
is not yet published), so ``MetaProxyStatus`` stays intentionally
permissive (``raw`` passthrough for unrecognized fields), matching the same
convention :mod:`cognitum.meta_llm.discovery` uses for the same reason.

``RoutingPlane`` and ``WorkloadPolicy`` are formally defined in §D5
(data-plane and policy model), which is explicitly OUT of scope for this
pass -- they are declared here only because §D4's ``MetaProxyStatus``
fields reference them. No routing, consent, or plane-selection LOGIC from
§D5 is implemented here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

#: The plane an inference request is (or would be) routed through
#: (ADR-0025a §D5). Reference-only in this pass -- no plane-selection logic
#: is implemented; ``MetaProxyStatus`` fields that carry a plane are typed
#: as plain ``str`` (see its docstring) rather than this literal, consistent
#: with "no contract yet" fields elsewhere.
RoutingPlane = Literal["local", "cognitum_cloud", "anthropic_passthrough", "sponsored_cognitum"]

#: Workload urgency classification (ADR-0025a §D5). Reference-only this pass.
WorkloadPolicy = Literal["critical", "standard", "economy"]

_KNOWN_STATUS_KEYS = {
    "product_version",
    "protocol_version",
    "compatible_sdk_range",
    "process_state",
    "bind",
    "configured_plane",
    "selected_plane",
    "routing_reason",
    "automatic_usage_state",
    "utilization",
    "reset_at",
    "workload_policy",
    "sponsored_available",
    "cloud_credential_source",
    "limitations",
    "request_id",
}


@dataclass(frozen=True)
class MetaProxyStatus:
    """``status()`` response (ADR-0025a §D4).

    ``configured_plane``/``selected_plane``/``workload_policy`` are typed as
    plain ``str`` rather than the ``RoutingPlane``/``WorkloadPolicy``
    literals above -- the Proxy's ``/status`` route has no published
    OpenAPI contract yet (§D11 gate #1), so this stays permissive rather
    than pretending to validate a contract that does not exist, matching
    ``MetaLlmHealth``'s precedent. Values SHOULD be one of the documented
    constants but the SDK does not reject an unrecognized one.
    """

    product_version: str
    process_state: str
    configured_plane: str
    selected_plane: str
    request_id: str
    protocol_version: str | None = None
    #: SDK/protocol compatibility range, format not yet contracted (§D11 gate #2).
    compatible_sdk_range: str | None = None
    #: The loopback ``host:port`` the Proxy is bound to.
    bind: str | None = None
    routing_reason: str | None = None
    automatic_usage_state: str | None = None
    utilization: float | None = None
    reset_at: str | None = None
    workload_policy: str | None = None
    sponsored_available: bool | None = None
    cloud_credential_source: str | None = None
    limitations: list[str] = field(default_factory=list)
    #: Unrecognized fields from the server response, preserved verbatim.
    raw: dict[str, Any] = field(default_factory=dict)

    @staticmethod
    def known_keys() -> frozenset[str]:
        return frozenset(_KNOWN_STATUS_KEYS)


@dataclass(frozen=True)
class MetaProxyRoutingReceipt:
    """Plane-routing evidence attached to an inference response or terminal
    stream event (ADR-0025a §D4).

    Reserved for §D7 (inference/forwarding contract) -- ``status()``/
    ``capabilities()`` in this pass never construct one, since a routing
    receipt describes an inference call's plane selection, which does not
    exist yet. Declared now so §D4's full contract is represented in the
    type system ahead of §D7 landing.
    """

    request_id: str
    configured_plane: str
    selected_plane: str
    automatic: bool
    degraded: bool
    routing_reason: str | None = None
    workload_policy: str | None = None
    consent_evidence_id: str | None = None
    upstream_receipt: Any = None
    local_usage: dict[str, Any] | None = None
    warnings: list[str] | None = None


__all__ = ["RoutingPlane", "WorkloadPolicy", "MetaProxyStatus", "MetaProxyRoutingReceipt"]
