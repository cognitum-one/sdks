"""HttpTransport tests (new McpClient-compatible transport).

Uses ``respx`` to mock the remote MCP endpoint so these tests run in a
few milliseconds and don't need network.
"""

from __future__ import annotations

import asyncio

import httpx
import respx

from cognitum.mcp import HttpTransport, McpClient


def _run(coro):
    return asyncio.run(coro)


def test_http_transport_send_recv_cycle():
    async def scenario():
        url = "https://mock.cognitum.test/mcp"
        with respx.mock(base_url="https://mock.cognitum.test") as mock:
            route = mock.post("/mcp").respond(
                200,
                json={"jsonrpc": "2.0", "id": 1, "result": {"ok": True}},
            )
            t = HttpTransport(url=url)
            async with t:
                await t.send({"jsonrpc": "2.0", "id": 1, "method": "ping"})
                resp = await t.recv()
                assert resp == {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}
                assert route.called

    _run(scenario())


def test_http_transport_passes_headers():
    async def scenario():
        url = "https://mock.cognitum.test/mcp"
        with respx.mock(base_url="https://mock.cognitum.test") as mock:
            route = mock.post("/mcp").respond(
                200,
                json={"jsonrpc": "2.0", "id": 1, "result": {}},
            )
            t = HttpTransport(url=url, headers={"X-Api-Key": "sk-test"})
            async with t:
                await t.send({"jsonrpc": "2.0", "id": 1, "method": "noop"})
                await t.recv()
            assert route.calls.last.request.headers["x-api-key"] == "sk-test"

    _run(scenario())


def test_http_transport_reuses_injected_client():
    async def scenario():
        url = "https://mock.cognitum.test/mcp"
        with respx.mock(base_url="https://mock.cognitum.test") as mock:
            mock.post("/mcp").respond(
                200, json={"jsonrpc": "2.0", "id": 1, "result": {}}
            )
            client = httpx.AsyncClient()
            try:
                t = HttpTransport(url=url, client=client)
                await t.open()
                await t.send({"jsonrpc": "2.0", "id": 1, "method": "noop"})
                await t.recv()
                await t.close()
                # Injected client must NOT be closed by the transport.
                assert not client.is_closed
            finally:
                await client.aclose()

    _run(scenario())


def test_http_transport_recv_without_send_raises():
    async def scenario():
        t = HttpTransport(url="https://mock.cognitum.test/mcp")
        await t.open()
        try:
            try:
                await t.recv()
            except RuntimeError:
                pass
            else:
                raise AssertionError("expected RuntimeError")
        finally:
            await t.close()

    _run(scenario())


def test_mcp_client_over_http_list_and_call():
    async def scenario():
        url = "https://mock.cognitum.test/mcp"
        tool_payload = {
            "tools": [
                {
                    "name": "docs_search",
                    "description": "Search docs.",
                    "inputSchema": {"type": "object"},
                }
            ]
        }
        call_payload = {"content": [{"type": "text", "text": "hello"}], "isError": False}

        def handler(request: httpx.Request) -> httpx.Response:
            body = request.read().decode()
            if '"tools/list"' in body:
                return httpx.Response(
                    200, json={"jsonrpc": "2.0", "id": 1, "result": tool_payload}
                )
            if '"tools/call"' in body:
                return httpx.Response(
                    200, json={"jsonrpc": "2.0", "id": 2, "result": call_payload}
                )
            return httpx.Response(400, json={"error": "unexpected"})

        with respx.mock(base_url="https://mock.cognitum.test") as mock:
            mock.post("/mcp").mock(side_effect=handler)
            async with McpClient(
                transport=HttpTransport(url=url, headers={"X-Api-Key": "sk"})
            ) as client:
                tools = await client.list_tools()
                assert [t.name for t in tools] == ["docs_search"]

                result = await client.call_tool("docs_search", {"query": "x"})
                assert result.is_error is False
                assert result.content == [{"type": "text", "text": "hello"}]

    _run(scenario())
