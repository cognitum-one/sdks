"""Phase 1.5 mesh-routing integration tests (ADR-0017 §5).

Translates the seven-test Rust suite at
``sdks/rust/tests/seed_mesh.rs`` verbatim (naming, ordering, intent).
Each test uses respx with 2-3 mocked endpoints to simulate a mesh; the
SDK routes across them via the Phase 1.5 ``PeerSet`` + failover state
machine.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx
import respx

from cognitum.seed import (
    AsyncSeedClient,
    InMemoryTokenBook,
    PeerState,
    SeedAuth,
    SeedClient,
    SeedTLS,
)

PEER_A = "https://a:8443"
PEER_B = "https://b:8443"


# ---------- shared fixtures -----------------------------------------------


def _status_body(**overrides: Any) -> dict[str, Any]:
    base = {
        "device_id": "abc",
        "uptime_secs": 1,
        "epoch": 1,
        "total_vectors": 0,
        "deleted_vectors": 0,
        "file_size_bytes": 0,
        "dimension": 8,
        "paired": True,
        "roles": [],
    }
    base.update(overrides)
    return base


def _store_status_body() -> dict[str, Any]:
    return {
        "total_vectors": 1,
        "deleted_vectors": 0,
        "file_size_bytes": 0,
        "dimension": 8,
    }


def _query_body() -> dict[str, Any]:
    return {"results": [], "query_ms": 0.0}


def _ingest_body() -> dict[str, Any]:
    return {"ingested": 1}


def _client(urls: list[str], **kwargs: Any) -> SeedClient:
    return SeedClient(
        urls,
        tls=SeedTLS(insecure=True),
        max_retries=kwargs.pop("max_retries", 3),
        max_elapsed_ms=kwargs.pop("max_elapsed_ms", 60_000),
        **kwargs,
    )


# ---------- 1. single-peer degenerates to Phase 1 -------------------------


@respx.mock
def test_mesh_single_peer_behaves_like_single_mode() -> None:
    route = respx.get(f"{PEER_A}/api/v1/status").mock(
        return_value=httpx.Response(200, json=_status_body())
    )
    with _client([PEER_A]) as c:
        st = c.status()
    assert st.paired
    assert len(c.peers_snapshot()) == 1
    assert route.called
    assert route.call_count == 1


# ---------- 2. two-peer smoke: both peers reachable -----------------------


@respx.mock
def test_mesh_two_peers_round_robin_for_reads() -> None:
    # Peer A: first /store/status fails 500 (cycle), subsequent calls OK.
    side_effect = [
        httpx.Response(500, text="boom"),
        httpx.Response(200, json=_store_status_body()),
        httpx.Response(200, json=_store_status_body()),
    ]
    a_route = respx.get(f"{PEER_A}/api/v1/store/status").mock(side_effect=side_effect)
    b_route = respx.get(f"{PEER_B}/api/v1/store/status").mock(
        return_value=httpx.Response(200, json=_store_status_body())
    )

    with _client([PEER_A, PEER_B]) as c:
        s1 = c.store.status()
        assert s1.dimension == 8
        # Second call — picker should prefer B since A is Degraded.
        s2 = c.store.status()
        assert s2.dimension == 8

    # Both peers must have served at least one request.
    assert a_route.call_count >= 1, f"A not hit ({a_route.call_count})"
    assert b_route.call_count >= 1, f"B not hit ({b_route.call_count})"


# ---------- 3. cycles on 5xx ----------------------------------------------


@respx.mock
def test_mesh_cycles_on_5xx() -> None:
    a_route = respx.post(f"{PEER_A}/api/v1/store/query").mock(
        return_value=httpx.Response(500, json={"error": "boom"})
    )
    b_route = respx.post(f"{PEER_B}/api/v1/store/query").mock(
        return_value=httpx.Response(200, json=_query_body())
    )

    t0 = time.monotonic()
    with _client([PEER_A, PEER_B], max_retries=0) as c:
        r = c.store.query(vector=[0.0] * 8, k=1)
    assert time.monotonic() - t0 < 60.0, "budget respected"
    assert len(r.results) == 0
    assert a_route.call_count == 1
    assert b_route.call_count == 1


# ---------- 4. pins on 429 -------------------------------------------------


@respx.mock
def test_mesh_pins_on_429() -> None:
    # A: first 429, second 200. Router MUST NOT cycle to B on 429.
    a_route = respx.get(f"{PEER_A}/api/v1/store/status").mock(
        side_effect=[
            httpx.Response(
                429,
                headers={"retry-after": "0"},
                json={"error": "rate limited"},
            ),
            httpx.Response(200, json=_store_status_body()),
        ]
    )
    b_route = respx.get(f"{PEER_B}/api/v1/store/status").mock(
        return_value=httpx.Response(200, json=_store_status_body())
    )

    with _client([PEER_A, PEER_B], max_retries=2) as c:
        s = c.store.status()
    assert s.dimension == 8
    assert a_route.call_count == 2, "A must see the retry (pinned on 429)"
    assert b_route.call_count == 0, "routing MUST NOT cycle to B on 429"


# ---------- 5. session stickiness -----------------------------------------


@respx.mock
def test_mesh_session_stickiness() -> None:
    a_ingest = respx.post(f"{PEER_A}/api/v1/store/ingest").mock(
        return_value=httpx.Response(200, json=_ingest_body())
    )
    a_query = respx.post(f"{PEER_A}/api/v1/store/query").mock(
        return_value=httpx.Response(200, json=_query_body())
    )
    b_ingest = respx.post(f"{PEER_B}/api/v1/store/ingest").mock(
        return_value=httpx.Response(200, json=_ingest_body())
    )
    b_query = respx.post(f"{PEER_B}/api/v1/store/query").mock(
        return_value=httpx.Response(200, json=_query_body())
    )

    with _client([PEER_A, PEER_B]) as c:
        with c.session() as sess:
            pinned = sess.pinned_peer
            sess.store.ingest(vectors=[])
            sess.store.query(vector=[0.0] * 8, k=1)

    if pinned == PEER_A:
        assert a_ingest.call_count == 1 and a_query.call_count == 1
        assert b_ingest.call_count == 0 and b_query.call_count == 0
    else:
        assert b_ingest.call_count == 1 and b_query.call_count == 1
        assert a_ingest.call_count == 0 and a_query.call_count == 0


# ---------- 6. per-peer TokenBook -----------------------------------------


@respx.mock
def test_mesh_token_book_per_peer() -> None:
    # Capture the X-Pairing-Token header on each request so we can assert
    # the SDK sent the peer-specific token.
    seen_a: list[str] = []
    seen_b: list[str] = []

    def _handler(peer_seen: list[str], token: str) -> Any:
        def _resp(request: httpx.Request) -> httpx.Response:
            peer_seen.append(request.headers.get("X-Pairing-Token", ""))
            return httpx.Response(
                200,
                json={
                    "client_name": "cli",
                    "token": token,
                    "expires_at": None,
                },
            )

        return _resp

    respx.post(f"{PEER_A}/api/v1/pair").mock(side_effect=_handler(seen_a, "tok-a-new"))
    respx.post(f"{PEER_B}/api/v1/pair").mock(side_effect=_handler(seen_b, "tok-b-new"))

    book = InMemoryTokenBook(
        {
            PEER_A: "tok-a",
            PEER_B: "tok-b",
        }
    )

    with SeedClient(
        [PEER_A, PEER_B],
        auth=SeedAuth(),
        tls=SeedTLS(insecure=True),
        token_book=book,
        max_retries=0,
    ) as c:
        c._pair_on_peer(PEER_A, "cli")
        c._pair_on_peer(PEER_B, "cli")

        tok_a = c.token_for_peer(PEER_A)
        tok_b = c.token_for_peer(PEER_B)
        assert tok_a is not None and tok_b is not None
        # After _pair_on_peer, the book holds the *new* server-issued token.
        assert tok_a.as_str() == "tok-a-new"
        assert tok_b.as_str() == "tok-b-new"

    # The outgoing requests must have carried the peer-specific tokens.
    assert seen_a == ["tok-a"], f"peer A saw {seen_a}"
    assert seen_b == ["tok-b"], f"peer B saw {seen_b}"


# ---------- 7. active health probe degrades unhealthy peer ----------------


@respx.mock
def test_mesh_health_probe_degrades_unhealthy_peer() -> None:
    # A's /status always 503s (lockdown); probe should degrade it.
    respx.get(f"{PEER_A}/api/v1/status").mock(
        return_value=httpx.Response(503, text="lockdown")
    )
    respx.get(f"{PEER_B}/api/v1/status").mock(
        return_value=httpx.Response(200, json=_status_body())
    )
    # Subsequent /store/status MUST land on B.
    b_store = respx.get(f"{PEER_B}/api/v1/store/status").mock(
        return_value=httpx.Response(200, json=_store_status_body())
    )
    # If routing went to A we'd surface 503 — catch that explicitly.
    a_store = respx.get(f"{PEER_A}/api/v1/store/status").mock(
        return_value=httpx.Response(503, text="lockdown")
    )

    with _client([PEER_A, PEER_B], max_retries=0, health_interval=0.05) as c:
        # Wait for a few probe ticks.
        time.sleep(0.4)

        snap = c.peers_snapshot()
        a_peer = next(p for p in snap if p.endpoint.url == PEER_A)
        assert a_peer.state in (PeerState.DEGRADED, PeerState.UNHEALTHY), (
            f"peer A should be degraded/unhealthy, got {a_peer.state}"
        )

        s = c.store.status()
        assert s.dimension == 8

    # The user call landed on B (A returns 503 and would fail).
    assert b_store.call_count >= 1
    # A's /store/status must NOT have been called — the picker skipped it.
    assert a_store.call_count == 0, "health probe failed to keep A out of pick()"


# ---------- bonus: async session stickiness -------------------------------
#
# phase-1.5-note: gated on pytest-asyncio. Wrapping with asyncio.run keeps
# the test runnable under the minimum dev install (respx only).


@respx.mock
def test_mesh_session_stickiness_async() -> None:
    a_q = respx.post(f"{PEER_A}/api/v1/store/query").mock(
        return_value=httpx.Response(200, json=_query_body())
    )
    b_q = respx.post(f"{PEER_B}/api/v1/store/query").mock(
        return_value=httpx.Response(200, json=_query_body())
    )

    async def _run() -> str:
        async with AsyncSeedClient(
            [PEER_A, PEER_B],
            tls=SeedTLS(insecure=True),
        ) as c:
            async with c.session() as sess:
                pinned = sess.pinned_peer
                await sess.store.query(vector=[0.0] * 8, k=1)
                await sess.store.query(vector=[0.0] * 8, k=1)
        return pinned

    pinned = asyncio.run(_run())

    if pinned == PEER_A:
        assert a_q.call_count == 2 and b_q.call_count == 0
    else:
        assert b_q.call_count == 2 and a_q.call_count == 0
