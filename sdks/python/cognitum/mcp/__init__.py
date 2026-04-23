"""MCP (Model Context Protocol) surface for the Cognitum SDK.

Two APIs live here:

1. The pre-0.2 :class:`McpResource` / :class:`AsyncMcpResource` pair
   bound to :class:`cognitum.Cognitum` / :class:`cognitum.AsyncCognitum`
   as ``client.mcp``. These continue to hit the cloud HTTP API using the
   SDK's own :class:`cognitum._http.AsyncHttpClient` and are unchanged
   from 0.1.0.
2. The transport-agnostic :class:`McpClient` (new in 0.2) which accepts
   any transport that implements ``open`` / ``send`` / ``recv`` /
   ``close``. Ships with :class:`HttpTransport` and
   :class:`StdioTransport` — see
   :mod:`cognitum.mcp.transports`. Closes OQ-4 (ADR-0013c §9.5).

Re-exports preserve the historical ``from cognitum.mcp import
McpResource, AsyncMcpResource`` imports that 0.1.x callers rely on;
the submodule layout is an internal refactor only.
"""

from __future__ import annotations

from cognitum.mcp._client import McpClient, Transport
from cognitum.mcp._resource import AsyncMcpResource, McpResource
from cognitum.mcp.transports import HttpTransport, StdioTransport

__all__ = [
    # Resources (HTTP-only, existing surface)
    "McpResource",
    "AsyncMcpResource",
    # Transport-agnostic client + transports (new — OQ-4 parity)
    "McpClient",
    "Transport",
    "HttpTransport",
    "StdioTransport",
]
