"""Unit tests for :class:`PeerSet` / :class:`Peer` (ADR-0016a §D7)."""

from __future__ import annotations

import pytest

from cognitum.seed import (
    Endpoint,
    Peer,
    PeerErrorClass,
    PeerSet,
    PeerState,
)


def _eps(*urls: str) -> list[Endpoint]:
    return [Endpoint.parse(u) for u in urls]


def test_peer_set_single_constructor():
    ps = PeerSet.single(Endpoint.parse("https://a:8443"))
    assert len(ps) == 1
    assert not ps.is_mesh
    assert ps.primary().endpoint.host == "a"


def test_peer_set_rejects_empty():
    from cognitum._errors import ConfigError

    with pytest.raises(ConfigError):
        PeerSet.new([])


def test_peer_set_preserves_constructor_order():
    ps = PeerSet.new(_eps("https://c:8443", "https://a:8443", "https://b:8443"))
    keys = [p.key() for p in ps]
    assert keys == ["https://c:8443", "https://a:8443", "https://b:8443"]


def test_pick_prefers_healthy_lower_latency():
    ps = PeerSet.new(_eps("https://a:8443", "https://b:8443", "https://c:8443"))
    # All healthy, no EMA — tie broken by list_index; A wins.
    assert ps.pick().endpoint.host == "a"

    # Warm B with fast latency; it should now win despite higher index.
    ps.mark_success("https://b:8443", latency_s=0.005)
    assert ps.pick().endpoint.host == "b"


def test_next_after_skips_failed_peer():
    ps = PeerSet.new(_eps("https://a:8443", "https://b:8443"))
    a = ps.primary()
    nxt = ps.next_after(a)
    assert nxt is not None
    assert nxt.endpoint.host == "b"
    # Single peer — next_after returns None.
    ps_one = PeerSet.new(_eps("https://only:8443"))
    assert ps_one.next_after(ps_one.primary()) is None


def test_mark_failure_transitions():
    ps = PeerSet.new(_eps("https://a:8443", "https://b:8443"))
    # Two soft failures → DEGRADED.
    ps.mark_failure("https://a:8443", PeerErrorClass.NETWORK)
    ps.mark_failure("https://a:8443", PeerErrorClass.SERVER_5XX)
    a = ps.find_by_key("https://a:8443")
    assert a is not None
    assert a.state is PeerState.DEGRADED

    # Third → UNHEALTHY.
    ps.mark_failure("https://a:8443", PeerErrorClass.NETWORK)
    assert ps.find_by_key("https://a:8443").state is PeerState.UNHEALTHY  # type: ignore[union-attr]

    # Success resets to HEALTHY.
    ps.mark_success("https://a:8443", latency_s=0.01)
    assert ps.find_by_key("https://a:8443").state is PeerState.HEALTHY  # type: ignore[union-attr]
    assert ps.find_by_key("https://a:8443").consecutive_failures == 0  # type: ignore[union-attr]


def test_503_is_immediate_unhealthy():
    ps = PeerSet.new(_eps("https://a:8443", "https://b:8443"))
    ps.mark_failure("https://a:8443", PeerErrorClass.SERVICE_UNAVAILABLE)
    a = ps.find_by_key("https://a:8443")
    assert a is not None
    assert a.state is PeerState.UNHEALTHY


def test_pick_falls_back_to_unhealthy_when_all_down():
    ps = PeerSet.new(_eps("https://a:8443", "https://b:8443"))
    for url in ("https://a:8443", "https://b:8443"):
        ps.mark_failure(url, PeerErrorClass.SERVICE_UNAVAILABLE)
    # No healthy peer — picker still returns something.
    picked = ps.pick()
    assert picked.state is PeerState.UNHEALTHY


def test_sort_key_uses_latency_ema_when_present():
    ps = PeerSet.new(_eps("https://a:8443", "https://b:8443"))
    ps.mark_success("https://a:8443", latency_s=0.100)
    ps.mark_success("https://b:8443", latency_s=0.005)
    picked = ps.pick()
    assert picked.endpoint.host == "b"


def test_snapshot_is_defensive_copy():
    ps = PeerSet.new(_eps("https://a:8443", "https://b:8443"))
    snap = ps.snapshot()
    assert len(snap) == 2
    # Mutating snapshot element doesn't change internal state.
    snap[0].state = PeerState.UNHEALTHY
    assert ps.find_by_key("https://a:8443").state is PeerState.HEALTHY  # type: ignore[union-attr]
