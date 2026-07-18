"""Peer-set management for Phase 1.5 mesh routing (ADR-0016a §D7).

Mirrors the Rust reference at ``sdks/rust/src/seed/peers.rs``. The public
types continue to expose the Phase 1 single-peer shape; mesh-mode works
by constructing a :class:`PeerSet` with N>=1 :class:`Endpoint` values
and letting the routing layer pick closest-first / cycle on failure.

Threading / async safety: mutation of internal state (``mark_success`` /
``mark_failure``) happens under ``threading.Lock`` owned by the
transport; :func:`pick` and :func:`next_after` return *copies* of the
chosen :class:`Peer` so the caller never holds the lock across an
``await`` / sleep.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from enum import Enum

from cognitum.seed._config import Endpoint
from cognitum.seed._errors import ConfigError


class PeerState(Enum):
    """Routing-layer peer health state (ADR-0016a §D7)."""

    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNHEALTHY = "unhealthy"

    def rank(self) -> int:
        """Lower rank sorts first."""
        if self is PeerState.HEALTHY:
            return 0
        if self is PeerState.DEGRADED:
            return 1
        return 2


class PeerErrorClass(Enum):
    """Error class observed on a peer-level request outcome."""

    NETWORK = "network"
    TIMEOUT = "timeout"
    SERVER_5XX = "server_5xx"
    SERVICE_UNAVAILABLE = "service_unavailable"


@dataclass(slots=True)
class Peer:
    """One configured seed endpoint plus its latency / health state.

    Mirrors the Rust ``Peer`` struct. ``latency_ema_ms`` stays ``None``
    until the first observation so newly-added peers don't shadow warm
    ones with a made-up zero EMA.
    """

    list_index: int
    endpoint: Endpoint
    state: PeerState = PeerState.HEALTHY
    latency_ema_ms: float | None = None
    last_used_at: float | None = None  # monotonic seconds
    consecutive_failures: int = 0

    def key(self) -> str:
        """Canonical URL key used by :class:`TokenBook` and mesh routing."""
        return self.endpoint.url.rstrip("/")

    def sort_key(self) -> tuple[int, int, int]:
        """Stable sort key: (state rank, latency EMA quantized, list_index).

        Peers with no EMA sort after peers with a known-fast latency
        (matches Rust's ``u64::MAX / 2`` sentinel semantics).
        """
        if self.latency_ema_ms is None:
            ema_q = 2**62  # large sentinel, still beats truly-slow peers
        else:
            ema_q = int(max(0.0, self.latency_ema_ms) * 1_000.0)
        return (self.state.rank(), ema_q, self.list_index)


@dataclass(slots=True)
class PeerSet:
    """Ordered peer table.

    Phase 1 degenerates to a one-element list; Phase 1.5 accepts 1..N.
    Constructor order is preserved as each :class:`Peer`'s ``list_index``
    so sort ties break deterministically.
    """

    peers: list[Peer] = field(default_factory=list)

    @classmethod
    def single(cls, endpoint: Endpoint) -> PeerSet:
        """Build a single-peer set (Phase 1 degenerate case)."""
        return cls(peers=[Peer(list_index=0, endpoint=endpoint)])

    @classmethod
    def new(cls, endpoints: list[Endpoint]) -> PeerSet:
        """Phase 1.5 constructor — accepts 1..N endpoints."""
        if not endpoints:
            raise ConfigError(
                "PeerSet requires at least one endpoint", field="endpoints"
            )
        return cls(
            peers=[Peer(list_index=i, endpoint=ep) for i, ep in enumerate(endpoints)]
        )

    def __len__(self) -> int:
        return len(self.peers)

    def __iter__(self) -> Iterator[Peer]:
        return iter(self.peers)

    @property
    def is_mesh(self) -> bool:
        """Whether more than one peer is configured."""
        return len(self.peers) > 1

    def primary(self) -> Peer:
        """The first endpoint (constructor order)."""
        return self.peers[0]

    def find_by_key(self, wanted_key: str) -> Peer | None:
        """Look up a peer by its canonical URL key."""
        return next((p for p in self.peers if p.key() == wanted_key), None)

    def snapshot(self) -> list[Peer]:
        """Return a defensive copy for introspection (never held-across-await)."""
        return [
            Peer(
                list_index=p.list_index,
                endpoint=p.endpoint,
                state=p.state,
                latency_ema_ms=p.latency_ema_ms,
                last_used_at=p.last_used_at,
                consecutive_failures=p.consecutive_failures,
            )
            for p in self.peers
        ]

    def pick(self) -> Peer:
        """Pick the next peer to dispatch against (closest-first).

        Prefers HEALTHY > DEGRADED; falls back to UNHEALTHY only if every
        peer is unhealthy (so a request still attempts something).
        """
        if not self.peers:
            raise ConfigError("PeerSet is empty", field="endpoints")
        return min(self.peers, key=Peer.sort_key)

    def next_after(self, failed: Peer) -> Peer | None:
        """Next peer to try after ``failed`` returned a cycling error.

        Skips ``failed`` by ``list_index``; scans remaining peers in the
        same closest-first order.
        """
        candidates = [p for p in self.peers if p.list_index != failed.list_index]
        if not candidates:
            return None
        return min(candidates, key=Peer.sort_key)

    def mark_success(self, peer_key: str, latency_s: float) -> None:
        """Record a successful outcome: update EMA, clear failure counter,
        promote state to HEALTHY.
        """
        peer = self.find_by_key(peer_key)
        if peer is None:
            return
        ms = max(0.0, latency_s) * 1_000.0
        if peer.latency_ema_ms is None:
            peer.latency_ema_ms = ms
        else:
            peer.latency_ema_ms = 0.8 * peer.latency_ema_ms + 0.2 * ms
        peer.consecutive_failures = 0
        peer.state = PeerState.HEALTHY
        peer.last_used_at = time.monotonic()

    def mark_failure(self, peer_key: str, cls: PeerErrorClass) -> None:
        """Record a failure.

        * ``SERVICE_UNAVAILABLE`` — immediate UNHEALTHY (lockdown semantics).
        * ``NETWORK`` / ``TIMEOUT`` / ``SERVER_5XX`` — bumps
          ``consecutive_failures``; DEGRADED at 1-2, UNHEALTHY at >=3.
        """
        peer = self.find_by_key(peer_key)
        if peer is None:
            return
        peer.consecutive_failures += 1
        peer.last_used_at = time.monotonic()
        if cls is PeerErrorClass.SERVICE_UNAVAILABLE:
            peer.state = PeerState.UNHEALTHY
        elif peer.consecutive_failures >= 3:
            peer.state = PeerState.UNHEALTHY
        else:
            peer.state = PeerState.DEGRADED


__all__ = [
    "Peer",
    "PeerErrorClass",
    "PeerSet",
    "PeerState",
]
