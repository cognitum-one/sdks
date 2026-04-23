"""Discovery Protocol + :class:`DiscoveredPeer` dataclass (ADR-0016a §D6).

A :class:`DiscoveryProvider` returns a snapshot list of
:class:`DiscoveredPeer` values which the client normalises into the
configured ``Endpoint`` list. Implementations ship in this package
(``ExplicitDiscovery``, ``MdnsDiscovery``) and third-party code may
implement this Protocol directly — it is a stable public interface per
ADR-0016a §D6.

Sync and async callers each have their own entry point; a provider may
implement one or both. The client uses ``adiscover`` when available from
an async context, otherwise falls back to ``discover``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass(slots=True, frozen=True)
class DiscoveredPeer:
    """One peer returned by a :class:`DiscoveryProvider`.

    ``url`` is the only required field; ``device_id`` / ``latency_ms``
    are optional metadata surfaced by providers that know them (mDNS TXT
    records carry ``device_id``; measured providers may populate
    ``latency_ms``). Consumers MUST NOT rely on these being set.
    """

    url: str
    device_id: str | None = None
    latency_ms: float | None = None


@runtime_checkable
class DiscoveryProvider(Protocol):
    """Pluggable peer discovery (ADR-0016a §D6).

    Implementations return an ordered list of discovered peers at each
    call; the client treats the result as the authoritative peer list
    for this resolution pass. Order matters — the first returned peer
    is used as the initial closest-first pick before latency EMAs build.

    ``close()`` releases any background resources (e.g. mDNS browser
    threads). Implementations MUST be idempotent on repeat ``close()``.
    """

    def discover(self) -> list[DiscoveredPeer]: ...

    async def adiscover(self) -> list[DiscoveredPeer]: ...

    def close(self) -> None: ...


__all__ = ["DiscoveredPeer", "DiscoveryProvider"]
