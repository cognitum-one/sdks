"""Mesh-observability resource — ADR-0016a §D8 / ADR-0016b.

Four read-only endpoints that let callers see the seed's *own* view of
the overlay (distinct from :meth:`SeedClient.peers_snapshot`, which is
the SDK-local peer table).

All four endpoints are part of the seed's WiFi-read allowlist; no
pairing token is required. Resource methods go through the standard
mesh-aware transport so per-call :class:`CallOptions` work unchanged.
"""

from __future__ import annotations

from typing import Any

from cognitum.seed._call_options import CallOptions
from cognitum.seed._models.mesh import (
    ClusterHealth,
    MeshPeers,
    MeshStatus,
    SwarmStatus,
)


class MeshResource:
    """Synchronous mesh-observability endpoints."""

    __slots__ = ("_http",)

    def __init__(self, http: Any) -> None:
        self._http = http

    def status(self, *, options: CallOptions | None = None) -> MeshStatus:
        data = self._http.request(
            "GET", "/api/v1/network/mesh/status", options=options
        )
        return MeshStatus.from_wire(data or {})

    def peers(self, *, options: CallOptions | None = None) -> MeshPeers:
        data = self._http.request("GET", "/api/v1/peers", options=options)
        return MeshPeers.from_wire(data or {})

    def swarm_status(
        self, *, options: CallOptions | None = None
    ) -> SwarmStatus:
        data = self._http.request(
            "GET", "/api/v1/swarm/status", options=options
        )
        return SwarmStatus.from_wire(data or {})

    def cluster_health(
        self, *, options: CallOptions | None = None
    ) -> ClusterHealth:
        data = self._http.request(
            "GET", "/api/v1/cluster/health", options=options
        )
        return ClusterHealth.from_wire(data or {})


class AsyncMeshResource:
    """Asynchronous mirror of :class:`MeshResource`."""

    __slots__ = ("_http",)

    def __init__(self, http: Any) -> None:
        self._http = http

    async def status(
        self, *, options: CallOptions | None = None
    ) -> MeshStatus:
        data = await self._http.request(
            "GET", "/api/v1/network/mesh/status", options=options
        )
        return MeshStatus.from_wire(data or {})

    async def peers(
        self, *, options: CallOptions | None = None
    ) -> MeshPeers:
        data = await self._http.request(
            "GET", "/api/v1/peers", options=options
        )
        return MeshPeers.from_wire(data or {})

    async def swarm_status(
        self, *, options: CallOptions | None = None
    ) -> SwarmStatus:
        data = await self._http.request(
            "GET", "/api/v1/swarm/status", options=options
        )
        return SwarmStatus.from_wire(data or {})

    async def cluster_health(
        self, *, options: CallOptions | None = None
    ) -> ClusterHealth:
        data = await self._http.request(
            "GET", "/api/v1/cluster/health", options=options
        )
        return ClusterHealth.from_wire(data or {})


__all__ = ["AsyncMeshResource", "MeshResource"]
