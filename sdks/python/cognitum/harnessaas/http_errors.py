"""HTTP-status -> ``AgenticErrorKind`` mapping for HarnessaaS.

Verified against the REAL error paths in ``cognitum-one/harnessaas@908e4a99``:

- 401 ``missing_api_key``/``invalid_api_key`` (``src/auth.ts:280-303``) --
  opaque on purpose (anti-enumeration).
- 403 ``insufficient_scope`` (``src/auth.ts`` ``authorizeGenome``) and
  ``scope_required`` (``src/server.ts`` security-remediation gate), plus
  ``EgressDeniedError`` (ADR-0040) -- fail closed rather than degrade to
  open egress.
- 400 -- invalid JSON body, missing required fields, a non-git ``repo``
  path (``repo_not_permitted``, issue #56), or a vertical-specific missing
  field.
- 404 -- unmatched route, or (for ``lineage``) a ``request_id`` not owned
  by the caller's tenant (cross-tenant reads collapse to the same 404).
- 422 ``safety_blocked`` -- the inbound PII/safety pre-flight refused the
  request BEFORE any spend (``PiiBlockedError``).
- 500 -- an uncaught exception; no in-app rate limiter or explicit
  429/502/503 emission was found in ``harnessaas``'s own route code, so
  those (if seen at all) originate from infrastructure in front of the
  app, not the service itself. Mapped here defensively for forward
  compatibility only.
"""

from __future__ import annotations

from typing import Any

import httpx

from cognitum.agentic import AgenticError

_PRODUCT = "harnessaas"


def map_harnessaas_http_error(
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
    if status == 422:
        return AgenticError(
            "safety_blocked",
            body_text or "request blocked by PII/safety pre-flight",
            retryable=False,
            **common,
        )
    # No in-app rate limiter or explicit 5xx emission was found in
    # harnessaas's own route code -- classified retryable=True here for
    # forward compatibility ONLY; `solve()` never acts on this.
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
    if status == 500:
        return AgenticError(
            "protocol", body_text or "internal server error", retryable=False, **common
        )
    return AgenticError(
        "protocol", body_text or f"unexpected status {status}", retryable=False, **common
    )


__all__ = ["map_harnessaas_http_error"]
