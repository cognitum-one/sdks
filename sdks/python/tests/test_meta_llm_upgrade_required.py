"""402 upgrade_required vs budget_exceeded (issue #128, ADR-0023 §D1).

A 402 is either "you spent your budget" or "you never bought this tier", and
the two send a user to different places. These mirror the Node and Rust suites
case for case -- the three SDKs must agree on the wire.
"""

from __future__ import annotations

import json

import httpx
import pytest

from cognitum.meta_llm.http_errors import map_meta_llm_http_error

# Not invented: the verbatim body returned by https://api.cognitum.one on
# 2026-07-31 when a key holding `completions:low` requested `cognitum-high`.
LIVE_TIER_SHORTFALL_BODY = json.dumps(
    {
        "error": (
            "Model 'cognitum-high' requires the completions:high scope, "
            "which this API key does not hold."
        ),
        "code": "upgrade_required",
        "requestId": "f892a402-f488-46b1-93d9-86ccdfcaf53b",
        "required_tier": "high",
        "held_tier": "low",
        "required_scope": "completions:high",
        "upgrade_url": "https://dashboard.cognitum.one/settings/billing",
    }
)


def _response(status: int, body: str, headers: dict[str, str] | None = None) -> httpx.Response:
    return httpx.Response(status_code=status, text=body, headers=headers or {})


def _map(status: int, body: str, headers: dict[str, str] | None = None):
    return map_meta_llm_http_error(_response(status, body, headers), "chatCompletions", "req-1")


def test_live_tier_shortfall_maps_to_upgrade_required() -> None:
    error = _map(402, LIVE_TIER_SHORTFALL_BODY)

    assert error.kind == "upgrade_required"
    assert error.status == 402
    assert error.code == "upgrade_required"


def test_affordance_is_exposed_not_dropped() -> None:
    error = _map(402, LIVE_TIER_SHORTFALL_BODY)

    assert error.upgrade is not None
    assert error.upgrade.required_tier == "high"
    assert error.upgrade.held_tier == "low"
    assert error.upgrade.required_scope == "completions:high"
    assert error.upgrade.upgrade_url == "https://dashboard.cognitum.one/settings/billing"
    assert error.upgrade.retry_with is None


def test_upgrade_required_stays_non_retryable() -> None:
    assert _map(402, LIVE_TIER_SHORTFALL_BODY).retryable is False


def test_retry_with_is_surfaced_but_not_acted_on() -> None:
    body = json.dumps(
        {
            "code": "upgrade_required",
            "required_tier": "mid",
            "retry_with": {"fallback_policy": "best_effort"},
        }
    )
    error = _map(402, body)

    assert error.upgrade is not None
    assert error.upgrade.retry_with is not None
    assert error.upgrade.retry_with.fallback_policy == "best_effort"
    # Offering a retry is not performing one.
    assert error.retryable is False


def test_unrecognised_retry_with_keys_are_dropped() -> None:
    # ADR-0028 §D10: credentials, cookies and pre-signed URLs are never
    # capturable, and nothing redacts this field. A key no SDK version
    # understands is a key no caller can act on.
    body = json.dumps(
        {
            "code": "upgrade_required",
            "retry_with": {"fallback_policy": "best_effort", "authorization": "Bearer SECRET"},
        }
    )
    error = _map(402, body)

    assert error.upgrade is not None
    assert error.upgrade.retry_with is not None
    assert error.upgrade.retry_with.fallback_policy == "best_effort"
    assert "SECRET" not in repr(error.upgrade)


def test_retry_with_is_omitted_when_nothing_is_understood() -> None:
    error = _map(402, json.dumps({"code": "upgrade_required", "retry_with": {"future_key": None}}))

    # "No affordance" and "no usable affordance" must look identical.
    assert error.upgrade is None


def test_budget_402_is_unchanged() -> None:
    # The regression that matters in the other direction: spend exhaustion
    # must not be reclassified.
    error = _map(402, json.dumps({"error": "budget exhausted", "code": "budget_exceeded"}))

    assert error.kind == "budget_exceeded"
    assert error.code == "budget_exceeded"
    assert error.upgrade is None


def test_unrecognised_402_code_stays_budget_exceeded() -> None:
    # Forward compatibility: a code this version has never heard of must not
    # become `upgrade_required` by accident.
    assert _map(402, json.dumps({"code": "some_future_402_reason"})).kind == "budget_exceeded"


def test_non_json_402_body_does_not_raise() -> None:
    # A WAF or proxy can answer 402 with HTML. A mapper that raises while
    # mapping an error replaces a useful failure with a confusing one.
    error = _map(402, "<html>Payment Required</html>")

    assert error.kind == "budget_exceeded"
    assert error.upgrade is None
    assert "Payment Required" in error.message


def test_empty_402_body_does_not_raise() -> None:
    error = _map(402, "")

    assert error.kind == "budget_exceeded"
    assert error.message == "budget or upgrade required"


def test_code_without_fields_yields_no_affordance() -> None:
    error = _map(402, json.dumps({"code": "upgrade_required"}))

    assert error.kind == "upgrade_required"
    # Absent, not a dataclass of Nones -- a caller checks `if error.upgrade:`.
    assert error.upgrade is None


def test_non_string_affordance_fields_are_ignored() -> None:
    body = json.dumps({"code": "upgrade_required", "required_tier": 42, "held_tier": "low"})
    error = _map(402, body)

    assert error.upgrade is not None
    assert error.upgrade.required_tier is None
    assert error.upgrade.held_tier == "low"


@pytest.mark.parametrize(
    ("status", "kind"),
    [
        (400, "validation"),
        (401, "authentication"),
        (403, "permission_denied"),
        (422, "safety_blocked"),
    ],
)
def test_other_statuses_are_undisturbed(status: int, kind: str) -> None:
    assert _map(status, json.dumps({"code": "upgrade_required"})).kind == kind


def test_non_standard_json_constants_are_rejected_like_the_other_sdks() -> None:
    # Python's decoder accepts NaN/Infinity by default; JSON.parse and
    # serde_json reject them. Verified 2026-07-31. Without this, the same 402
    # would classify as `upgrade_required` in Python and `budget_exceeded` in
    # Node and Rust -- three SDKs disagreeing about what an error means.
    for constant in ("NaN", "Infinity", "-Infinity"):
        body = '{"code":"upgrade_required","required_tier":"high","x":' + constant + "}"
        assert _map(402, body).kind == "budget_exceeded", constant
