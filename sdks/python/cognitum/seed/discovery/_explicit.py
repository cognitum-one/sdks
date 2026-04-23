"""Explicit-list :class:`DiscoveryProvider` (ADR-0016a §D6).

Wraps a ``str`` or ``list[str]`` so the client's internal plumbing can
treat all input shapes uniformly. Callers who pass a bare string or
list continue to work unchanged — the client constructs this wrapper
internally. Third-party callers may construct it directly for
composition (e.g. a fallback chain: try mDNS, then explicit list).
"""

from __future__ import annotations

from typing import Sequence

from cognitum._errors import ConfigError
from cognitum.seed.discovery._types import DiscoveredPeer


class ExplicitDiscovery:
    """A :class:`DiscoveryProvider` that returns a fixed peer list."""

    __slots__ = ("_peers",)

    def __init__(self, endpoints: str | Sequence[str]) -> None:
        if isinstance(endpoints, str):
            raw: list[str] = [endpoints]
        elif isinstance(endpoints, (list, tuple)):
            raw = list(endpoints)
        else:
            raise ConfigError(
                "endpoints must be str or list[str]", field="endpoints"
            )
        if not raw:
            raise ConfigError("endpoints must not be empty", field="endpoints")
        self._peers: tuple[DiscoveredPeer, ...] = tuple(
            DiscoveredPeer(url=u) for u in raw
        )

    def discover(self) -> list[DiscoveredPeer]:
        return list(self._peers)

    async def adiscover(self) -> list[DiscoveredPeer]:
        return list(self._peers)

    def close(self) -> None:  # pragma: no cover — nothing to release
        return None


__all__ = ["ExplicitDiscovery"]
