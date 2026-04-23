"""Unit tests for :mod:`cognitum.seed.discovery._types` (ADR-0016a §D6)."""

from __future__ import annotations

import pytest

from cognitum.seed import DiscoveredPeer, DiscoveryProvider


def test_discovered_peer_is_frozen_dataclass() -> None:
    peer = DiscoveredPeer(url="https://a:8443")
    assert peer.url == "https://a:8443"
    assert peer.device_id is None
    assert peer.latency_ms is None
    # Slots + frozen: mutating a field raises.
    with pytest.raises((AttributeError, TypeError)):
        peer.url = "https://b:8443"  # type: ignore[misc]
    # Optional metadata round-trips.
    rich = DiscoveredPeer(
        url="https://b:8443", device_id="dev-123", latency_ms=4.2,
    )
    assert rich.device_id == "dev-123"
    assert rich.latency_ms == pytest.approx(4.2)


def test_discovery_provider_is_a_structural_protocol() -> None:
    """Any object with ``discover`` / ``adiscover`` / ``close`` matches
    the Protocol — this is what makes the ``endpoints=`` union work."""

    class _Custom:
        def discover(self) -> list[DiscoveredPeer]:
            return [DiscoveredPeer(url="https://a:8443")]

        async def adiscover(self) -> list[DiscoveredPeer]:
            return [DiscoveredPeer(url="https://a:8443")]

        def close(self) -> None:
            return None

    obj = _Custom()
    assert isinstance(obj, DiscoveryProvider)
    # Instance missing a method is NOT a provider.
    class _Partial:
        def discover(self) -> list[DiscoveredPeer]:
            return []

    assert not isinstance(_Partial(), DiscoveryProvider)
