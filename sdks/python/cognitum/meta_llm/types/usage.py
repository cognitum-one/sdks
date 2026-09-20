"""ADR-0024b §D3's ``UsageSummary``/``BudgetView``, plus the bounded query
the read-only ``MetaLlmClient.usage()`` method accepts.

Usage is strictly authenticated-account scoped (§D3) -- every query is
bound to the caller's own credential; there is no cross-tenant or
cross-account parameter anywhere in :class:`UsageQuery`. An empty
``UsageSummary`` is not reinterpreted as "no usage anywhere" vs. "this
account genuinely has none" (§D3) -- ``usage()`` returns whatever the
server reports as-is, with no speculative fallback logic layered on top.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

from cognitum.meta_llm.types.money import Money, parse_money

_YYYY_MM = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


@dataclass(frozen=True)
class CacheStats:
    hit_rate: float | None = None
    savings: Money | None = None
    raw: dict[str, Any] | None = None


@dataclass(frozen=True)
class UsageTotals:
    requests: int | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None
    cost: Money | None = None
    raw: dict[str, Any] | None = None


@dataclass(frozen=True)
class BudgetView:
    """Plan degradation and reset information are preserved as reported
    (§D4) -- this SDK never recomputes ``status``/``headroom`` from the
    other fields.
    """

    serving: Money | None = None
    hard_limit: Money | None = None
    committed: Money | None = None
    reserved: Money | None = None
    headroom: Money | None = None
    status: str | None = None
    resets_at: str | None = None
    raw: dict[str, Any] | None = None


@dataclass(frozen=True)
class UsageBreakdownEntry:
    requests: int | None = None
    cost: Money | None = None
    raw: dict[str, Any] | None = None


@dataclass(frozen=True)
class UsagePeriodEntry(UsageBreakdownEntry):
    period: str = ""


@dataclass(frozen=True)
class UsageSummary:
    """ADR-0024b §D3's ``UsageSummary``."""

    totals: UsageTotals
    tier_mix: dict[str, float] | None = None
    escalation_rate: float | None = None
    cache: CacheStats | None = None
    fallback_rate: float | None = None
    empty_billed_rate: float | None = None
    by_model: dict[str, UsageBreakdownEntry] | None = None
    by_provider: dict[str, UsageBreakdownEntry] | None = None
    by_period: list[UsagePeriodEntry] | None = None
    budget: BudgetView | None = None
    #: Fields present on the wire this decoder does not recognize,
    #: preserved verbatim (never dropped).
    raw: dict[str, Any] | None = None


@dataclass
class UsageQuery:
    """Bounded ``YYYY-MM`` query window plus optional grouping (ADR-0024b §D3)."""

    #: Inclusive ``YYYY-MM`` start of the query range.
    from_: str
    #: Inclusive ``YYYY-MM`` end of the query range.
    to: str
    model: str | None = None
    provider: str | None = None
    group_by: Literal["model", "provider", "period"] | None = None


class InvalidUsageQueryError(ValueError):
    pass


def assert_valid_usage_query(query: UsageQuery) -> None:
    """Validates the bounded ``YYYY-MM`` range required by §D3 before any request is sent."""
    if not _YYYY_MM.match(query.from_):
        raise InvalidUsageQueryError(f"UsageQuery.from_ must match YYYY-MM; got {query.from_!r}")
    if not _YYYY_MM.match(query.to):
        raise InvalidUsageQueryError(f"UsageQuery.to must match YYYY-MM; got {query.to!r}")
    if query.from_ > query.to:
        raise InvalidUsageQueryError(
            f"UsageQuery.from_ ({query.from_!r}) must not be after .to ({query.to!r})"
        )


def _snake_to_camel(key: str) -> str:
    head, *rest = key.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


def _field(raw: dict[str, Any], key: str, *aliases: str) -> Any:
    """Read a response field under snake_case or camelCase.

    ``/v1/usage`` answers in camelCase (``totalTokens``, ``costUsd``,
    ``escalationRate``), while this parser was written against snake_case, so
    every numeric field decoded to ``None`` -- silently, because
    ``parse_usage_summary`` never raises and an empty total is a legitimate
    answer. Only ``requests`` survived, being spelled the same either way.
    Node has always read both (``raw.prompt_tokens ?? raw.promptTokens``); this
    brings Python to the same tolerance rather than betting on one spelling.
    """
    for candidate in (key, _snake_to_camel(key), *aliases):
        if candidate in raw:
            return raw[candidate]
    return None


def _known(*keys: str) -> set[str]:
    """Every accepted spelling of the keys a parser consumes, for `raw` remainder."""
    out: set[str] = set()
    for key in keys:
        out.add(key)
        out.add(_snake_to_camel(key))
    return out


