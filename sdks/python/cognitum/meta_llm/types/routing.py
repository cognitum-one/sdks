"""ADR-0024b §D2: routing types and precedence. Issue #59, D11 migration
step 1 ("Release routing receipt and usage read-only support after
ADR-0024a serving").

``ModelSelector`` deliberately has NO escape hatch for a raw provider model
ID -- ``auto``, a ``ModelTier``, or a contract-declared alias string are the
only three shapes the audited resolver accepts; anything else is rejected
server-side as ``model_not_found`` (§D2). This is a deliberate rejection,
not an oversight, so no fourth "raw model id" variant is added here.

Unknown values RECEIVED from the server (e.g. a ``resolved_tier`` that
predates this SDK's enum) must be preserved rather than dropped -- see
``cognitum.meta_llm.types.receipt``, which types those fields as plain
``str`` so an unrecognized wire value still round-trips instead of being
rejected.

Values the SDK *sends*, by contrast, are validated against the closed set
at request time via :func:`assert_sendable_routing_controls` -- §D2:
"stable methods cannot send them until capabilities declare support."

Body controls win over ``X-Cognitum-*`` headers (§D2) -- this SDK never
exposes a generic header-override surface for routing, safety, auth,
request ID, idempotency, trace, host, or content-length fields (see
``nonstream.py``/``client.py``: headers are built internally from typed
fields only), so there is no header path these controls could lose to.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

ModelTier = Literal["low", "mid", "high"]

FallbackPolicy = Literal["fail_fast", "best_effort"]

EscalationStrategy = Literal["stream_oneshot", "post_hoc", "buffered", "inflight"]

CacheMode = Literal["disabled", "exact", "semantic"]

SafetyMode = Literal["block", "warn", "redact"]

#: Opaque, sanitized attribution metadata (ADR-0024b §D2). Included in
#: operation/idempotency metadata where contracted, but never treated as
#: tenant, budget, rate-limit, or resource-owner authority.
SubTenantAttribution = str

_MODEL_TIERS = {"low", "mid", "high"}
_FALLBACK_POLICIES = {"fail_fast", "best_effort"}
_ESCALATION_STRATEGIES = {"stream_oneshot", "post_hoc", "buffered", "inflight"}
_CACHE_MODES = {"disabled", "exact", "semantic"}
_SAFETY_MODES = {"block", "warn", "redact"}


@dataclass(frozen=True)
class ModelSelectorAuto:
    kind: Literal["auto"] = "auto"


@dataclass(frozen=True)
class ModelSelectorTier:
    tier: ModelTier
    kind: Literal["tier"] = "tier"


@dataclass(frozen=True)
class ModelSelectorAlias:
    alias: str
    kind: Literal["contract_declared_alias"] = "contract_declared_alias"


ModelSelector = ModelSelectorAuto | ModelSelectorTier | ModelSelectorAlias


@dataclass
class MetaLlmRoutingControls:
    """ADR-0024b §D2's ``MetaLlmRoutingControls``."""

    model: ModelSelector | None = None
    min_tier: ModelTier | None = None
    max_tier: ModelTier | None = None
    fallback_policy: FallbackPolicy | None = None
    escalation: EscalationStrategy | None = None
    cache: CacheMode | None = None
    safety: SafetyMode | None = None
    sub_tenant_id: SubTenantAttribution | None = None


class UnsendableRoutingControlsError(ValueError):
    """Raised by :func:`assert_sendable_routing_controls`; never raised by response parsing."""


def _assert_sendable_model_selector(selector: ModelSelector) -> None:
    if isinstance(selector, ModelSelectorAuto):
        return
    if isinstance(selector, ModelSelectorTier):
        if selector.tier not in _MODEL_TIERS:
            raise UnsendableRoutingControlsError(
                f"unrecognized ModelTier in ModelSelector.tier: {selector.tier!r}"
            )
        return
    if isinstance(selector, ModelSelectorAlias):
        if not selector.alias:
            raise UnsendableRoutingControlsError(
                "ModelSelector.contract_declared_alias requires a non-empty alias string"
            )
        return
    # Exhaustiveness: any other shape -- including a hypothetical raw
    # provider-model-id escape hatch -- is rejected. §D2 is explicit that no
    # such escape hatch exists; the SDK fails locally rather than forcing a
    # round trip the resolver would reject as `model_not_found`.
    raise UnsendableRoutingControlsError(f"unrecognized ModelSelector: {selector!r}")


def assert_sendable_routing_controls(controls: MetaLlmRoutingControls | None) -> None:
    """Validates a caller-supplied ``MetaLlmRoutingControls`` immediately
    before it is serialized onto the wire. Raises rather than silently
    sending an unrecognized enum member or a raw provider model ID. Never
    called on data received from the server -- received unknown values are
    preserved, not rejected (see ``cognitum.meta_llm.types.receipt``).
    """
    if controls is None:
        return
    if controls.model is not None:
        _assert_sendable_model_selector(controls.model)
    if controls.min_tier is not None and controls.min_tier not in _MODEL_TIERS:
        raise UnsendableRoutingControlsError(
            f"unrecognized ModelTier for min_tier: {controls.min_tier!r}"
        )
    if controls.max_tier is not None and controls.max_tier not in _MODEL_TIERS:
        raise UnsendableRoutingControlsError(
            f"unrecognized ModelTier for max_tier: {controls.max_tier!r}"
        )
    if controls.fallback_policy is not None and controls.fallback_policy not in _FALLBACK_POLICIES:
        raise UnsendableRoutingControlsError(
            f"unrecognized FallbackPolicy: {controls.fallback_policy!r}"
        )
    if controls.escalation is not None and controls.escalation not in _ESCALATION_STRATEGIES:
        raise UnsendableRoutingControlsError(
            f"unrecognized EscalationStrategy: {controls.escalation!r}"
        )
    if controls.cache is not None and controls.cache not in _CACHE_MODES:
        raise UnsendableRoutingControlsError(f"unrecognized CacheMode: {controls.cache!r}")
    if controls.safety is not None and controls.safety not in _SAFETY_MODES:
        raise UnsendableRoutingControlsError(f"unrecognized SafetyMode: {controls.safety!r}")


__all__ = [
    "ModelTier",
    "ModelSelectorAuto",
    "ModelSelectorTier",
    "ModelSelectorAlias",
    "ModelSelector",
    "FallbackPolicy",
    "EscalationStrategy",
    "CacheMode",
    "SafetyMode",
    "SubTenantAttribution",
    "MetaLlmRoutingControls",
    "UnsendableRoutingControlsError",
    "assert_sendable_routing_controls",
]
