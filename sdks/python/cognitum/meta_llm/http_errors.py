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
from cognitum.agentic.retry_after import parse_retry_after_ms
from cognitum.agentic.upgrade import (
    is_upgrade_required,
    parse_error_body,
    parse_upgrade_affordance,
)

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
        # Two unrelated failures share this status: the caller is out of
        # budget, or the caller never bought the tier they asked for. The
        # remedies point in different directions -- usage vs plan -- so
        # collapsing both into ``budget_exceeded`` sends half of them to the
        # wrong page. The server's ``code`` is what separates them.
        body = parse_error_body(body_text)
        code = body.get("code") if isinstance(body, dict) else None
        code = code if isinstance(code, str) else None
        if is_upgrade_required(body):
            return AgenticError(
                "upgrade_required",
                body_text or "upgrade required",
                code=code,
                upgrade=parse_upgrade_affordance(body),
                # Still never retried: only a plan change makes this succeed,
                # and the ``retry_with`` hint is for the caller to decide on.
                retryable=False,
                **common,
            )
        return AgenticError(
            "budget_exceeded",
            body_text or "budget or upgrade required",
            code=code,
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
        # RFC 9110 allows an HTTP-date here, not just delta-seconds. The old
        # `float(header)` raised ValueError on one -- crashing *while mapping
        # an error*, which is the worst possible moment to raise.
        retry_after_ms = parse_retry_after_ms(response.headers.get("retry-after"))
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
