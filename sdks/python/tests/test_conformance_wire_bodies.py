"""Python adapter for the cross-language request-body corpus.

``sdks/fixtures/wire/`` -- ADR-0030a §D1 Wire layer, issue #75.

Builds each case through the SDK's real request dataclasses and the real
serialisation path (``cognitum.agentic.wire.request_body``), then asserts the
body equals the canonical one Node and Rust also produce.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from cognitum.agentic.wire import request_body
from cognitum.meta_llm import (
    AnthropicMessageRequest,
    ChatCompletionRequest,
    EmbeddingRequest,
)

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2] / "fixtures" / "wire" / "meta-llm-request-bodies-v1.json")
    .read_text(encoding="utf-8")
)
CASES: list[dict[str, Any]] = FIXTURE["cases"]

# Which request dataclass each operation builds. Constructed from the case's
# `input` exactly as a caller would, so the test exercises the real path.
BUILDERS = {
    "chat.completions": ChatCompletionRequest,
    "embeddings": EmbeddingRequest,
    "messages.create": AnthropicMessageRequest,
}


def _ids(cases: list[dict[str, Any]]) -> list[str]:
    return [c["id"] for c in cases]


def _normalise(value: Any) -> Any:
    """Numbers compare by value: JSON has one number type, so 0 == 0.0.

    See ``numberComparisonNote`` in the corpus for why this is normalised
    rather than pinned.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, list):
        return [_normalise(v) for v in value]
    if isinstance(value, dict):
        return {k: _normalise(v) for k, v in value.items()}
    return value


def _null_paths(value: Any, at: str = "$") -> list[str]:
    if value is None:
        return [at]
    if isinstance(value, list):
        return [p for i, v in enumerate(value) for p in _null_paths(v, f"{at}[{i}]")]
    if isinstance(value, dict):
        return [p for k, v in value.items() for p in _null_paths(v, f"{at}.{k}")]
    return []


def test_corpus_loaded_and_complete() -> None:
    assert len(CASES) >= 5
    for case in CASES:
        assert case.get("id") and case.get("why") and case.get("expectedBody")


@pytest.mark.parametrize("case", CASES, ids=_ids(CASES))
def test_request_serialises_to_the_canonical_body(case: dict[str, Any]) -> None:
    builder = BUILDERS[case["operation"]]
    body = request_body(builder(**case["input"]))

    assert _normalise(body) == _normalise(case["expectedBody"])


@pytest.mark.parametrize("case", CASES, ids=_ids(CASES))
def test_no_null_is_sent_for_an_unset_optional(case: dict[str, Any]) -> None:
    # The specific defect: `dataclasses.asdict` kept every unset field as
    # None, and the gateway rejects that form -- `{"n": null}` returned
    # HTTP 400 "Only n=1 is supported in v1." from production.
    body = request_body(BUILDERS[case["operation"]](**case["input"]))
    nulls = _null_paths(body)

    assert nulls == [], f"explicit nulls at {nulls}"
