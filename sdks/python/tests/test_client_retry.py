"""Retry-policy tests for the cloud HTTP transport.

Covers closure of GitHub issues:

- ``cognitum-one/sdks#8`` — 502 and 504 must be treated as retriable
  alongside 429 / 500 / 503 (ADR-0005 §Retriable outcomes).
- ``cognitum-one/sdks#9`` — POST must NOT retry by default on retriable
  statuses; callers may opt in with ``idempotent=True`` (ADR-0005
  §Idempotency).

These tests use ``respx`` to mock upstream responses so they stay
deterministic and cheap. The sync transport is exercised directly; the
async twin shares the same policy helpers so coverage here is sufficient
to close both issues without pulling ``pytest-asyncio`` into the budget.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from cognitum import Cognitum, CognitumError
from cognitum._http import SyncHttpClient

BASE_URL = "https://api.test.cognitum.one"
API_KEY = "test-api-key-retry"


# ---------------------------------------------------------------------------
# Issue #8 — 502 / 504 must retry
# ---------------------------------------------------------------------------


@respx.mock
def test_retry_on_502_three_attempts() -> None:
    """502 Bad Gateway is retriable per ADR-0005 (closes #8)."""
    route = respx.get(f"{BASE_URL}/health").mock(
        side_effect=[
            httpx.Response(502, json={"error": "Bad gateway"}),
            httpx.Response(502, json={"error": "Bad gateway"}),
            httpx.Response(200, json={"status": "ok"}),
        ]
    )
    with Cognitum(api_key=API_KEY, base_url=BASE_URL, max_retries=2) as client:
        resp = client.health()
        assert resp.status == "ok"
    assert route.call_count == 3


@respx.mock
def test_retry_on_504_three_attempts() -> None:
    """504 Gateway Timeout is retriable per ADR-0005 (closes #8)."""
    route = respx.get(f"{BASE_URL}/health").mock(
        side_effect=[
            httpx.Response(504, json={"error": "Gateway timeout"}),
            httpx.Response(504, json={"error": "Gateway timeout"}),
            httpx.Response(200, json={"status": "ok"}),
        ]
    )
    with Cognitum(api_key=API_KEY, base_url=BASE_URL, max_retries=2) as client:
        resp = client.health()
        assert resp.status == "ok"
    assert route.call_count == 3


@respx.mock
def test_500_on_get_still_retries() -> None:
    """Regression: 500 on an idempotent GET still retries (unchanged)."""
    route = respx.get(f"{BASE_URL}/health").mock(
        side_effect=[
            httpx.Response(500, json={"error": "Down"}),
            httpx.Response(500, json={"error": "Down"}),
            httpx.Response(200, json={"status": "ok"}),
        ]
    )
    with Cognitum(api_key=API_KEY, base_url=BASE_URL, max_retries=2) as client:
        resp = client.health()
        assert resp.status == "ok"
    assert route.call_count == 3


# ---------------------------------------------------------------------------
# Issue #9 — POST must not retry by default on retriable 5xx
# ---------------------------------------------------------------------------


@respx.mock
def test_500_on_post_default_single_attempt() -> None:
    """POST 500 now runs exactly once and raises (closes #9).

    BREAKING CHANGE from pre-ADR-0005 behaviour — callers that relied on
    implicit POST retries must pass ``idempotent=True`` explicitly.
    """
    route = respx.post(f"{BASE_URL}/sendContactEmail").mock(
        return_value=httpx.Response(500, json={"error": "Internal"})
    )
    with Cognitum(api_key=API_KEY, base_url=BASE_URL, max_retries=2) as client:
        with pytest.raises(CognitumError):
            client.contact.send("Test", "u@example.com", "Hello")
    # Default POST — no retry attempts beyond the initial request.
    assert route.call_count == 1


@respx.mock
def test_500_on_post_idempotent_true_retries() -> None:
    """Caller-attested idempotent POSTs do retry on 500 (closes #9)."""
    route = respx.post(f"{BASE_URL}/search").mock(
        side_effect=[
            httpx.Response(500, json={"error": "Internal"}),
            httpx.Response(500, json={"error": "Internal"}),
            httpx.Response(200, json={"results": []}),
        ]
    )
    http = SyncHttpClient(
        base_url=BASE_URL, api_key=API_KEY, max_retries=2
    )
    try:
        data = http.post("/search", json={"q": "foo"}, idempotent=True)
        assert data == {"results": []}
    finally:
        http.close()
    assert route.call_count == 3


@respx.mock
def test_502_on_post_default_single_attempt() -> None:
    """POST 502 is retriable-by-status but POST-by-default stays put."""
    route = respx.post(f"{BASE_URL}/saveNotifyLead").mock(
        return_value=httpx.Response(502, json={"error": "Bad gateway"})
    )
    with Cognitum(api_key=API_KEY, base_url=BASE_URL, max_retries=2) as client:
        with pytest.raises(CognitumError):
            client.leads.subscribe("user@example.com")
    assert route.call_count == 1


# ---------------------------------------------------------------------------
# Sanity: explicit idempotent=False on a GET disables retries
# ---------------------------------------------------------------------------


@respx.mock
def test_explicit_idempotent_false_on_get_disables_retry() -> None:
    route = respx.get(f"{BASE_URL}/status").mock(
        return_value=httpx.Response(500, json={"error": "Down"})
    )
    http = SyncHttpClient(
        base_url=BASE_URL, api_key=API_KEY, max_retries=3
    )
    try:
        with pytest.raises(CognitumError):
            http.request("GET", "/status", idempotent=False)
    finally:
        http.close()
    assert route.call_count == 1
