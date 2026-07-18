"""Unit tests for :class:`MeshResource` / :class:`AsyncMeshResource`
(ADR-0016a §D8, ADR-0016b).

Wire shapes captured from live seed v0.20.0 on 2026-04-22.
"""

from __future__ import annotations

import asyncio

import httpx
import respx

from cognitum.seed import (
    AsyncSeedClient,
    ClusterHealth,
    MeshPeers,
    MeshStatus,
    SeedClient,
    SeedTLS,
    SwarmStatus,
)

BASE = "https://localhost:18443"


def _client() -> SeedClient:
    return SeedClient(
        BASE, tls=SeedTLS(insecure=True),
        max_retries=1, max_elapsed_ms=2_000,
    )


@respx.mock
def test_mesh_status_parses_live_shape() -> None:
    respx.get(f"{BASE}/api/v1/network/mesh/status").mock(
        return_value=httpx.Response(
            200,
            json={
                "ap_active": True,
                "auto_mesh": False,
                "connected_to_seed": False,
                "device_id": "ad7d7e7b-56e7-4e03-b078-939209858144",
                "has_mesh_password": False,
                "peer_count": 0,
                "peers": [],
                "unknown_future_field": 42,  # forward-compat
            },
        )
    )
    with _client() as c:
        s = c.mesh.status()
    assert isinstance(s, MeshStatus)
    assert s.ap_active is True
    assert s.peer_count == 0
    assert s.peers == ()
    assert s.extra["unknown_future_field"] == 42


@respx.mock
def test_mesh_peers_parses_live_shape() -> None:
    respx.get(f"{BASE}/api/v1/peers").mock(
        return_value=httpx.Response(
            200,
            json={
                "count": 2,
                "discovery_active": True,
                "peers": [
                    {
                        "device_id": "dev-a",
                        "endpoint": "https://a:8443",
                        "status": "healthy",
                        "last_seen": 1776906500,
                    },
                    {
                        "device_id": "dev-b",
                        "endpoint": "https://b:8443",
                        "status": "degraded",
                    },
                ],
            },
        )
    )
    with _client() as c:
        p = c.mesh.peers()
    assert isinstance(p, MeshPeers)
    assert p.count == 2
    assert p.discovery_active is True
    assert len(p.peers) == 2
    assert p.peers[0].device_id == "dev-a"
    assert p.peers[0].last_seen == 1776906500
    assert p.peers[1].status == "degraded"


@respx.mock
def test_swarm_status_parses_live_shape() -> None:
    respx.get(f"{BASE}/api/v1/swarm/status").mock(
        return_value=httpx.Response(
            200,
            json={
                "device_id": "ad7d7e7b",
                "discovery_active": True,
                "epoch": 20564,
                "peer_count": 0,
                "total_vectors": 8460,
                "uptime_secs": 23001,
            },
        )
    )
    with _client() as c:
        s = c.mesh.swarm_status()
    assert isinstance(s, SwarmStatus)
    assert s.epoch == 20564
    assert s.total_vectors == 8460
    assert s.uptime_secs == 23001


@respx.mock
def test_cluster_health_parses_live_shape() -> None:
    respx.get(f"{BASE}/api/v1/cluster/health").mock(
        return_value=httpx.Response(
            200,
            json={
                "auto_sync_interval_secs": 60,
                "cluster_enabled": True,
                "discovery_active": True,
                "last_sync_attempt": 1776906537,
                "peer_count": 0,
                "peers": [],
            },
        )
    )
    with _client() as c:
        h = c.mesh.cluster_health()
    assert isinstance(h, ClusterHealth)
    assert h.cluster_enabled is True
    assert h.auto_sync_interval_secs == 60
    assert h.last_sync_attempt == 1776906537


@respx.mock
def test_async_mesh_resource_parity() -> None:
    respx.get(f"{BASE}/api/v1/network/mesh/status").mock(
        return_value=httpx.Response(
            200,
            json={"ap_active": False, "peer_count": 0, "peers": []},
        )
    )

    async def _run() -> bool:
        async with AsyncSeedClient(
            BASE, tls=SeedTLS(insecure=True),
            max_retries=1, max_elapsed_ms=2_000,
        ) as c:
            s = await c.mesh.status()
        return s.ap_active

    assert asyncio.run(_run()) is False
