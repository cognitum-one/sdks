"""HTTP-status -> ``AgenticErrorKind`` mapping (ADR-0024a §D6's full table).

Shared by every operation's error path -- GET (``health``/``whoami``/
``models``, in ``client.py``) and the idempotent-with-key POSTs
(``nonstream.py``) alike, since none of these statuses are
protocol-specific.
"""

from __future__ import annotations

from typing import Any

import httpx

from cognitum.agentic import AgenticError

_PRODUCT = "meta-llm"


def map_meta_llm_http_error(
    response: httpx.Response, operation: str, request_id: str
) -> AgenticError:
    status = response.status_code
    body_text = response.text
    common: dict[str, Any] = {
        "product": _PRODUCT,
        "operation": operation,
        "status": status,
        "request_id": request_id,
    }

    # Never retried (ADR-0024a §D6).
    if status == 400:
        return AgenticError(
            "validation", body_text or "invalid request", retryable=False, **common
        )
    if status == 401:
        return AgenticError(
            "authentication", body_text or "authentication failed", retryable=False, **common
        )
    if status == 403:
        return AgenticError(
            "permission_denied", body_text or "permission denied", retryable=False, **common
        )
    if status == 404:
        return AgenticError("not_found", body_text or "not found", retryable=False, **common)
    if status == 409:
        return AgenticError(
            "conflict",
            body_text or "state conflict or idempotency mismatch",
            retryable=False,
            **common,
        )
    if status == 402:
        return AgenticError(
            "budget_exceeded",
            body_text or "budget or upgrade required",
            retryable=False,
            **common,
        )
    if status == 422:
        return AgenticError(
            "safety_blocked",
            body_text or "safety or semantic validation failed",
            retryable=False,
            **common,
        )
    # Bounded retry only when the caller proves replay safety (an
    # idempotent-with-key operation) -- the retry loop in ``nonstream.py``
    # is what actually gates this; ``retryable=True`` here only reflects
    # the status's own classification.
    if status == 429:
        retry_after_header = response.headers.get("retry-after")
        retry_after_ms = int(float(retry_after_header) * 1000) if retry_after_header else None
        return AgenticError(
            "rate_limited",
            body_text or "rate limited",
            retryable=True,
            retry_after_ms=retry_after_ms,
            **common,
        )
    if status in (502, 503):
        return AgenticError(
            "transport", body_text or f"upstream error {status}", retryable=True, **common
        )
    return AgenticError(
        "protocol", body_text or f"unexpected status {status}", retryable=False, **common
    )


__all__ = ["map_meta_llm_http_error"]
