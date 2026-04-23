"""``SeedClient.close()`` / ``AsyncSeedClient.close()`` + context manager.

Covers the validator finding from
``/tmp/swarm-seed-validation/PHASE1-5-MESH-VALIDATION.md``: Python's seed
clients now match Node (``close()``) and Rust (``Drop`` + explicit
``close()``) — idempotent shutdown, context manager support, and clear
post-close errors so callers cannot silently reuse a dead client.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

from cognitum.seed import AsyncSeedClient, SeedClient, SeedTLS


def _respond_status(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "version": "test",
            "device_id": "dev-1",
            "paired": True,
            "total_vectors": 0,
            "uptime_seconds": 1,
            "mesh_enabled": False,
            "mesh_peers": 0,
        },
    )


def _make_sync_client() -> SeedClient:
    """Build a real SeedClient with its httpx.Client swapped for a
    MockTransport so we can assert the full ``status()`` round-trip
    without the network. ``tls=SeedTLS(insecure=True)`` keeps the
    ``http://`` URL accepted by config normalisation (ADR-0013b).
    """
    client = SeedClient(
        "http://127.0.0.1:8080", tls=SeedTLS(insecure=True),
    )
    client._transport._client = httpx.Client(
        transport=httpx.MockTransport(_respond_status),
        timeout=5.0,
    )
    return client


def _make_async_client() -> AsyncSeedClient:
    client = AsyncSeedClient(
        "http://127.0.0.1:8080", tls=SeedTLS(insecure=True),
    )
    client._transport._client = httpx.AsyncClient(
        transport=httpx.MockTransport(_respond_status),
        timeout=5.0,
    )
    return client


class TestSeedClientClose:
    """Sync lifecycle."""

    def test_context_manager_happy_path(self) -> None:
        with _make_sync_client() as c:
            status = c.status()
            assert status.device_id == "dev-1"
        assert c.closed is True

    def test_close_is_idempotent(self) -> None:
        c = _make_sync_client()
        c.close()
        c.close()  # must not raise
        assert c.closed is True

    def test_status_after_close_raises_runtime_error(self) -> None:
        c = _make_sync_client()
        c.close()
        with pytest.raises(RuntimeError, match="SeedClient is closed"):
            c.status()

    def test_resource_call_after_close_raises(self) -> None:
        """Resource namespaces share the same transport — they must
        also reject calls once the client is closed."""
        c = _make_sync_client()
        c.close()
        with pytest.raises(RuntimeError, match="SeedClient is closed"):
            c.store.status()

    def test_context_manager_exits_cleanly_on_exception(self) -> None:
        c = _make_sync_client()
        with pytest.raises(ValueError, match="boom"):
            with c:
                raise ValueError("boom")
        assert c.closed is True


class TestAsyncSeedClientClose:
    """Async lifecycle — same invariants."""

    def test_async_context_manager_happy_path(self) -> None:
        async def run() -> Any:
            async with _make_async_client() as c:
                status = await c.status()
                assert status.device_id == "dev-1"
            return c

        c = asyncio.new_event_loop().run_until_complete(run())
        assert c.closed is True

    def test_async_close_is_idempotent(self) -> None:
        async def run() -> None:
            c = _make_async_client()
            await c.close()
            await c.close()  # must not raise
            assert c.closed is True

        asyncio.new_event_loop().run_until_complete(run())

    def test_aclose_alias_works(self) -> None:
        """``aclose()`` is the httpx-style alias; both names must work."""
        async def run() -> None:
            c = _make_async_client()
            await c.aclose()
            assert c.closed is True
            await c.aclose()  # idempotent via the alias too

        asyncio.new_event_loop().run_until_complete(run())

    def test_status_after_aclose_raises_runtime_error(self) -> None:
        async def run() -> None:
            c = _make_async_client()
            await c.close()
            with pytest.raises(
                RuntimeError, match="AsyncSeedClient is closed"
            ):
                await c.status()

        asyncio.new_event_loop().run_until_complete(run())

    def test_resource_call_after_close_raises(self) -> None:
        async def run() -> None:
            c = _make_async_client()
            await c.close()
            with pytest.raises(
                RuntimeError, match="AsyncSeedClient is closed"
            ):
                await c.store.status()

        asyncio.new_event_loop().run_until_complete(run())

    def test_async_context_manager_exits_cleanly_on_exception(self) -> None:
        async def run() -> AsyncSeedClient:
            c = _make_async_client()
            with pytest.raises(ValueError, match="boom"):
                async with c:
                    raise ValueError("boom")
            return c

        c = asyncio.new_event_loop().run_until_complete(run())
        assert c.closed is True
