"""Stdio transport for :class:`cognitum.mcp.McpClient`.

Launches a subprocess MCP server and speaks newline-delimited JSON-RPC
over its stdin/stdout, mirroring Node's ``createStdioTransport(command,
args)`` client-side helper. The subprocess's stderr is drained in a
background task and forwarded to a logger so a noisy server can't block
the pipe.

Lifecycle:

- ``open()`` spawns the subprocess.
- ``send(msg)`` encodes + writes one line to stdin.
- ``recv()`` reads one line from stdout, decodes it.
- ``close()`` closes stdin, waits up to ``close_timeout`` seconds for
  the subprocess to exit, then terminates (and finally kills) it if
  still alive.

The transport is async-only; MCP stdio clients need a running event
loop to interleave reads, writes, and stderr drain.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field
from typing import Any

from cognitum.mcp._framing import decode, encode

logger = logging.getLogger("cognitum.mcp.stdio")


@dataclass(slots=True)
class StdioTransport:
    """Spawn a local MCP server subprocess and speak JSON-RPC over stdio.

    Parameters
    ----------
    command:
        Program to execute (e.g. ``"npx"``).
    args:
        Argument vector (without the program). Defaults to ``[]``.
    env:
        Extra env vars merged on top of the parent's env. ``None`` means
        inherit the parent env unchanged.
    cwd:
        Working directory for the subprocess. ``None`` uses the parent's
        cwd.
    close_timeout:
        Seconds to wait for the subprocess to exit gracefully after
        closing stdin before escalating to ``terminate()``/``kill()``.
    """

    command: str
    args: list[str] = field(default_factory=list)
    env: dict[str, str] | None = None
    cwd: str | None = None
    close_timeout: float = 5.0

    _process: asyncio.subprocess.Process | None = field(
        default=None, init=False, repr=False
    )
    _stderr_task: asyncio.Task[None] | None = field(
        default=None, init=False, repr=False
    )

    async def open(self) -> None:
        """Spawn the subprocess and start the stderr drain task."""
        if self._process is not None:
            raise RuntimeError("StdioTransport already opened")

        # Inherit parent env and layer per-call overrides on top.
        child_env: dict[str, str] | None
        if self.env is None:
            child_env = None
        else:
            child_env = {**os.environ, **self.env}

        self._process = await asyncio.create_subprocess_exec(
            self.command,
            *self.args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=child_env,
            cwd=self.cwd,
        )
        self._stderr_task = asyncio.create_task(
            self._drain_stderr(), name=f"stdio-stderr[{self.command}]"
        )

    async def send(self, message: dict[str, Any]) -> None:
        """Write one JSON-RPC message to the subprocess stdin."""
        proc = self._require_open()
        assert proc.stdin is not None  # PIPE guaranteed in open()
        proc.stdin.write(encode(message))
        await proc.stdin.drain()

    async def recv(self) -> dict[str, Any]:
        """Read one JSON-RPC message from the subprocess stdout.

        Raises :class:`EOFError` if the subprocess closed stdout
        without writing a full line.
        """
        proc = self._require_open()
        assert proc.stdout is not None  # PIPE guaranteed in open()
        line = await proc.stdout.readline()
        if not line:
            raise EOFError(
                "stdio transport: subprocess closed stdout before sending a "
                "full JSON-RPC line"
            )
        return decode(line)

    async def close(self) -> None:
        """Close stdin and wait for the subprocess to exit.

        Escalates to ``terminate()`` and then ``kill()`` if it does not
        exit within ``close_timeout``.
        """
        proc = self._process
        if proc is None:
            return

        try:
            if proc.stdin is not None and not proc.stdin.is_closing():
                try:
                    proc.stdin.close()
                except (BrokenPipeError, ConnectionResetError):
                    pass

            try:
                await asyncio.wait_for(proc.wait(), timeout=self.close_timeout)
            except asyncio.TimeoutError:
                logger.warning(
                    "stdio subprocess %r did not exit within %.1fs; terminating",
                    self.command,
                    self.close_timeout,
                )
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=self.close_timeout)
                except asyncio.TimeoutError:
                    logger.warning(
                        "stdio subprocess %r still alive after terminate; killing",
                        self.command,
                    )
                    proc.kill()
                    await proc.wait()
        finally:
            if self._stderr_task is not None:
                self._stderr_task.cancel()
                try:
                    await self._stderr_task
                except (asyncio.CancelledError, Exception):
                    # Drain errors are informational — never propagate.
                    pass
            self._process = None
            self._stderr_task = None

    async def __aenter__(self) -> StdioTransport:
        await self.open()
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.close()

    # --- internals ---------------------------------------------------

    def _require_open(self) -> asyncio.subprocess.Process:
        if self._process is None:
            raise RuntimeError("StdioTransport is not open")
        return self._process

    async def _drain_stderr(self) -> None:
        """Forward stderr lines to the module logger until EOF."""
        proc = self._process
        if proc is None or proc.stderr is None:
            return
        try:
            while True:
                line = await proc.stderr.readline()
                if not line:
                    return
                logger.debug(
                    "%s: %s", self.command, line.decode("utf-8", "replace").rstrip()
                )
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover — defensive
            logger.exception("stderr drain for %s failed", self.command)
