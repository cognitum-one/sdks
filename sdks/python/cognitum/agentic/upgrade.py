"""Parsing for the server's 402 upgrade affordance (ADR-0023 §D1).

The gateway returns 402 for two unrelated situations and distinguishes them
with ``code``::

    {"code": "upgrade_required", "required_tier": "mid", "held_tier": "low",
     "required_scope": "completions:mid", "upgrade_url": "...",
     "retry_with": {"fallback_policy": "best_effort"}}

versus a budget 402, which carries no such affordance. Status alone cannot
tell them apart, and the message text must never be used to try -- it is
prose, it is localisable, and it is redacted before callers see it.

On the Responses and Anthropic Messages surfaces these keys ride at the top
level beside ``error``, so one parser serves every surface.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

#: The ``code`` value marking a 402 as a scope shortfall rather than a spend one.
UPGRADE_REQUIRED_CODE = "upgrade_required"


@dataclass(frozen=True)
class UpgradeRetryHint:
    """Server hint describing a retry that would be in scope.

    Deliberately narrow. An earlier draft preserved every unrecognised
    ``retry_with`` key verbatim for forward compatibility, which put unbounded,
    server-controlled JSON onto an error object that callers routinely log.
    ADR-0028 §D10 forbids capturing credentials, cookies and pre-signed URLs at
    all, and nothing downstream redacts this field. A key no version of this
    SDK understands is also a key no caller can act on, so the trade bought
    nothing and cost a leak path. Add fields here as the server ships them.
    """

    #: e.g. ``"best_effort"``.
    fallback_policy: str | None = None


@dataclass(frozen=True)
class UpgradeAffordance:
    """What the server says would make the rejected call succeed.

    Every field is optional on purpose: this is a server-supplied affordance,
    and a caller that hard-requires any one of them would break the moment the
    gateway omits it. Render what is present; never infer what is not.
    """

    #: Tier that would satisfy the request, e.g. ``"mid"``.
    required_tier: str | None = None
    #: Tier the credential currently holds, e.g. ``"low"``.
    held_tier: str | None = None
    #: Scope that was missing, e.g. ``"completions:mid"``.
    required_scope: str | None = None
    #: Where a human goes to change their plan.
    upgrade_url: str | None = None
    #: Present only when the server can offer an in-scope retry (auto mode
    #: with ``fail_fast``); an explicitly over-scope model alias omits it.
    #: Absence means "there is no way to retry this as asked" -- not an error.
    #:
    #: This SDK never acts on it automatically. ``upgrade_required`` is
    #: non-retryable, and silently downgrading someone's request to a cheaper
    #: tier is a decision only the caller can make.
    retry_with: UpgradeRetryHint | None = None


def _reject_json_constant(name: str) -> Any:
    raise ValueError(f"non-standard JSON constant in error body: {name}")


def _string_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def parse_error_body(body_text: str) -> dict[str, Any] | None:
    """Parse an error body that may or may not be JSON.

    Returns ``None`` rather than raising: a 402 can arrive from a proxy or WAF
    as HTML, and an error mapper that raises while mapping an error replaces a
    useful failure with a confusing one.
    """
    if not body_text:
        return None
    try:
        # ``parse_constant`` rejects NaN/Infinity/-Infinity. Python's decoder
        # accepts those by default; JSON.parse and serde_json both reject
        # them, so leaving it on makes Python classify a body the other two
        # SDKs refuse -- the same 402 would read as `upgrade_required` here
        # and `budget_exceeded` there. They are not valid JSON, and the three
        # SDKs disagreeing about an error's meaning is worse than any of them
        # being strict.
        parsed = json.loads(body_text, parse_constant=_reject_json_constant)
    except (ValueError, TypeError, RecursionError):
        # RecursionError matters: on the Python versions this package supports
        # (>=3.10) a deeply nested body can exhaust the decoder's stack, and
        # that is not a ValueError. Without it this function breaks the
        # promise made two lines above, on hostile input, on an error path.
        return None
    return parsed if isinstance(parsed, dict) else None


def _parse_retry_hint(value: Any) -> UpgradeRetryHint | None:
    # Only the fields this SDK understands are lifted out; unrecognised keys
    # are dropped -- see :class:`UpgradeRetryHint` for why.
    if not isinstance(value, dict):
        return None
    fallback_policy = _string_or_none(value.get("fallback_policy"))
    if fallback_policy is None:
        return None
    return UpgradeRetryHint(fallback_policy=fallback_policy)


def parse_upgrade_affordance(body: dict[str, Any] | None) -> UpgradeAffordance | None:
    """Extract the upgrade affordance from a parsed error body.

    Returns ``None`` when the server sent none of the fields, so a caller can
    treat "no affordance" and "no useful affordance" identically.
    """
    if not body:
        return None
    affordance = UpgradeAffordance(
        required_tier=_string_or_none(body.get("required_tier")),
        held_tier=_string_or_none(body.get("held_tier")),
        required_scope=_string_or_none(body.get("required_scope")),
        upgrade_url=_string_or_none(body.get("upgrade_url")),
        retry_with=_parse_retry_hint(body.get("retry_with")),
    )
    if affordance == UpgradeAffordance():
        return None
    return affordance


def is_upgrade_required(body: dict[str, Any] | None) -> bool:
    """Is this 402 body a scope shortfall (as opposed to a budget one)?"""
    if not body:
        return False
    return body.get("code") == UPGRADE_REQUIRED_CODE


__all__ = [
    "UPGRADE_REQUIRED_CODE",
    "UpgradeAffordance",
    "UpgradeRetryHint",
    "is_upgrade_required",
    "parse_error_body",
    "parse_upgrade_affordance",
]
