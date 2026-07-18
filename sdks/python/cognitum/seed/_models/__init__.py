"""Typed wire models for seed responses.

Every read-side model is ``@dataclass(slots=True, frozen=True)`` with an
``extra`` dict to absorb unknown fields (ADR-0006 §Unknown-field).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import MISSING, dataclass, fields
from typing import Any, ClassVar, TypeVar

T = TypeVar("T", bound="WireModel")


@dataclass(slots=True, frozen=True)
class WireModel:
    """Base class: ``from_wire`` routes unknown keys to ``extra``.

    Per-model dataclasses may ignore this base and implement their own
    ``from_wire`` classmethod. It is kept for callers who want to introspect
    the taxonomy.
    """

    _strict_write: ClassVar[bool] = True

    @classmethod
    def from_wire(cls: type[T], data: Mapping[str, Any]) -> T:
        known = {f.name for f in fields(cls)} - {"extra"}
        kwargs: dict[str, Any] = {}
        extra: dict[str, Any] = {}
        for k, v in data.items():
            if k in known:
                kwargs[k] = v
            else:
                extra[k] = v
        has_extra = any(f.name == "extra" for f in fields(cls))
        if has_extra:
            kwargs["extra"] = extra
        for f in fields(cls):
            if f.name not in kwargs and f.default is not MISSING:
                kwargs[f.name] = f.default
        return cls(**kwargs)


# These imports must come after `WireModel` above: each submodule's
# dataclasses subclass it via `from cognitum.seed._models import WireModel`,
# so importing them before the class body finishes executing would be a
# circular import.
from cognitum.seed._models.custody import Epoch  # noqa: E402
from cognitum.seed._models.identity import Identity  # noqa: E402
from cognitum.seed._models.mesh import (  # noqa: E402
    ClusterHealth,
    MeshPeer,
    MeshPeers,
    MeshStatus,
    SwarmStatus,
)
from cognitum.seed._models.ota import OtaCheckNowResponse, OtaConfig  # noqa: E402
from cognitum.seed._models.pair import PairCreateResponse, PairStatus  # noqa: E402
from cognitum.seed._models.status import Status  # noqa: E402
from cognitum.seed._models.store import (  # noqa: E402
    QueryMatch,
    StoreIngestRequest,
    StoreQueryResult,
    StoreStatus,
    VectorUpsert,
)
from cognitum.seed._models.witness import WitnessChain  # noqa: E402

__all__ = [
    "ClusterHealth",
    "Epoch",
    "Identity",
    "MeshPeer",
    "MeshPeers",
    "MeshStatus",
    "OtaCheckNowResponse",
    "OtaConfig",
    "PairCreateResponse",
    "PairStatus",
    "QueryMatch",
    "Status",
    "StoreIngestRequest",
    "StoreQueryResult",
    "StoreStatus",
    "SwarmStatus",
    "VectorUpsert",
    "WireModel",
    "WitnessChain",
]
