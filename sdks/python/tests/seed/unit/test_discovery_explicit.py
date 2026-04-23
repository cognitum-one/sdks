"""Unit tests for :class:`ExplicitDiscovery` (ADR-0016a §D6, D1 compliance)."""

from __future__ import annotations

import asyncio

import pytest

from cognitum._errors import ConfigError
from cognitum.seed import ExplicitDiscovery


def test_explicit_discovery_returns_configured_list() -> None:
    provider = ExplicitDiscovery(["https://a:8443", "https://b:8443"])
    peers = provider.discover()
    assert [p.url for p in peers] == ["https://a:8443", "https://b:8443"]
    # Second call returns the same list — providers are pure.
    assert provider.discover() == peers
    # Async path mirrors sync path.
    async_peers = asyncio.run(provider.adiscover())
    assert async_peers == peers


def test_explicit_discovery_rejects_empty_and_bad_input() -> None:
    with pytest.raises(ConfigError):
        ExplicitDiscovery([])
    with pytest.raises(ConfigError):
        ExplicitDiscovery(123)  # type: ignore[arg-type]
    # Single-string shorthand works (mirrors SeedClient constructor).
    single = ExplicitDiscovery("https://a:8443")
    assert [p.url for p in single.discover()] == ["https://a:8443"]
