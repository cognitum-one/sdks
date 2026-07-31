"""Capability negotiation (ADR-0019 §D6).

Type-only scaffolding (issue #52 / M1) -- no runtime capability discovery
or static compatibility tables ship in this pass.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

#: Where a :class:`CapabilitySet` came from.
CapabilitySource = Literal["server", "static-compatibility-table"]


@dataclass(frozen=True)
class CapabilitySet:
    """Runtime-advertised, versioned support for a named behavior.

    Unknown product versions MUST receive the intersection of proven-safe
    capabilities, never the union (ADR-0019 §D6).
    """

    product: str
    product_version: str
    protocol: str
    protocol_version: str
    source: CapabilitySource
    features: dict[str, bool] = field(default_factory=dict)
    limitations: list[str] = field(default_factory=list)
    auth_methods: list[str] = field(default_factory=list)


__all__ = ["CapabilitySource", "CapabilitySet"]
