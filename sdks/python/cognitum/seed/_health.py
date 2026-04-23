"""Opt-in active health probe (ADR-0016a §D7).

Disabled by default — the SDK observes request outcomes opportunistically.
When the caller passes ``health_interval`` to :class:`SeedClient` /
:class:`AsyncSeedClient`, a background worker pings
``GET /api/v1/status`` on every configured peer every ``health_interval``
seconds and feeds the result into :class:`PeerSet`.

The sync variant uses a daemon :class:`threading.Thread`; the async
variant uses :func:`asyncio.create_task`. Both stop cleanly on client
close.
"""

from __future__ import annotations

import asyncio
import threading
import time
from typing import TYPE_CHECKING

import httpx

from cognitum.seed._peers import PeerErrorClass, PeerSet

if TYPE_CHECKING:  # pragma: no cover — type-only
    pass


def _classify_status(status: int) -> PeerErrorClass | None:
    if status == 503:
        return PeerErrorClass.SERVICE_UNAVAILABLE
    if status in (500, 502, 504):
        return PeerErrorClass.SERVER_5XX
    # 4xx on an unauthenticated probe typically means the peer is up but
    # refusing us — don't mark unhealthy.
    return None


class HealthProbe:
    """Synchronous background probe.

    Owned by :class:`SeedClient`; ``close()`` sets the stop event, joins
    the thread (best-effort), and returns.
    """

    __slots__ = ("_http", "_peers", "_interval", "_stop", "_thread")

    def __init__(
        self,
        http: httpx.Client,
        peers: PeerSet,
        interval: float,
    ) -> None:
        self._http = http
        self._peers = peers
        self._interval = float(interval)
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._run,
            name="cognitum-seed-health",
            daemon=True,
        )
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            # Snapshot URLs so we don't hold any lock across I/O. PeerSet
            # mutations are thread-safe via the SDK-wide lock held in the
            # transport, but defensively we take a copy here.
            targets = [(p.endpoint.url, p.endpoint.host) for p in self._peers.snapshot()]

            for url, _host in targets:
                if self._stop.is_set():
                    return
                started = time.monotonic()
                try:
                    resp = self._http.get(f"{url.rstrip('/')}/api/v1/status")
                    elapsed = time.monotonic() - started
                    if resp.status_code < 400:
                        self._peers.mark_success(url, elapsed)
                    else:
                        cls = _classify_status(resp.status_code)
                        if cls is not None:
                            self._peers.mark_failure(url, cls)
                except httpx.TimeoutException:
                    self._peers.mark_failure(url, PeerErrorClass.TIMEOUT)
                except httpx.TransportError:
                    self._peers.mark_failure(url, PeerErrorClass.NETWORK)

            # Wait with early-exit on stop.
            self._stop.wait(self._interval)

    def close(self) -> None:
        self._stop.set()
        # Don't block test shutdown on a stuck probe — daemon thread
        # dies with the interpreter.
        self._thread.join(timeout=max(0.5, self._interval))


class AsyncHealthProbe:
    """Asynchronous background probe (mirror of :class:`HealthProbe`)."""

    __slots__ = ("_http", "_peers", "_interval", "_task", "_stop")

    def __init__(
        self,
        http: httpx.AsyncClient,
        peers: PeerSet,
        interval: float,
    ) -> None:
        self._http = http
        self._peers = peers
        self._interval = float(interval)
        self._stop = asyncio.Event()
        self._task = asyncio.create_task(self._run(), name="cognitum-seed-health")

    async def _run(self) -> None:
        while not self._stop.is_set():
            targets = [p.endpoint.url for p in self._peers.snapshot()]
            for url in targets:
                if self._stop.is_set():
                    return
                started = time.monotonic()
                try:
                    resp = await self._http.get(f"{url.rstrip('/')}/api/v1/status")
                    elapsed = time.monotonic() - started
                    if resp.status_code < 400:
                        self._peers.mark_success(url, elapsed)
                    else:
                        cls = _classify_status(resp.status_code)
                        if cls is not None:
                            self._peers.mark_failure(url, cls)
                except httpx.TimeoutException:
                    self._peers.mark_failure(url, PeerErrorClass.TIMEOUT)
                except httpx.TransportError:
                    self._peers.mark_failure(url, PeerErrorClass.NETWORK)

            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self._interval)
            except asyncio.TimeoutError:
                pass

    async def close(self) -> None:
        self._stop.set()
        self._task.cancel()
        try:
            await self._task
        except (asyncio.CancelledError, Exception):
            pass


__all__ = ["AsyncHealthProbe", "HealthProbe"]
