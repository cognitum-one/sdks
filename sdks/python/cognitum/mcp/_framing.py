"""Newline-delimited JSON framing for MCP stdio transport.

MCP's stdio line protocol frames each JSON-RPC message as a single line:
``<json>\\n``. No length prefix, no Content-Length header (unlike the
LSP-style framing). This module keeps the framing logic in one place so
both the transport and tests share it.

See:
- https://modelcontextprotocol.io/specification — transport.stdio
- ``sdks/node/src/mcp-stdio.ts`` (Node's server side uses the same
  line-delimited JSON over stdin/stdout).
"""

from __future__ import annotations

import json
from typing import Any


def encode(message: dict[str, Any]) -> bytes:
    """Encode a JSON-RPC message as ``<json>\\n`` bytes.

    Uses compact separators (no spaces) and ``ensure_ascii=False`` so
    non-ASCII payloads pass through unchanged.
    """
    line = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
    return (line + "\n").encode("utf-8")


def decode(line: bytes | str) -> dict[str, Any]:
    """Decode one line (with or without trailing newline) into a dict.

    Raises :class:`ValueError` if the line does not parse as JSON or
    decodes to a non-object JSON value.
    """
    if isinstance(line, bytes):
        text = line.decode("utf-8")
    else:
        text = line
    text = text.strip()
    if not text:
        raise ValueError("empty line")
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError(
            f"expected JSON object, got {type(value).__name__}"
        )
    return value
