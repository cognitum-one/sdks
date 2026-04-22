"""Pairing resource — ``/api/v1/pair*``."""

from __future__ import annotations

from urllib.parse import quote

from cognitum.seed._models import PairCreateResponse, PairStatus


class PairResource:
    def __init__(self, http: object) -> None:
        self._http = http

    def status(self) -> PairStatus:
        data = self._http.request("GET", "/api/v1/pair/status")  # type: ignore[attr-defined]
        return PairStatus.from_wire(data or {})

    def create(self, *, client_name: str) -> PairCreateResponse:
        data = self._http.request(  # type: ignore[attr-defined]
            "POST",
            "/api/v1/pair",
            json={"client_name": client_name},
        )
        return PairCreateResponse.from_wire(data or {})

    def delete(self, client_name: str) -> None:
        self._http.request("DELETE", f"/api/v1/pair/{quote(client_name)}")  # type: ignore[attr-defined]


class AsyncPairResource:
    def __init__(self, http: object) -> None:
        self._http = http

    async def status(self) -> PairStatus:
        data = await self._http.request("GET", "/api/v1/pair/status")  # type: ignore[attr-defined]
        return PairStatus.from_wire(data or {})

    async def create(self, *, client_name: str) -> PairCreateResponse:
        data = await self._http.request(  # type: ignore[attr-defined]
            "POST",
            "/api/v1/pair",
            json={"client_name": client_name},
        )
        return PairCreateResponse.from_wire(data or {})

    async def delete(self, client_name: str) -> None:
        await self._http.request(  # type: ignore[attr-defined]
            "DELETE", f"/api/v1/pair/{quote(client_name)}"
        )
