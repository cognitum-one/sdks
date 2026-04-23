"""Mesh-observability wire models (ADR-0016a §D8, ADR-0016b).

Every model uses ``@dataclass(slots=True, frozen=True)`` with a loose
``extra`` dict so seed-side additions round-trip without a model bump
(ADR-0006 §Unknown-field). Wire shapes captured from seed v0.20.0 on
2026-04-22:

* ``GET /api/v1/network/mesh/status``::

    {"ap_active":true,"auto_mesh":false,"connected_to_seed":false,
     "device_id":"...","has_mesh_password":false,"peer_count":0,"peers":[]}

* ``GET /api/v1/peers``::

    {"count":0,"discovery_active":true,"peers":[]}

* ``GET /api/v1/swarm/status``::

    {"device_id":"...","discovery_active":true,"epoch":20564,
     "peer_count":0,"total_vectors":8460,"uptime_secs":23001}

* ``GET /api/v1/cluster/health``::

    {"auto_sync_interval_secs":60,"cluster_enabled":true,
     "discovery_active":true,"last_sync_attempt":1776906537,
     "peer_count":0,"peers":[]}
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any


def _split_extra(data: Mapping[str, Any], known: set[str]) -> tuple[
    dict[str, Any], dict[str, Any]
]:
    kwargs: dict[str, Any] = {}
    extra: dict[str, Any] = {}
    for k, v in data.items():
        if k in known:
            kwargs[k] = v
        else:
            extra[k] = v
    return kwargs, extra


@dataclass(slots=True, frozen=True)
class MeshPeer:
    """One peer entry in :class:`MeshStatus.peers` / :class:`MeshPeers.peers`.

    Seed today returns ``[]`` when the overlay is empty; this shape is
    the union of fields surfaced by the three endpoints that carry peer
    arrays (``network/mesh/status``, ``peers``, ``cluster/health``).
    """

    device_id: str = ""
    endpoint: str = ""
    status: str = ""
    last_seen: float | int | None = None
    extra: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> "MeshPeer":
        known = {"device_id", "endpoint", "status", "last_seen"}
        kwargs, extra = _split_extra(data, known)
        return cls(**kwargs, extra=extra)


@dataclass(slots=True, frozen=True)
class MeshStatus:
    """``GET /api/v1/network/mesh/status`` response."""

    device_id: str = ""
    ap_active: bool = False
    auto_mesh: bool = False
    connected_to_seed: bool = False
    has_mesh_password: bool = False
    peer_count: int = 0
    peers: Sequence[MeshPeer] = ()
    extra: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> "MeshStatus":
        known = {
            "device_id",
            "ap_active",
            "auto_mesh",
            "connected_to_seed",
            "has_mesh_password",
            "peer_count",
            "peers",
        }
        kwargs, extra = _split_extra(data, known)
        peers_raw = kwargs.pop("peers", [])
        peers = tuple(
            MeshPeer.from_wire(p) if isinstance(p, Mapping) else MeshPeer(extra={"raw": p})
            for p in (peers_raw or [])
        )
        return cls(**kwargs, peers=peers, extra=extra)


@dataclass(slots=True, frozen=True)
class MeshPeers:
    """``GET /api/v1/peers`` response."""

    count: int = 0
    discovery_active: bool = False
    peers: Sequence[MeshPeer] = ()
    extra: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> "MeshPeers":
        known = {"count", "discovery_active", "peers"}
        kwargs, extra = _split_extra(data, known)
        peers_raw = kwargs.pop("peers", [])
        peers = tuple(
            MeshPeer.from_wire(p) if isinstance(p, Mapping) else MeshPeer(extra={"raw": p})
            for p in (peers_raw or [])
        )
        return cls(**kwargs, peers=peers, extra=extra)


@dataclass(slots=True, frozen=True)
class SwarmStatus:
    """``GET /api/v1/swarm/status`` response."""

    device_id: str = ""
    discovery_active: bool = False
    epoch: int = 0
    peer_count: int = 0
    total_vectors: int = 0
    uptime_secs: int = 0
    extra: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> "SwarmStatus":
        known = {
            "device_id",
            "discovery_active",
            "epoch",
            "peer_count",
            "total_vectors",
            "uptime_secs",
        }
        kwargs, extra = _split_extra(data, known)
        return cls(**kwargs, extra=extra)


@dataclass(slots=True, frozen=True)
class ClusterHealth:
    """``GET /api/v1/cluster/health`` response."""

    auto_sync_interval_secs: int = 0
    cluster_enabled: bool = False
    discovery_active: bool = False
    last_sync_attempt: int | None = None
    peer_count: int = 0
    peers: Sequence[MeshPeer] = ()
    extra: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> "ClusterHealth":
        known = {
            "auto_sync_interval_secs",
            "cluster_enabled",
            "discovery_active",
            "last_sync_attempt",
            "peer_count",
            "peers",
        }
        kwargs, extra = _split_extra(data, known)
        peers_raw = kwargs.pop("peers", [])
        peers = tuple(
            MeshPeer.from_wire(p) if isinstance(p, Mapping) else MeshPeer(extra={"raw": p})
            for p in (peers_raw or [])
        )
        return cls(**kwargs, peers=peers, extra=extra)


__all__ = [
    "ClusterHealth",
    "MeshPeer",
    "MeshPeers",
    "MeshStatus",
    "SwarmStatus",
]
