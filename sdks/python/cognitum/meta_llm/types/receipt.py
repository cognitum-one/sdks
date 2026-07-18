"""ADR-0024b §D3's ``MetaLlmReceipt``. Replaces the ``Any`` placeholder
that shipped with ADR-0024a's envelope (``cognitum.meta_llm.envelope``) --
this is the concrete shape issue #59 reserved that placeholder for.

Every field here is server-authoritative evidence, not something this SDK
computes or backfills -- a missing cost/price/savings field stays missing
rather than being reconstructed from token counts (§D3: "Missing cost is
not reconstructed from tokens"). Parsing never raises: an unrecognized
shape yields ``None`` (for the whole receipt) or a preserved-but-untyped
``raw`` entry (for individual unknown fields), never a raised error --
response parsing must not reject evidence just because this SDK's enum set
has not caught up yet (§D2).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from cognitum.agentic.receipts import CostObservation
from cognitum.meta_llm.types.money import Money, parse_money


#: Only contract-safe detector classes and counts are exposed here (§D4:
#: "Warn and redact expose only contract-safe detector classes and counts.
#: Prompts, matches, secrets, and unredacted content are excluded").
@dataclass(frozen=True)
class SafetySummary:
    mode: str | None = None
    detector_classes: list[str] | None = None
    blocked: bool | None = None
    #: Unrecognized fields from the server response, preserved verbatim.
    raw: dict[str, Any] | None = None


@dataclass(frozen=True)
class MetaLlmReceipt:
    """ADR-0024b §D3's ``MetaLlmReceipt``.

    ``resolved_tier``/``cache_result`` are typed as plain ``str`` (not a
    closed ``Literal``) so a value that widens beyond this SDK's known set
    still round-trips instead of being coerced away or rejected (§D2:
    "Unknown received values are preserved").
    """

    request_id: str
    resolved_tier: str | None = None
    resolved_model: str | None = None
    escalated: bool | None = None
    cap_degraded: bool | None = None
    routing_reason: str | None = None
    price: Money | None = None
    cache_result: str | None = None
    cache_savings: Money | None = None
    prompt_cache_savings: Money | None = None
    fallback_used: bool | None = None
    breaker_counts: dict[str, int] | None = None
    sub_tenant_id: str | None = None
    safety_summary: SafetySummary | None = None
    usage: dict[str, Any] | None = None
    costs: list[CostObservation] = field(default_factory=list)
    #: Fields present on the wire this decoder does not recognize,
    #: preserved verbatim (never dropped).
    raw: dict[str, Any] | None = None


_KNOWN_RECEIPT_KEYS = {
    "request_id",
    "resolved_tier",
    "resolved_model",
    "escalated",
    "cap_degraded",
    "routing_reason",
    "price",
    "cache_result",
    "cache_savings",
    "prompt_cache_savings",
    "fallback_used",
    "breaker_counts",
    "sub_tenant_id",
    "safety_summary",
    "usage",
    "costs",
}


def _str_or_none(raw: dict[str, Any], key: str) -> str | None:
    value = raw.get(key)
    return value if isinstance(value, str) else None


def _bool_or_none(raw: dict[str, Any], key: str) -> bool | None:
    value = raw.get(key)
    return value if isinstance(value, bool) else None


def _dict_or_none(raw: dict[str, Any], key: str) -> dict[str, Any] | None:
    value = raw.get(key)
    return value if isinstance(value, dict) else None


def _parse_cost_observation(raw: Any) -> CostObservation | None:
    if not isinstance(raw, dict):
        return None
    source, amount, currency, finality = (
        raw.get("source"),
        raw.get("amount"),
        raw.get("currency"),
        raw.get("finality"),
    )
    if not isinstance(source, str) or not isinstance(currency, str):
        return None
    if not isinstance(finality, str):
        return None
    if not isinstance(amount, (str, int, float)) or isinstance(amount, bool):
        return None
    # NOTE: `CostObservation.amount` is still a plain `float` from the
    # earlier ADR-0028 stub, not a `Money` -- an existing gap out of scope
    # to fix here (see `types/money.py`'s module docstring).
    try:
        amount_value = float(amount)
    except ValueError:
        return None
    return CostObservation(
        source=source, amount=amount_value, currency=currency, finality=finality  # type: ignore[arg-type]
    )


def _parse_safety_summary(raw: Any) -> SafetySummary | None:
    if not isinstance(raw, dict):
        return None
    known = {"mode", "detector_classes", "blocked"}
    detector_classes = raw.get("detector_classes")
    return SafetySummary(
        mode=raw.get("mode") if isinstance(raw.get("mode"), str) else None,
        detector_classes=(
            [d for d in detector_classes if isinstance(d, str)]
            if isinstance(detector_classes, list)
            else None
        ),
        blocked=raw.get("blocked") if isinstance(raw.get("blocked"), bool) else None,
        raw={k: v for k, v in raw.items() if k not in known} or None,
    )


def parse_meta_llm_receipt(raw: Any) -> MetaLlmReceipt | None:
    """Parse a raw wire ``cognitum_receipt`` payload into a typed
    :class:`MetaLlmReceipt`. Returns ``None`` for a missing/malformed
    receipt rather than a shaped empty object (ADR-0024a §D4: "Missing
    metadata remains missing").
    """
    if not isinstance(raw, dict):
        return None

    # A receipt missing `request_id` is anomalous but still preserved
    # rather than discarded wholesale -- every other field (including
    # `raw`) is still extracted below, just with `request_id` defaulted to
    # `""` instead of dropping the whole receipt (and, with it, cost/
    # routing evidence the server did send).
    request_id = raw.get("request_id")
    request_id = request_id if isinstance(request_id, str) else ""

    costs_raw = raw.get("costs")
    costs = (
        [c for c in (_parse_cost_observation(item) for item in costs_raw) if c is not None]
        if isinstance(costs_raw, list)
        else []
    )

    raw_remainder = {k: v for k, v in raw.items() if k not in _KNOWN_RECEIPT_KEYS}

    return MetaLlmReceipt(
        request_id=request_id,
        resolved_tier=_str_or_none(raw, "resolved_tier"),
        resolved_model=_str_or_none(raw, "resolved_model"),
        escalated=_bool_or_none(raw, "escalated"),
        cap_degraded=_bool_or_none(raw, "cap_degraded"),
        routing_reason=_str_or_none(raw, "routing_reason"),
        price=parse_money(raw.get("price")),
        cache_result=_str_or_none(raw, "cache_result"),
        cache_savings=parse_money(raw.get("cache_savings")),
        prompt_cache_savings=parse_money(raw.get("prompt_cache_savings")),
        fallback_used=_bool_or_none(raw, "fallback_used"),
        breaker_counts=_dict_or_none(raw, "breaker_counts"),
        sub_tenant_id=_str_or_none(raw, "sub_tenant_id"),
        safety_summary=_parse_safety_summary(raw.get("safety_summary")),
        usage=_dict_or_none(raw, "usage"),
        costs=costs,
        raw=raw_remainder or None,
    )


__all__ = ["SafetySummary", "MetaLlmReceipt", "parse_meta_llm_receipt"]
