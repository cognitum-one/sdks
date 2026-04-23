"""Custody resource — ``/api/v1/custody/*``."""

from __future__ import annotations

from cognitum.seed._call_options import CallOptions
from cognitum.seed._models import Epoch


class CustodyResource:
    def __init__(self, http: object) -> None:
        self._http = http

    def epoch(self, *, options: CallOptions | None = None) -> Epoch:
        data = self._http.request(  # type: ignore[attr-defined]
            "GET", "/api/v1/custody/epoch", options=options,
        )
        return Epoch.from_wire(data or {})


class AsyncCustodyResource:
    def __init__(self, http: object) -> None:
        self._http = http

    async def epoch(
        self, *, options: CallOptions | None = None
    ) -> Epoch:
        data = await self._http.request(  # type: ignore[attr-defined]
            "GET", "/api/v1/custody/epoch", options=options,
        )
        return Epoch.from_wire(data or {})
