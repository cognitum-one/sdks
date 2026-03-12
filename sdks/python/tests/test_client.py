"""Tests for the Cognitum Python SDK."""

from __future__ import annotations

import httpx
import pytest
import respx

from cognitum import (
    AsyncCognitum,
    AuthError,
    Cognitum,
    CognitumError,
    NotFoundError,
    RateLimitError,
    ValidationError,
)

BASE_URL = "https://api.test.cognitum.one"
API_KEY = "test-api-key-1234"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def client() -> Cognitum:
    c = Cognitum(api_key=API_KEY, base_url=BASE_URL, max_retries=0)
    yield c
    c.close()


@pytest.fixture()
def async_client() -> AsyncCognitum:
    c = AsyncCognitum(api_key=API_KEY, base_url=BASE_URL, max_retries=0)
    yield c


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


@respx.mock
def test_health(client: Cognitum) -> None:
    respx.get(f"{BASE_URL}/health").mock(
        return_value=httpx.Response(
            200, json={"status": "ok", "version": "1.2.3", "timestamp": "2026-01-01T00:00:00Z"}
        )
    )
    resp = client.health()
    assert resp.status == "ok"
    assert resp.version == "1.2.3"


@respx.mock
@pytest.mark.asyncio
async def test_health_async(async_client: AsyncCognitum) -> None:
    respx.get(f"{BASE_URL}/health").mock(
        return_value=httpx.Response(
            200, json={"status": "ok", "version": "1.2.3"}
        )
    )
    resp = await async_client.health()
    assert resp.status == "ok"
    await async_client.close()


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------


@respx.mock
def test_catalog_browse(client: Cognitum) -> None:
    respx.get(f"{BASE_URL}/listTemplates").mock(
        return_value=httpx.Response(
            200,
            json={
                "products": [
                    {"id": "p1", "name": "Seed Device", "description": "AI hardware"},
                    {"id": "p2", "name": "Cognitum Pro", "description": "Pro tier"},
                ],
                "total": 2,
            },
        )
    )
    result = client.catalog.browse()
    assert len(result.products) == 2
    assert result.products[0].id == "p1"
    assert result.products[0].name == "Seed Device"
    assert result.total == 2


@respx.mock
def test_catalog_browse_with_category(client: Cognitum) -> None:
    route = respx.get(f"{BASE_URL}/listTemplates").mock(
        return_value=httpx.Response(200, json={"products": [], "total": 0})
    )
    client.catalog.browse(category="hardware")
    assert route.called
    assert route.calls[0].request.url.params["category"] == "hardware"


# ---------------------------------------------------------------------------
# Orders
# ---------------------------------------------------------------------------


@respx.mock
def test_order_status(client: Cognitum) -> None:
    respx.get(f"{BASE_URL}/lookupOrderStatus").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": "ord_123",
                "email": "user@example.com",
                "status": "confirmed",
                "quantity": 1,
            },
        )
    )
    order = client.orders.status("ord_123")
    assert order.id == "ord_123"
    assert order.status == "confirmed"


@respx.mock
def test_order_create(client: Cognitum) -> None:
    respx.post(f"{BASE_URL}/createPresalePaymentIntent").mock(
        return_value=httpx.Response(
            200,
            json={
                "orderId": "ord_456",
                "clientSecret": "pi_secret_abc",
                "status": "pending",
            },
        )
    )
    resp = client.orders.create("user@example.com", quantity=2)
    assert resp.order_id == "ord_456"
    assert resp.client_secret == "pi_secret_abc"


# ---------------------------------------------------------------------------
# API Key Header Injection
# ---------------------------------------------------------------------------


@respx.mock
def test_api_key_header_injected(client: Cognitum) -> None:
    route = respx.get(f"{BASE_URL}/health").mock(
        return_value=httpx.Response(200, json={"status": "ok"})
    )
    client.health()
    request = route.calls[0].request
    assert request.headers["X-API-Key"] == API_KEY


# ---------------------------------------------------------------------------
# Error Mapping
# ---------------------------------------------------------------------------


@respx.mock
def test_auth_error(client: Cognitum) -> None:
    respx.get(f"{BASE_URL}/health").mock(
        return_value=httpx.Response(401, json={"error": "Invalid API key"})
    )
    with pytest.raises(AuthError) as exc_info:
        client.health()
    assert "Invalid API key" in exc_info.value.message
    assert exc_info.value.code == "auth_error"


@respx.mock
def test_forbidden_error(client: Cognitum) -> None:
    respx.get(f"{BASE_URL}/health").mock(
        return_value=httpx.Response(403, json={"error": "Forbidden"})
    )
    with pytest.raises(AuthError):
        client.health()


