"""HTTP-status -> ``AgenticErrorKind`` mapping for MetaProxyClient.

ADR-0025a §D8's Proxy-specific ``MetaProxyError`` shape
(``configured_plane``/``selected_plane``/``upstream_status`` fields) is
explicitly out of scope this pass -- this reuses the same ADR-0024a §D6
status table :mod:`cognitum.meta_llm.http_errors` uses, since none of these
statuses are Proxy-specific.
"""

from __future__ import annotations

from typing import Any

import httpx

from cognitum.agentic import AgenticError

_PRODUCT = "meta-proxy"


def map_meta_proxy_http_error(
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
            "authentication",
            body_text or "local Proxy authentication failed",
            retryable=False,
            **common,
        )
    if status == 403:
        return AgenticError(
            "permission_denied", body_text or "permission denied", retryable=False, **common
        )
    if status == 404:
        return AgenticError("not_found", body_text or "not found", retryable=False, **common)
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


__all__ = ["map_meta_proxy_http_error"]
