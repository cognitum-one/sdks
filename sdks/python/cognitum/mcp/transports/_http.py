"""HTTP transport for :class:`cognitum.mcp.McpClient`.

Wraps an :class:`httpx.AsyncClient` and posts JSON-RPC envelopes to an
MCP HTTP endpoint, returning the parsed response.

This is the *client-side* transport object used by the new
:class:`cognitum.mcp.McpClient` shape (mirroring Node's transport
abstraction). The pre-existing :class:`cognitum.mcp.AsyncMcpResource`
continues to use the SDK's own :class:`cognitum._http.AsyncHttpClient`
and is not affected.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx


@dataclass(slots=True)
class HttpTransport:
    """Post MCP JSON-RPC envelopes to a remote HTTP endpoint.

    Parameters
    ----------
    url:
        Full URL of the MCP endpoint (e.g.
        ``"https://api.cognitum.one/mcpSse"``).
    headers:
        Extra HTTP headers to send on every request (e.g. an auth token).
    timeout:
        Per-request timeout in seconds.
    client:
        Optional pre-configured ``httpx.AsyncClient``. If ``None``, the
        transport owns its own client and closes it on ``close()``.
    """

    url: str
    headers: dict[str, str] = field(default_factory=dict)
    timeout: float = 30.0
    client: httpx.AsyncClient | None = None

    _owns_client: bool = field(default=False, init=False, repr=False)
    _pending: list[dict[str, Any]] = field(default_factory=list, init=False, repr=False)

    async def open(self) -> None:
        if self.client is None:
            self.client = httpx.AsyncClient(timeout=self.timeout)
            self._owns_client = True

    async def send(self, message: dict[str, Any]) -> None:
        """Send a single JSON-RPC message and buffer the response.

        HTTP is a request/response protocol, so each ``send`` triggers a
        POST immediately; the decoded response is queued for the next
        :meth:`recv` call to mirror the stdio transport's streaming API.
        """
        if self.client is None:
            await self.open()
        assert self.client is not None
        resp = await self.client.post(
            self.url, json=message, headers=self.headers or None
        )
        resp.raise_for_status()
        data = resp.json()
        if not isinstance(data, dict):
            raise ValueError(
                f"MCP HTTP response was not a JSON object: {type(data).__name__}"
            )
        self._pending.append(data)

    async def recv(self) -> dict[str, Any]:
        if not self._pending:
            raise RuntimeError(
                "HttpTransport.recv() called before a matching send()"
            )
        return self._pending.pop(0)

    async def close(self) -> None:
        if self.client is not None and self._owns_client:
            await self.client.aclose()
        self.client = None
        self._owns_client = False
        self._pending.clear()

    async def __aenter__(self) -> HttpTransport:
        await self.open()
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.close()
