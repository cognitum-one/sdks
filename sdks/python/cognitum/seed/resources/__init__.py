"""Resource namespaces surfaced on :class:`SeedClient`.

Each resource is a thin object that takes the shared transport client and
exposes one method per endpoint (sync) or async method (async).
"""

from __future__ import annotations

from cognitum.seed.resources.custody import AsyncCustodyResource, CustodyResource
from cognitum.seed.resources.ota import AsyncOtaResource, OtaResource
from cognitum.seed.resources.pair import AsyncPairResource, PairResource
from cognitum.seed.resources.store import AsyncStoreResource, StoreResource
from cognitum.seed.resources.witness import AsyncWitnessResource, WitnessResource

__all__ = [
    "AsyncCustodyResource",
    "AsyncOtaResource",
    "AsyncPairResource",
    "AsyncStoreResource",
    "AsyncWitnessResource",
    "CustodyResource",
    "OtaResource",
    "PairResource",
    "StoreResource",
    "WitnessResource",
]
