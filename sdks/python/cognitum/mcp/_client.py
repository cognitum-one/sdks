"""Transport-agnostic MCP client (OQ-4 parity with Node).

The :class:`McpClient` wraps a transport that implements the minimal
``open`` / ``send`` / ``recv`` / ``close`` async protocol. Two
transports ship today — :class:`cognitum.mcp.transports.HttpTransport`
and :class:`cognitum.mcp.transports.StdioTransport` — and third-party
transports are free to slot in.

Backward compatibility: the long-standing HTTP-only
:class:`cognitum.mcp.McpResource` / :class:`AsyncMcpResource` pair is
untouched. ``McpClient`` is additive and lives alongside the original
resources.

Convenience: passing ``url=...`` to ``McpClient`` constructs an
:class:`HttpTransport` implicitly so cloud users don't have to import
the transport class themselves.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from cognitum.types import McpTool, McpToolResult


@runtime_checkable
class Transport(Protocol):
    """Minimal async transport contract used by :class:`McpClient`.

    Any object implementing these four coroutines is a valid transport.
    ``open`` must be idempotent or cheap to call twice (the client calls
    it once on first use).
    """

    async def open(self) -> None: ...
    async def send(self, message: dict[str, Any]) -> None: ...
    async def recv(self) -> dict[str, Any]: ...
    async def close(self) -> None: ...


def _parse_tools(data: Any) -> list[McpTool]:
    """Extract an ``McpTool`` list from a JSON-RPC ``tools/list`` response."""
    if isinstance(data, dict):
        if "result" in data and isinstance(data["result"], dict):
            raw = data["result"].get("tools", [])
        elif "tools" in data:
            raw = data["tools"]
        else:
            raw = []
    elif isinstance(data, list):
        raw = data
    else:
        raw = []
    return [
        McpTool(
            name=t.get("name", ""),
            description=t.get("description", ""),
            input_schema=t.get("inputSchema", t.get("input_schema", {})),
        )
        for t in raw
    ]


def _parse_tool_result(data: Any) -> McpToolResult:
    """Extract an ``McpToolResult`` from a JSON-RPC ``tools/call`` response."""
    if isinstance(data, dict) and "result" in data and isinstance(data["result"], dict):
        result = data["result"]
        content = result.get("content", result)
        is_error = bool(result.get("isError", False))
        err_msg = None
    elif isinstance(data, dict) and "error" in data:
        content = None
        is_error = True
        err = data["error"]
        err_msg = err.get("message") if isinstance(err, dict) else str(err)
    else:
        content = data
        is_error = False
        err_msg = None
    return McpToolResult(
        content=content, is_error=is_error, error_message=err_msg
    )


class McpClient:
    """Transport-agnostic MCP client (async).

    Examples
    --------
    Stdio (launch a local subprocess MCP server)::

        from cognitum.mcp import McpClient
        from cognitum.mcp.transports import StdioTransport

        async with McpClient(
            transport=StdioTransport(command="npx", args=["-y", "@some/mcp-server"])
        ) as client:
            tools = await client.list_tools()
            result = await client.call_tool("some_tool", {"arg": "value"})

    HTTP (explicit transport)::

        from cognitum.mcp import McpClient
        from cognitum.mcp.transports import HttpTransport

        async with McpClient(transport=HttpTransport("https://api.cognitum.one/mcpSse")) as client:
            ...

    HTTP (backward-compat ``url=`` shortcut)::

        async with McpClient(url="https://api.cognitum.one/mcpSse") as client:
            ...
    """

    def __init__(
        self,
        transport: Transport | None = None,
        *,
        url: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        if transport is None and url is None:
            raise TypeError(
                "McpClient requires either a transport= or url= argument"
            )
        if transport is not None and url is not None:
            raise TypeError(
                "McpClient: pass either transport= or url=, not both"
            )
        if transport is None:
            # Local import to avoid an unconditional httpx hit for callers
            # that only want StdioTransport.
            from cognitum.mcp.transports._http import HttpTransport

            assert url is not None
            transport = HttpTransport(url=url, headers=headers or {})
        if not isinstance(transport, Transport):
            raise TypeError(
                "McpClient transport must implement open/send/recv/close "
                f"(got {type(transport).__name__})"
            )
        self._transport: Transport = transport
        self._opened = False
        self._next_id = 0

    # --- lifecycle ---------------------------------------------------

    async def open(self) -> None:
        if not self._opened:
            await self._transport.open()
            self._opened = True

    async def close(self) -> None:
        if self._opened:
            try:
                await self._transport.close()
            finally:
                self._opened = False

    async def __aenter__(self) -> McpClient:
        await self.open()
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.close()

    # --- MCP methods -------------------------------------------------

    async def list_tools(self) -> list[McpTool]:
        """Issue ``tools/list`` and return the parsed tool list."""
        resp = await self._request("tools/list", params=None)
        return _parse_tools(resp)

    async def call_tool(
        self, name: str, arguments: dict[str, Any] | None = None
    ) -> McpToolResult:
        """Issue ``tools/call`` with ``name`` + ``arguments``."""
        resp = await self._request(
            "tools/call",
            params={"name": name, "arguments": arguments or {}},
        )
        return _parse_tool_result(resp)

    # --- internals ---------------------------------------------------

    def _allocate_id(self) -> int:
        self._next_id += 1
        return self._next_id

    async def _request(
        self, method: str, params: dict[str, Any] | None
    ) -> dict[str, Any]:
        await self.open()
        envelope: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": self._allocate_id(),
            "method": method,
        }
        if params is not None:
            envelope["params"] = params
        await self._transport.send(envelope)
        return await self._transport.recv()