@respx.mock
def test_not_found_error(client: Cognitum) -> None:
    respx.get(f"{BASE_URL}/lookupOrderStatus").mock(
        return_value=httpx.Response(404, json={"error": "Order not found"})
    )
    with pytest.raises(NotFoundError) as exc_info:
        client.orders.status("nonexistent")
    assert exc_info.value.code == "not_found"


@respx.mock
def test_validation_error(client: Cognitum) -> None:
    respx.post(f"{BASE_URL}/sendContactEmail").mock(
        return_value=httpx.Response(400, json={"error": "Invalid email"})
    )
    with pytest.raises(ValidationError) as exc_info:
        client.contact.send("Test", "bad", "Hello")
    assert "Invalid email" in exc_info.value.message


@respx.mock
def test_rate_limit_error(client: Cognitum) -> None:
    respx.get(f"{BASE_URL}/health").mock(
        return_value=httpx.Response(
            429,
            json={"error": "Too many requests"},
            headers={"Retry-After": "5"},
        )
    )
    with pytest.raises(RateLimitError) as exc_info:
        client.health()
    assert exc_info.value.retry_after_seconds == 5.0
    assert exc_info.value.code == "rate_limited"


@respx.mock
def test_generic_server_error(client: Cognitum) -> None:
    respx.get(f"{BASE_URL}/health").mock(
        return_value=httpx.Response(502, json={"error": "Bad gateway"})
    )
    with pytest.raises(CognitumError) as exc_info:
        client.health()
    assert exc_info.value.code == "http_502"


# ---------------------------------------------------------------------------
# Context Manager
# ---------------------------------------------------------------------------


@respx.mock
def test_context_manager() -> None:
    respx.get(f"{BASE_URL}/health").mock(
        return_value=httpx.Response(200, json={"status": "ok"})
    )
    with Cognitum(api_key=API_KEY, base_url=BASE_URL, max_retries=0) as client:
        resp = client.health()
        assert resp.status == "ok"


@respx.mock
@pytest.mark.asyncio
async def test_async_context_manager() -> None:
    respx.get(f"{BASE_URL}/health").mock(
        return_value=httpx.Response(200, json={"status": "ok"})
    )
    async with AsyncCognitum(api_key=API_KEY, base_url=BASE_URL, max_retries=0) as client:
        resp = await client.health()
        assert resp.status == "ok"


# ---------------------------------------------------------------------------
# Leads
# ---------------------------------------------------------------------------


@respx.mock
def test_lead_subscribe(client: Cognitum) -> None:
    route = respx.post(f"{BASE_URL}/saveNotifyLead").mock(
        return_value=httpx.Response(200, json={"success": True})
    )
    result = client.leads.subscribe("user@example.com", product="seed")
    assert result["success"] is True
    assert route.called


# ---------------------------------------------------------------------------
# MCP
# ---------------------------------------------------------------------------


@respx.mock
def test_mcp_list_tools(client: Cognitum) -> None:
    respx.get(f"{BASE_URL}/apiMcpTools").mock(
        return_value=httpx.Response(
            200,
            json={
                "tools": [
                    {"name": "docs_search", "description": "Search docs", "inputSchema": {}},
                ]
            },
        )
    )
    tools = client.mcp.list_tools()
    assert len(tools) == 1
    assert tools[0].name == "docs_search"


@respx.mock
def test_mcp_call_tool(client: Cognitum) -> None:
    respx.post(f"{BASE_URL}/mcpSse").mock(
        return_value=httpx.Response(
            200,
            json={"result": {"content": [{"type": "text", "text": "Hello"}]}},
        )
    )
    result = client.mcp.call_tool("greet", arguments={"name": "World"})
    assert result.is_error is False
    assert result.content is not None


# ---------------------------------------------------------------------------
# Retry Behaviour (sync only -- verifies backoff is wired up)
# ---------------------------------------------------------------------------


@respx.mock
def test_retry_on_500() -> None:
    """Client with max_retries=1 should retry once on 500 then succeed."""
    route = respx.get(f"{BASE_URL}/health").mock(
        side_effect=[
            httpx.Response(500, json={"error": "Internal"}),
            httpx.Response(200, json={"status": "ok"}),
        ]
    )
    with Cognitum(api_key=API_KEY, base_url=BASE_URL, max_retries=1) as client:
        resp = client.health()
        assert resp.status == "ok"
    assert route.call_count == 2


@respx.mock
def test_retry_exhaustion_raises() -> None:
    """After exhausting retries on 500, the error is raised."""
    respx.get(f"{BASE_URL}/health").mock(
        return_value=httpx.Response(500, json={"error": "Down"})
    )
    with Cognitum(api_key=API_KEY, base_url=BASE_URL, max_retries=1) as client:
        with pytest.raises(CognitumError):
            client.health()
