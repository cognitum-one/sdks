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
        return cls(**kwargs)  # type: ignore[arg-type]


from cognitum.seed._models.custody import Epoch
from cognitum.seed._models.identity import Identity
from cognitum.seed._models.ota import OtaCheckNowResponse, OtaConfig
from cognitum.seed._models.pair import PairCreateResponse, PairStatus
from cognitum.seed._models.status import Status
from cognitum.seed._models.store import (
    QueryMatch,
    StoreIngestRequest,
    StoreQueryResult,
    StoreStatus,
    VectorUpsert,
)
from cognitum.seed._models.witness import WitnessChain

__all__ = [
    "Epoch",
    "Identity",
    "OtaCheckNowResponse",
    "OtaConfig",
    "PairCreateResponse",
    "PairStatus",
    "QueryMatch",
    "Status",
    "StoreIngestRequest",
    "StoreQueryResult",
    "StoreStatus",
    "VectorUpsert",
    "WireModel",
    "WitnessChain",
]
