"""Custody resource — ``/api/v1/custody/*``."""

from __future__ import annotations

from cognitum.seed._models import Epoch


class CustodyResource:
    def __init__(self, http: object) -> None:
        self._http = http

    def epoch(self) -> Epoch:
        data = self._http.request("GET", "/api/v1/custody/epoch")  # type: ignore[attr-defined]
        return Epoch.from_wire(data or {})


class AsyncCustodyResource:
    def __init__(self, http: object) -> None:
        self._http = http

    async def epoch(self) -> Epoch:
        data = await self._http.request("GET", "/api/v1/custody/epoch")  # type: ignore[attr-defined]
        return Epoch.from_wire(data or {})
