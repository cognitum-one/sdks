"""Python adapter for the cross-language error-mapping corpus.

``sdks/fixtures/error-mapping/`` -- ADR-0030a §D1 Domain layer, issue #75.

Node and Rust run the SAME cases through their own mappers. Each language's
own suite only ever checks that language against itself; this is the one that
catches the three drifting apart.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from cognitum.agentic.retry_after import parse_retry_after_ms
from cognitum.meta_llm.http_errors import map_meta_llm_http_error

_FIXTURE_DIR = Path(__file__).resolve().parents[2] / "fixtures" / "error-mapping"
FIXTURE_PATH = _FIXTURE_DIR / "meta-llm-http-errors-v1.json"
FIXTURE: dict[str, Any] = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
CASES: list[dict[str, Any]] = FIXTURE["cases"]


def _canonical(error: Any) -> dict[str, Any]:
    """The language-neutral shape the corpus compares.

    Absent values become ``None`` rather than being omitted, so a missing
    security-significant field cannot normalize into equality (ADR-0030a §D2).
    """
    upgrade = None
    if error.upgrade is not None:
        retry_with = None
        if error.upgrade.retry_with is not None:
            retry_with = {"fallbackPolicy": error.upgrade.retry_with.fallback_policy}
        upgrade = {
            "requiredTier": error.upgrade.required_tier,
            "heldTier": error.upgrade.held_tier,
            "requiredScope": error.upgrade.required_scope,
            "upgradeUrl": error.upgrade.upgrade_url,
            "retryWith": retry_with,
        }
    return {
        "kind": error.kind,
        "retryable": error.retryable,
        "code": error.code,
        "retryAfterMs": error.retry_after_ms,
        "upgrade": upgrade,
    }


def _expectation_for(case: dict[str, Any]) -> dict[str, Any]:
    # A declared divergence pins THIS language's actual behaviour, so a
    # divergence can neither hide nor drift unnoticed.
    divergence = case.get("knownDivergence") or {}
    return divergence.get("python") or case["expected"]


def _ids(cases: list[dict[str, Any]]) -> list[str]:
    return [c["id"] + (" [known divergence]" if c.get("knownDivergence") else "") for c in cases]


def test_corpus_loaded_and_well_formed() -> None:
    # Guards the adapter itself: a fixture that failed to load, or a corpus
    # silently emptied, must not read as a green run.
    assert len(CASES) > 20
    for case in CASES:
        assert case.get("id"), "every case needs an id"
        assert case.get("expected"), f"{case['id']} needs an expectation"
        assert case.get("why"), f"{case['id']} must say why it exists"


@pytest.mark.parametrize("case", CASES, ids=_ids(CASES))
def test_error_mapping_matches_the_corpus(case: dict[str, Any]) -> None:
    response = httpx.Response(
        status_code=case["response"]["status"],
        text=case["response"]["body"],
        headers=case["response"].get("headers") or {},
    )
    error = map_meta_llm_http_error(response, FIXTURE["operation"], FIXTURE["requestId"])

    expected = _expectation_for(case)
    assert _canonical(error) == {
        "kind": expected["kind"],
        "retryable": expected["retryable"],
        "code": expected["code"],
        "retryAfterMs": expected["retryAfterMs"],
        "upgrade": expected["upgrade"],
    }
    assert expected["messageContains"] in error.message

    forbidden = case.get("mustNotAppearInUpgrade")
    if forbidden:
        assert forbidden not in repr(error.upgrade)


RETRY_AFTER_CASES = [c for c in CASES if (c["response"].get("headers") or {}).get("retry-after")]


@pytest.mark.parametrize("case", RETRY_AFTER_CASES, ids=_ids(RETRY_AFTER_CASES))
def test_retry_after_parsing_at_the_pinned_instant(case: dict[str, Any]) -> None:
    # The HTTP-date cases reach the mapper through the real clock, so the date
    # branch is pinned separately against the corpus instant (ADR-0030a §D5).
    header = case["response"]["headers"]["retry-after"]
    at_instant = case.get("retryAfterMsAtPinnedInstant", case["expected"]["retryAfterMs"])

    assert parse_retry_after_ms(header, FIXTURE["nowMsForHttpDateCases"]) == at_instant


# --- declared divergences stay declared -------------------------------------
# A `knownDivergence` is a deliberate exception. Without these, adding one
# turns a regression green instantly and nobody notices.

INVARIANTS = FIXTURE["divergenceInvariants"]
DIVERGENT = [c for c in CASES if c.get("knownDivergence")]


def test_only_declared_cases_are_divergent() -> None:
    assert sorted(c["id"] for c in DIVERGENT) == sorted(INVARIANTS["expectedDivergentCaseIds"])


def test_each_divergence_names_a_tracking_issue_and_reason() -> None:
    for case in DIVERGENT:
        for key in INVARIANTS["requiredKeys"]:
            assert case["knownDivergence"].get(key), f"{case['id']} needs {key}"


def test_a_divergence_covers_at_most_one_language() -> None:
    # Widening a divergence to a second language would mean the corpus no
    # longer pins agreement anywhere -- that must be a deliberate edit.
    for case in DIVERGENT:
        languages = [lang for lang in INVARIANTS["languages"] if case["knownDivergence"].get(lang)]
        assert 1 <= len(languages) <= INVARIANTS["maxLanguagesPerDivergence"], case["id"]


@pytest.mark.parametrize(
    "edge",
    FIXTURE["retryAfterEdgeCases"],
    ids=[e["header"] or "<empty>" for e in FIXTURE["retryAfterEdgeCases"]],
)
def test_retry_after_grammar(edge: dict[str, Any]) -> None:
    # Every row here disagreed across the three SDKs before the parser was
    # spelled out instead of delegated to each platform's date parser.
    actual = parse_retry_after_ms(edge["header"], FIXTURE["nowMsForHttpDateCases"])
    assert actual == edge["expectedMs"], edge["why"]
