"""Peer discovery providers (ADR-0016a §D6).

Public surface::

    from cognitum.seed.discovery import (
        DiscoveryProvider,
        DiscoveredPeer,
        ExplicitDiscovery,
        MdnsDiscovery,  # requires the `mdns` extra
    )

:class:`MdnsDiscovery` is a lazy re-export — importing the name itself
triggers the ``zeroconf`` import. Callers who do not want the extra
should import :class:`ExplicitDiscovery` or the Protocol/dataclass
directly, none of which pull in ``zeroconf``.
"""

from __future__ import annotations

from cognitum.seed.discovery._explicit import ExplicitDiscovery
from cognitum.seed.discovery._types import DiscoveredPeer, DiscoveryProvider
from cognitum.seed.discovery.tailscale import TailscaleDiscovery


def __getattr__(name: str) -> object:
    """Lazy re-export for :class:`MdnsDiscovery`.

    Mirrors :pep:`562` — the submodule import is only triggered when the
    attribute is actually accessed, so ``from cognitum.seed.discovery
    import ExplicitDiscovery`` works without the ``mdns`` extra.
    """

    if name == "MdnsDiscovery":
        from cognitum.seed.discovery.mdns import MdnsDiscovery

        return MdnsDiscovery
    raise AttributeError(f"module 'cognitum.seed.discovery' has no attribute {name!r}")


__all__ = [
    "DiscoveredPeer",
    "DiscoveryProvider",
    "ExplicitDiscovery",
    "MdnsDiscovery",
    "TailscaleDiscovery",
]
