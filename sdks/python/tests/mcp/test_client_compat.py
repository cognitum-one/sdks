"""Backward-compatibility tests for :mod:`cognitum.mcp`.

Ensures that:

- ``from cognitum.mcp import McpResource, AsyncMcpResource`` still
  resolves (the 0.1.x import path) after the package refactor.
- ``McpClient(url=...)`` shortcut constructs an HttpTransport
  implicitly and works end-to-end.
- ``McpClient`` requires exactly one of ``transport`` / ``url``.
- ``cognitum.Cognitum`` / ``cognitum.AsyncCognitum`` continue to expose
  ``.mcp`` bound to the HTTP resource class.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
import respx

from cognitum import AsyncCognitum, Cognitum
from cognitum.mcp import (
    AsyncMcpResource,
    HttpTransport,
    McpClient,
    McpResource,
    StdioTransport,
)


def _run(coro):
    return asyncio.run(coro)


def test_old_imports_still_resolve():
    # The two classes 0.1.x code depends on.
    assert McpResource is not None
    assert AsyncMcpResource is not None
    # New additions.
    assert McpClient is not None
    assert HttpTransport is not None
    assert StdioTransport is not None


def test_clients_expose_mcp_resource():
    with Cognitum(api_key="sk-test") as client:
        assert isinstance(client.mcp, McpResource)

    async def ascenario():
        async with AsyncCognitum(api_key="sk-test") as client:
            assert isinstance(client.mcp, AsyncMcpResource)

    _run(ascenario())


def test_mcp_client_url_shortcut_constructs_http_transport():
    async def scenario():
        url = "https://mock.cognitum.test/mcp"
        with respx.mock(base_url="https://mock.cognitum.test") as mock:
            mock.post("/mcp").respond(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {
                        "tools": [
                            {
                                "name": "t1",
                                "description": "",
                                "inputSchema": {},
                            }
                        ]
                    },
                },
            )
            async with McpClient(url=url, headers={"X-Api-Key": "sk"}) as client:
                tools = await client.list_tools()
                assert [t.name for t in tools] == ["t1"]

    _run(scenario())


def test_mcp_client_requires_transport_or_url():
    with pytest.raises(TypeError):
        McpClient()


def test_mcp_client_rejects_both_transport_and_url():
    t = HttpTransport(url="https://x/")
    with pytest.raises(TypeError):
        McpClient(transport=t, url="https://y/")


def test_mcp_client_rejects_bad_transport():
    class Bogus:
        # Missing send/recv/close — not a valid Transport.
        async def open(self) -> None:  # noqa: D401
            pass

    with pytest.raises(TypeError):
        McpClient(transport=Bogus())  # type: ignore[arg-type]


def test_httpx_client_injection_still_works_via_mcpclient():
    async def scenario():
        url = "https://mock.cognitum.test/mcp"
        with respx.mock(base_url="https://mock.cognitum.test") as mock:
            mock.post("/mcp").respond(
                200, json={"jsonrpc": "2.0", "id": 1, "result": {"tools": []}}
            )
            ac = httpx.AsyncClient()
            try:
                transport = HttpTransport(url=url, client=ac)
                async with McpClient(transport=transport) as client:
                    tools = await client.list_tools()
                    assert tools == []
                # Injected client should survive the transport close.
                assert not ac.is_closed
            finally:
                await ac.aclose()

    _run(scenario())