def _num_or_none(value: Any) -> float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _parse_cache_stats(raw: Any) -> CacheStats | None:
    if not isinstance(raw, dict):
        return None
    known = _known("hit_rate", "savings")
    return CacheStats(
        hit_rate=_num_or_none(_field(raw, "hit_rate")),
        savings=parse_money(_field(raw, "savings")),
        raw={k: v for k, v in raw.items() if k not in known} or None,
    )


def _parse_usage_totals(raw: Any) -> UsageTotals:
    if not isinstance(raw, dict):
        return UsageTotals()
    known = _known("requests", "prompt_tokens", "completion_tokens", "total_tokens", "cost")

    def _int(key: str) -> int | None:
        value = _field(raw, key)
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    return UsageTotals(
        requests=_int("requests"),
        prompt_tokens=_int("prompt_tokens"),
        completion_tokens=_int("completion_tokens"),
        total_tokens=_int("total_tokens"),
        cost=parse_money(_field(raw, "cost")),
        raw={k: v for k, v in raw.items() if k not in known} or None,
    )


def _parse_budget_view(raw: Any) -> BudgetView | None:
    if not isinstance(raw, dict):
        return None
    known = _known(
        "serving", "hard_limit", "committed", "reserved", "headroom", "status", "resets_at"
    )
    status = _field(raw, "status")
    resets_at = _field(raw, "resets_at")
    return BudgetView(
        serving=parse_money(_field(raw, "serving")),
        hard_limit=parse_money(_field(raw, "hard_limit")),
        committed=parse_money(_field(raw, "committed")),
        reserved=parse_money(_field(raw, "reserved")),
        headroom=parse_money(_field(raw, "headroom")),
        status=status if isinstance(status, str) else None,
        resets_at=resets_at if isinstance(resets_at, str) else None,
        raw={k: v for k, v in raw.items() if k not in known} or None,
    )


def _parse_breakdown_entry(raw: Any) -> UsageBreakdownEntry:
    if not isinstance(raw, dict):
        return UsageBreakdownEntry()
    known = {"requests", "cost"}
    requests = raw.get("requests")
    return UsageBreakdownEntry(
        requests=requests if isinstance(requests, int) and not isinstance(requests, bool) else None,
        cost=parse_money(raw.get("cost")),
        raw={k: v for k, v in raw.items() if k not in known} or None,
    )


def _parse_breakdown_map(raw: Any) -> dict[str, UsageBreakdownEntry] | None:
    if not isinstance(raw, dict):
        return None
    return {key: _parse_breakdown_entry(value) for key, value in raw.items()}


def _parse_period_entries(raw: Any) -> list[UsagePeriodEntry] | None:
    if not isinstance(raw, list):
        return None
    out: list[UsagePeriodEntry] = []
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("period"), str):
            continue
        entry = _parse_breakdown_entry(item)
        out.append(
            UsagePeriodEntry(
                period=item["period"], requests=entry.requests, cost=entry.cost, raw=entry.raw
            )
        )
    return out


_KNOWN_USAGE_KEYS = _known(
    "totals",
    "tier_mix",
    "escalation_rate",
    "cache",
    "fallback_rate",
    "empty_billed_rate",
    "by_model",
    "by_provider",
    "by_period",
    "budget",
)


def parse_usage_summary(raw: Any) -> UsageSummary:
    """Parse a raw ``/v1/usage`` JSON body into a typed :class:`UsageSummary`.

    Never raises -- an entirely empty/malformed body decodes to a
    ``UsageSummary`` with empty ``totals`` rather than an error, since an
    empty result is itself meaningful account-scoped evidence (§D3), not a
    parse failure.
    """
    if not isinstance(raw, dict):
        return UsageSummary(totals=UsageTotals())

    tier_mix = _field(raw, "tier_mix")
    raw_remainder = {k: v for k, v in raw.items() if k not in _KNOWN_USAGE_KEYS}

    return UsageSummary(
        totals=_parse_usage_totals(_field(raw, "totals")),
        tier_mix=tier_mix if isinstance(tier_mix, dict) else None,
        escalation_rate=_num_or_none(_field(raw, "escalation_rate")),
        cache=_parse_cache_stats(_field(raw, "cache")),
        fallback_rate=_num_or_none(_field(raw, "fallback_rate")),
        empty_billed_rate=_num_or_none(_field(raw, "empty_billed_rate")),
        by_model=_parse_breakdown_map(_field(raw, "by_model")),
        by_provider=_parse_breakdown_map(_field(raw, "by_provider")),
        by_period=_parse_period_entries(_field(raw, "by_period")),
        budget=_parse_budget_view(raw.get("budget")),
        raw=raw_remainder or None,
    )


__all__ = [
    "CacheStats",
    "UsageTotals",
    "BudgetView",
    "UsageBreakdownEntry",
    "UsagePeriodEntry",
    "UsageSummary",
    "UsageQuery",
    "InvalidUsageQueryError",
    "assert_valid_usage_query",
    "parse_usage_summary",
]
