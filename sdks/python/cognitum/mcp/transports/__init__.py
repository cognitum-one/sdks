"""Transports for :class:`cognitum.mcp.McpClient`.

Two transports ship today:

- :class:`HttpTransport` — POSTs JSON-RPC envelopes over HTTPS.
- :class:`StdioTransport` — spawns a subprocess MCP server and speaks
  newline-delimited JSON-RPC over its stdin/stdout.

Each transport implements the same minimal async protocol
(``open`` / ``send`` / ``recv`` / ``close``) plus async context-manager
support.
"""

from __future__ import annotations

from cognitum.mcp.transports._http import HttpTransport
from cognitum.mcp.transports._stdio import StdioTransport

__all__ = ["HttpTransport", "StdioTransport"]
