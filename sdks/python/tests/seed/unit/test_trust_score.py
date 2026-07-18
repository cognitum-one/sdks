"""Regression tests for issue #16 / audit P-D1 — the trust-score counter
must be per-peer transport-instance state that survives across
``request()`` calls. A caller who issues three consecutive authed calls
and gets 401 each time must trip :class:`TrustScoreBlockedError` on the
SDK side BEFORE the seed's own 3-strike counter bans the caller's IP.

Covers ADR-0007 §Trust-score protection.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
import respx

from cognitum._errors import (
    AuthError,
    AuthReason,
    TrustScoreBlockedError,
)
from cognitum.seed import AsyncSeedClient, SeedClient, SeedTLS

BASE = "https://localhost:18443"
BASE2 = "https://localhost:18444"


def _client(endpoints: str | list[str] = BASE) -> SeedClient:
    return SeedClient(
        endpoints,
        tls=SeedTLS(insecure=True),
        max_retries=0,
        max_elapsed_ms=1_000,
    )


# -- Sync --------------------------------------------------------------


@respx.mock
def test_three_consecutive_401s_raise_trust_score_blocked() -> None:
    # Every call returns 401. With max_retries=0 the first two surface
    # AuthError; the third MUST convert to TrustScoreBlockedError.
    respx.get(f"{BASE}/api/v1/status").mock(
        return_value=httpx.Response(401, json={"error": "nope"})
    )
    with _client() as c:
        with pytest.raises(AuthError) as exc1:
            c.status()
        assert not isinstance(exc1.value, TrustScoreBlockedError)

        with pytest.raises(AuthError) as exc2:
            c.status()
        assert not isinstance(exc2.value, TrustScoreBlockedError)

        with pytest.raises(TrustScoreBlockedError) as exc3:
            c.status()
        assert exc3.value.reason == AuthReason.TRUST_SCORE_BLOCKED
        assert exc3.value.peer_url == f"{BASE}:18443".replace(":18443:18443", ":18443")
        # peer_url has the normalised :port form
        assert exc3.value.peer_url.endswith(":18443")
        # Hard abort — NOT retriable.
        assert exc3.value.retriable is False
        # Underlying AuthError is preserved as __cause__.
        assert isinstance(exc3.value.__cause__, AuthError)
        assert exc3.value.code == "trust_score_blocked"


@respx.mock
def test_401_then_200_resets_counter() -> None:
    # After a success, the counter must go back to zero so the next 401
    # doesn't immediately trip the cutoff.
    respx.get(f"{BASE}/api/v1/status").mock(
        side_effect=[
            httpx.Response(401, json={"error": "nope"}),
            httpx.Response(401, json={"error": "nope"}),
            httpx.Response(
                200,
                json={
                    "device_id": "d",
                    "uptime_secs": 0,
                    "epoch": 0,
                    "total_vectors": 0,
                    "deleted_vectors": 0,
                    "file_size_bytes": 0,
                    "dimension": 384,
                    "paired": True,
                },
            ),
            httpx.Response(401, json={"error": "nope"}),
        ]
    )
    with _client() as c:
        with pytest.raises(AuthError):
            c.status()
        with pytest.raises(AuthError):
            c.status()
        # 2xx resets the per-peer counter.
        assert c.status().device_id == "d"
        # Now a single 401 should still be AuthError, NOT
        # TrustScoreBlockedError — the prior run is forgotten.
        with pytest.raises(AuthError) as exc:
            c.status()
        assert not isinstance(exc.value, TrustScoreBlockedError)


@respx.mock
def test_per_peer_counters_are_independent() -> None:
    # Two 401s on peer-A + two 401s on peer-B must NOT combine into a
    # 4-strike cutoff. Each peer has its own counter.
    respx.get(f"{BASE}/api/v1/status").mock(
        return_value=httpx.Response(401, json={"error": "nope"})
    )
    respx.get(f"{BASE2}/api/v1/status").mock(
        return_value=httpx.Response(401, json={"error": "nope"})
    )
    client = SeedClient(
        [BASE, BASE2],
        tls=SeedTLS(insecure=True),
        max_retries=0,
        max_elapsed_ms=1_000,
        routing="pinned",
    )
    try:
        # Pin each session to its own peer to avoid cycling.
        s_a = client.session()
        # Force the second session onto BASE2 by picking the other peer.
        # The session() helper pins to the currently-best peer; for a
        # deterministic split we just drive each base URL through the
        # transport directly via peer_key.
        tr = client._transport
        # Peer A: two 401s.
        with pytest.raises(AuthError):
            tr.request(
                "GET",
                "/api/v1/status",
                peer_key=f"{BASE}:18443".replace(":18443:18443", ":18443").replace(
                    "18443:18443", "18443"
                ),
            )
        # Use the real normalised url — fetch from the peer snapshot.
        snap = client.peers_snapshot()
        peer_keys = [p.endpoint.url for p in snap]
        assert len(peer_keys) == 2
        key_a, key_b = peer_keys
        # Reset anything the first (deliberately-wrong-key) call pinned.
        client.reset_trust_score()
        # Peer A: 2x 401.
        with pytest.raises(AuthError):
            tr.request("GET", "/api/v1/status", peer_key=key_a)
        with pytest.raises(AuthError):
            tr.request("GET", "/api/v1/status", peer_key=key_a)
        # Peer B: 2x 401. If the counter leaked across peers this third
        # aggregate-strike would raise TrustScoreBlockedError; it MUST
        # raise AuthError.
        with pytest.raises(AuthError) as exc:
            tr.request("GET", "/api/v1/status", peer_key=key_b)
        assert not isinstance(exc.value, TrustScoreBlockedError)
        with pytest.raises(AuthError) as exc2:
            tr.request("GET", "/api/v1/status", peer_key=key_b)
        assert not isinstance(exc2.value, TrustScoreBlockedError)
        # Peer A's third strike must still trip even though B has 2.
        with pytest.raises(TrustScoreBlockedError) as exc3:
            tr.request("GET", "/api/v1/status", peer_key=key_a)
        assert exc3.value.peer_url == key_a
        _ = s_a
    finally:
        client.close()


@respx.mock
def test_trust_score_blocked_not_retriable_and_does_not_cycle() -> None:
    # With two peers both returning 401, the mesh failover loop MUST NOT
    # cycle from peer A to peer B on an AuthError (only 5xx / timeouts /
    # NetworkError cycle). So 401-401-401 on the pinned peer should hit
    # the 3-strike cutoff WITHOUT touching the second peer.
    route_a = respx.get(f"{BASE}/api/v1/status").mock(
        return_value=httpx.Response(401, json={"error": "nope"})
    )
    route_b = respx.get(f"{BASE2}/api/v1/status").mock(
        return_value=httpx.Response(401, json={"error": "nope"})
    )
    client = SeedClient(
        [BASE, BASE2],
        tls=SeedTLS(insecure=True),
        max_retries=0,
        max_elapsed_ms=1_000,
        routing="session",
    )
    try:
        snap = client.peers_snapshot()
        key_a = snap[0].endpoint.url
        # Force a fixed peer via peer_key to guarantee the count lands
        # on the same key three times.
        tr = client._transport
        with pytest.raises(AuthError):
            tr.request("GET", "/api/v1/status", peer_key=key_a)
        with pytest.raises(AuthError):
            tr.request("GET", "/api/v1/status", peer_key=key_a)
        with pytest.raises(TrustScoreBlockedError) as exc:
            tr.request("GET", "/api/v1/status", peer_key=key_a)
        assert exc.value.retriable is False
        # Peer B must never have been hit — AuthError does not cycle.
        assert route_b.call_count == 0
        assert route_a.call_count == 3
    finally:
        client.close()


@respx.mock
def test_cycling_on_5xx_still_works_after_earlier_401() -> None:
    # Earlier 401 (counter at 1) must NOT prevent the subsequent 5xx
    # cycle-to-next-peer behaviour from working. 5xx does not increment
    # the auth counter, and a mixed sequence should still deliver the
    # 200 by cycling.
    respx.get(f"{BASE}/api/v1/status").mock(
        side_effect=[
            httpx.Response(401, json={"error": "nope"}),
            httpx.Response(503, json={"error": "down"}),
        ]
    )
    respx.get(f"{BASE2}/api/v1/status").mock(
        return_value=httpx.Response(
            200,
            json={
                "device_id": "d2",
                "uptime_secs": 0,
                "epoch": 0,
                "total_vectors": 0,
                "deleted_vectors": 0,
                "file_size_bytes": 0,
                "dimension": 384,
                "paired": True,
            },
        )
    )
    client = SeedClient(
        [BASE, BASE2],
        tls=SeedTLS(insecure=True),
        max_retries=2,
        max_elapsed_ms=2_000,
        routing="pinned",
    )
    try:
        snap = client.peers_snapshot()
        key_a = snap[0].endpoint.url
        # First call: 401 on A (counter=1), does NOT cycle on AuthError.
        with pytest.raises(AuthError):
            client._transport.request(
                "GET", "/api/v1/status", peer_key=key_a
            )
        # Second call: 503 on A cycles to B → 200.
        s = client._transport.request(
            "GET", "/api/v1/status", peer_key=key_a
        )
        assert s["device_id"] == "d2"
        # Counter for A is still 1 (not reset — the 200 came from B).
        # Verify by triggering exactly 2 more 401s on A and expecting
        # the 3rd (total) to trip the cutoff.
        respx.get(f"{BASE}/api/v1/status").mock(
            return_value=httpx.Response(401, json={"error": "nope"})
        )
        with pytest.raises(AuthError):
            client._transport.request(
                "GET", "/api/v1/status", peer_key=key_a
            )
        with pytest.raises(TrustScoreBlockedError):
            client._transport.request(
                "GET", "/api/v1/status", peer_key=key_a
            )
    finally:
        client.close()


@respx.mock
def test_reset_trust_score_all() -> None:
    respx.get(f"{BASE}/api/v1/status").mock(
        return_value=httpx.Response(401, json={"error": "nope"})
    )
    with _client() as c:
        with pytest.raises(AuthError):
            c.status()
        with pytest.raises(AuthError):
            c.status()
        c.reset_trust_score()
        # After reset the next 401 is plain AuthError, not the cutoff.
        with pytest.raises(AuthError) as exc:
            c.status()
        assert not isinstance(exc.value, TrustScoreBlockedError)


# -- Async -------------------------------------------------------------


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


@respx.mock
def test_async_three_consecutive_401s_raise_trust_score_blocked() -> None:
    respx.get(f"{BASE}/api/v1/status").mock(
        return_value=httpx.Response(401, json={"error": "nope"})
    )

    async def scenario() -> None:
        client = AsyncSeedClient(
            BASE,
            tls=SeedTLS(insecure=True),
            max_retries=0,
            max_elapsed_ms=1_000,
        )
        try:
            with pytest.raises(AuthError):
                await client.status()
            with pytest.raises(AuthError):
                await client.status()
            with pytest.raises(TrustScoreBlockedError) as exc:
                await client.status()
            assert exc.value.reason == AuthReason.TRUST_SCORE_BLOCKED
            assert exc.value.retriable is False
        finally:
            await client.close()

    _run(scenario())
