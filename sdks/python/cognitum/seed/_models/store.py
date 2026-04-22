"""Vector-store wire models (`/api/v1/store/*`)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any


def _split_known(data: Mapping[str, Any], known: set[str]) -> tuple[dict, dict]:
    kwargs: dict[str, Any] = {}
    extra: dict[str, Any] = {}
    for k, v in data.items():
        (kwargs if k in known else extra)[k] = v
    return kwargs, extra


@dataclass(slots=True, frozen=True)
class StoreStatus:
    total_vectors: int = 0
    deleted_vectors: int = 0
    dimension: int = 0
    file_size_bytes: int = 0
    epoch: int = 0
    extra: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> "StoreStatus":
        kwargs, extra = _split_known(
            data,
            {
                "total_vectors",
                "deleted_vectors",
                "dimension",
                "file_size_bytes",
                "epoch",
            },
        )
        return cls(**kwargs, extra=extra)


@dataclass(slots=True, frozen=True)
class QueryMatch:
    id: int | str = 0
    distance: float = 0.0
    metadata: Mapping[str, Any] = field(default_factory=dict)
    extra: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> "QueryMatch":
        kwargs, extra = _split_known(data, {"id", "distance", "metadata"})
        meta = kwargs.pop("metadata", None) or {}
        return cls(metadata=meta, extra=extra, **kwargs)


@dataclass(slots=True, frozen=True)
class StoreQueryResult:
    matches: tuple[QueryMatch, ...] = ()
    query_ms: float = 0.0
    extra: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> "StoreQueryResult":
        # seed may use "results" OR "matches" depending on version.
        raw = data.get("results") or data.get("matches") or []
        matches = tuple(
            QueryMatch.from_wire(m) if isinstance(m, Mapping) else QueryMatch()
            for m in raw
        )
        extra = {
            k: v for k, v in data.items() if k not in ("results", "matches", "query_ms")
        }
        query_ms = float(data.get("query_ms", 0.0) or 0.0)
        return cls(matches=matches, query_ms=query_ms, extra=extra)


@dataclass(slots=True, frozen=True)
class VectorUpsert:
    """Write-side model: strict (no ``extra``)."""

    id: str
    values: tuple[float, ...]
    metadata: Mapping[str, Any] | None = None

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id, "values": list(self.values)}
        if self.metadata is not None:
            out["metadata"] = dict(self.metadata)
        return out


@dataclass(slots=True, frozen=True)
class StoreIngestRequest:
    vectors: tuple[VectorUpsert, ...]

    def to_wire(self) -> dict[str, Any]:
        return {"vectors": [v.to_wire() for v in self.vectors]}

    @classmethod
    def from_any(cls, items: Sequence[Any]) -> "StoreIngestRequest":
        out: list[VectorUpsert] = []
        for it in items:
            if isinstance(it, VectorUpsert):
                out.append(it)
            elif isinstance(it, Mapping):
                out.append(
                    VectorUpsert(
                        id=str(it["id"]),
                        values=tuple(float(x) for x in it["values"]),
                        metadata=it.get("metadata"),
                    )
                )
            else:  # pragma: no cover — validation surface
                raise TypeError(
                    f"vectors must be VectorUpsert or mapping, got {type(it).__name__}"
                )
        return cls(vectors=tuple(out))
