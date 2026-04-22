"""Vector-store resource — ``/api/v1/store/*``."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Literal

from cognitum._errors import ValidationError
from cognitum.seed._models import (
    StoreIngestRequest,
    StoreQueryResult,
    StoreStatus,
    VectorUpsert,
)


def _build_query_payload(
    vector: Sequence[float],
    k: int,
    metric: str,
    filter: dict[str, Any] | None,
) -> dict[str, Any]:
    if k <= 0:
        raise ValidationError("k must be >= 1", field="k")
    if not vector:
        raise ValidationError("vector must not be empty", field="vector")
    payload: dict[str, Any] = {
        "vector": list(vector),
        "k": int(k),
        "metric": metric,
    }
    if filter is not None:
        payload["filter"] = filter
    return payload


class StoreResource:
    def __init__(self, http: object) -> None:
        self._http = http

    def status(self) -> StoreStatus:
        data = self._http.request("GET", "/api/v1/store/status")  # type: ignore[attr-defined]
        return StoreStatus.from_wire(data or {})

    def query(
        self,
        *,
        vector: Sequence[float],
        k: int = 10,
        metric: Literal["cosine", "euclidean", "dot"] = "cosine",
        filter: dict[str, Any] | None = None,
    ) -> StoreQueryResult:
        payload = _build_query_payload(vector, k, metric, filter)
        data = self._http.request(  # type: ignore[attr-defined]
            "POST", "/api/v1/store/query", json=payload, idempotent=True,
        )
        return StoreQueryResult.from_wire(data or {})

    def ingest(
        self, *, vectors: Sequence[VectorUpsert | dict[str, Any]]
    ) -> dict[str, Any]:
        req = StoreIngestRequest.from_any(list(vectors))
        data = self._http.request(  # type: ignore[attr-defined]
            "POST", "/api/v1/store/ingest", json=req.to_wire(),
        )
        return data or {}


class AsyncStoreResource:
    def __init__(self, http: object) -> None:
        self._http = http

    async def status(self) -> StoreStatus:
        data = await self._http.request("GET", "/api/v1/store/status")  # type: ignore[attr-defined]
        return StoreStatus.from_wire(data or {})

    async def query(
        self,
        *,
        vector: Sequence[float],
        k: int = 10,
        metric: Literal["cosine", "euclidean", "dot"] = "cosine",
        filter: dict[str, Any] | None = None,
    ) -> StoreQueryResult:
        payload = _build_query_payload(vector, k, metric, filter)
        data = await self._http.request(  # type: ignore[attr-defined]
            "POST", "/api/v1/store/query", json=payload, idempotent=True,
        )
        return StoreQueryResult.from_wire(data or {})

    async def ingest(
        self, *, vectors: Sequence[VectorUpsert | dict[str, Any]]
    ) -> dict[str, Any]:
        req = StoreIngestRequest.from_any(list(vectors))
        data = await self._http.request(  # type: ignore[attr-defined]
            "POST", "/api/v1/store/ingest", json=req.to_wire(),
        )
        return data or {}
