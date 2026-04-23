"""HTTP-backed MCP resources for :class:`cognitum.Cognitum` /
:class:`cognitum.AsyncCognitum`.

These are the sync/async wrappers that have shipped since 0.1.0. They
live here (rather than at the package root) because ``cognitum.mcp`` is
now a package — see ``cognitum/mcp/__init__.py`` for the re-export
surface. Logic is carried over verbatim from the pre-0.2 ``mcp.py``.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from cognitum._http import AsyncHttpClient, SyncHttpClient
from cognitum.types import McpTool, McpToolResult


def _parse_tools(data: Any) -> list[McpTool]:
    raw = data if isinstance(data, list) else data.get("tools", [])
    return [
        McpTool(
            name=t.get("name", ""),
            description=t.get("description", ""),
            input_schema=t.get("inputSchema", t.get("input_schema", {})),
        )
        for t in raw
    ]


def _parse_tool_result(data: Any) -> McpToolResult:
    if "result" in data:
        result = data["result"]
        content = result.get("content", result)
        is_error = result.get("isError", False)
    elif "error" in data:
        content = None
        is_error = True
    else:
        content = data
        is_error = False

    return McpToolResult(
        content=content,
        is_error=is_error,
        error_message=data.get("error", {}).get("message") if is_error else None,
    )


def _jsonrpc_payload(name: str, arguments: dict[str, Any] | None) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": name,
            "arguments": arguments or {},
        },
    }


class McpResource:
    """Synchronous MCP resource (HTTP transport against the cloud API)."""

    def __init__(self, http: SyncHttpClient) -> None:
        self._http = http

    def list_tools(self) -> list[McpTool]:
        """List all available MCP tools."""
        data = self._http.get("/apiMcpTools")
        return _parse_tools(data)

    def call_tool(
        self, name: str, *, arguments: dict[str, Any] | None = None
    ) -> McpToolResult:
        """Invoke an MCP tool by name using JSON-RPC."""
        data = self._http.post("/mcpSse", json=_jsonrpc_payload(name, arguments))
        return _parse_tool_result(data)

    def search_docs(self, query: str, *, limit: int = 5) -> McpToolResult:
        """Search documentation via the docs_search MCP tool."""
        return self.call_tool(
            "docs_search", arguments={"query": query, "limit": limit}
        )


class AsyncMcpResource:
    """Asynchronous MCP resource (HTTP transport against the cloud API)."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def list_tools(self) -> list[McpTool]:
        """List all available MCP tools."""
        data = await self._http.get("/apiMcpTools")
        return _parse_tools(data)

    async def call_tool(
        self, name: str, *, arguments: dict[str, Any] | None = None
    ) -> McpToolResult:
        """Invoke an MCP tool by name using JSON-RPC."""
        data = await self._http.post(
            "/mcpSse", json=_jsonrpc_payload(name, arguments)
        )
        return _parse_tool_result(data)

    async def search_docs(self, query: str, *, limit: int = 5) -> McpToolResult:
        """Search documentation via the docs_search MCP tool."""
        return await self.call_tool(
            "docs_search", arguments={"query": query, "limit": limit}
        )

    async def connect_sse(
        self, *, tool_name: str | None = None
    ) -> AsyncIterator[dict[str, Any]]:
        """Connect to the MCP SSE stream and yield parsed events.

        Each yielded dict has keys ``event`` (str) and ``data`` (Any).
        """
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "notifications/subscribe",
            "params": {},
        }
        if tool_name:
            payload["params"] = {"name": tool_name}

        event_type: str | None = None
        async for line in self._http.stream_sse("/mcpSse", json=payload):
            stripped = line.strip()
            if stripped.startswith("event:"):
                event_type = stripped[len("event:"):].strip()
            elif stripped.startswith("data:"):
                raw = stripped[len("data:"):].strip()
                try:
                    data = json.loads(raw)
                except (json.JSONDecodeError, ValueError):
                    data = raw
                yield {"event": event_type or "message", "data": data}
                event_type = None
            elif stripped == "":
                event_type = None
