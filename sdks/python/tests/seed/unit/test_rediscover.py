"""Unit tests for :meth:`SeedClient.rediscover` (ADR-0016b)."""

from __future__ import annotations

from cognitum.seed import PeerState, SeedClient, SeedTLS
from cognitum.seed._peers import PeerErrorClass

BASE_A = "https://a:8443"
BASE_B = "https://b:8443"


def _mesh_client() -> SeedClient:
    return SeedClient(
        [BASE_A, BASE_B],
        tls=SeedTLS(insecure=True),
        max_retries=1,
        max_elapsed_ms=1_000,
    )


def test_rediscover_resets_peer_state_and_trust_counters() -> None:
    with _mesh_client() as c:
        # Simulate accumulated degradation on peer A.
        with c._transport._peers_lock:
            c._transport._peers.mark_failure(BASE_A, PeerErrorClass.NETWORK)
            c._transport._peers.mark_failure(BASE_A, PeerErrorClass.NETWORK)
            c._transport._peers.mark_failure(BASE_A, PeerErrorClass.NETWORK)
        c._transport._trust_record_failure(BASE_A)

        snap_before = c.peers()
        a_before = next(p for p in snap_before if p.endpoint.url == BASE_A)
        assert a_before.state is PeerState.UNHEALTHY
        assert a_before.consecutive_failures == 3
        assert c._transport._trust_count(BASE_A) == 1

        c.rediscover()

        snap_after = c.peers()
        a_after = next(p for p in snap_after if p.endpoint.url == BASE_A)
        assert a_after.state is PeerState.HEALTHY
        assert a_after.consecutive_failures == 0
        assert a_after.latency_ema_ms is None
        # Trust counter also cleared.
        assert c._transport._trust_count(BASE_A) == 0


def test_rediscover_is_idempotent() -> None:
    with _mesh_client() as c:
        c.rediscover()
        c.rediscover()
        c.rediscover()
        peers = c.peers()
        assert len(peers) == 2
        assert all(p.state is PeerState.HEALTHY for p in peers)
