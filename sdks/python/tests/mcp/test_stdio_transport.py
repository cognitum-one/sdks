"""StdioTransport tests.

Spawns a tiny Python-based echo MCP server as the mock subprocess,
exercises the full ``open`` / ``send`` / ``recv`` / ``close`` lifecycle,
and verifies the timeout escalation path plus the stderr drain.

No pytest-asyncio plugin: tests run their coroutines via
``asyncio.run()`` so the suite is self-contained.
"""

from __future__ import annotations

import asyncio
import sys

import pytest

from cognitum.mcp import McpClient, StdioTransport

# A trivial stdio MCP server: echoes every JSON line back inside a
# JSON-RPC envelope. Written inline so the test doesn't need a fixture
# file on disk.
ECHO_SERVER = r"""
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except Exception as e:
        sys.stdout.write(json.dumps({"error": str(e)}) + "\n")
        sys.stdout.flush()
        continue
    resp = {"jsonrpc": "2.0", "id": req.get("id"), "result": {"echo": req}}
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()
"""

NOISY_SERVER = r"""
import json, sys
# Spam stderr so the drain task must stay alive.
for i in range(500):
    sys.stderr.write(f"noise line {i}\n")
sys.stderr.flush()
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    resp = {"jsonrpc": "2.0", "id": req.get("id"), "result": {"ok": True}}
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()
"""

# Server that ignores stdin close and SIGTERM (approximately) — used to
# verify the kill-escalation path. We can't easily trap SIGTERM in a
# portable way from a Python -c oneliner, so we simulate "won't exit
# gracefully" by not reading stdin AND not exiting when it closes.
HANGING_SERVER = r"""
import time, sys, signal
try:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
except Exception:
    pass
while True:
    time.sleep(0.2)
"""


def _run(coro):
    """Run ``coro`` on a fresh event loop for one test."""
    return asyncio.run(coro)


def test_roundtrip_send_recv():
    async def scenario():
        t = StdioTransport(command=sys.executable, args=["-c", ECHO_SERVER])
        async with t:
            await t.send({"jsonrpc": "2.0", "id": 1, "method": "ping"})
            resp = await t.recv()
            assert resp["id"] == 1
            assert resp["result"]["echo"]["method"] == "ping"

            await t.send({"jsonrpc": "2.0", "id": 2, "method": "pong"})
            resp2 = await t.recv()
            assert resp2["id"] == 2
            assert resp2["result"]["echo"]["method"] == "pong"

    _run(scenario())


def test_close_kills_subprocess_cleanly():
    async def scenario():
        t = StdioTransport(command=sys.executable, args=["-c", ECHO_SERVER])
        await t.open()
        # Echo server exits cleanly when stdin closes.
        await t.close()
        # Idempotent close.
        await t.close()

    _run(scenario())


def test_close_timeout_triggers_terminate():
    async def scenario():
        t = StdioTransport(
            command=sys.executable,
            args=["-c", HANGING_SERVER],
            close_timeout=0.5,
        )
        await t.open()
        # Subprocess ignores stdin close + SIGTERM → close() must fall
        # through to kill(). Total bounded by ~2 × close_timeout.
        await t.close()

    _run(scenario())


def test_noisy_stderr_does_not_block_stdin_pipe():
    async def scenario():
        t = StdioTransport(command=sys.executable, args=["-c", NOISY_SERVER])
        async with t:
            # Issue enough round-trips to prove that stderr drain runs
            # concurrently with the read/write loop.
            for i in range(10):
                await t.send({"jsonrpc": "2.0", "id": i, "method": "noop"})
                resp = await t.recv()
                assert resp["id"] == i
                assert resp["result"]["ok"] is True

    _run(scenario())


def test_double_open_raises():
    async def scenario():
        t = StdioTransport(command=sys.executable, args=["-c", ECHO_SERVER])
        await t.open()
        try:
            with pytest.raises(RuntimeError):
                await t.open()
        finally:
            await t.close()

    _run(scenario())


def test_recv_before_open_raises():
    async def scenario():
        t = StdioTransport(command=sys.executable, args=["-c", ECHO_SERVER])
        with pytest.raises(RuntimeError):
            await t.recv()

    _run(scenario())


def test_mcp_client_with_stdio_list_and_call():
    """End-to-end: McpClient → StdioTransport → echo server.

    The echo server's ``result`` payload is shaped so ``_parse_tools``
    and ``_parse_tool_result`` both produce usable values.
    """
    server = r"""
import json, sys
TOOLS = [
    {"name": "echo", "description": "Echo back the input.", "inputSchema": {"type": "object"}},
    {"name": "add", "description": "Add two numbers.", "inputSchema": {"type": "object"}},
]
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    method = req.get("method")
    if method == "tools/list":
        resp = {"jsonrpc": "2.0", "id": req["id"], "result": {"tools": TOOLS}}
    elif method == "tools/call":
        params = req.get("params", {})
        resp = {
            "jsonrpc": "2.0",
            "id": req["id"],
            "result": {"content": [{"type": "text", "text": json.dumps(params)}], "isError": False},
        }
    else:
        resp = {
            "jsonrpc": "2.0",
            "id": req.get("id"),
            "error": {"code": -32601, "message": "method not found"},
        }
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()
"""

    async def scenario():
        async with McpClient(
            transport=StdioTransport(command=sys.executable, args=["-c", server])
        ) as client:
            tools = await client.list_tools()
            names = sorted(t.name for t in tools)
            assert names == ["add", "echo"]

            result = await client.call_tool("echo", {"value": 42})
            assert result.is_error is False
            # Content is the JSON-RPC content[] array — first entry
            # carries the echoed params.
            assert result.content[0]["type"] == "text"
            echoed = result.content[0]["text"]
            assert '"value": 42' in echoed or '"value":42' in echoed

    _run(scenario())
