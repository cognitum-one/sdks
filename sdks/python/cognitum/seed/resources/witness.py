"""Witness resource — ``/api/v1/witness/*``."""

from __future__ import annotations

from cognitum.seed._models import WitnessChain


class WitnessResource:
    def __init__(self, http: object) -> None:
        self._http = http

    def chain(self) -> WitnessChain:
        data = self._http.request("GET", "/api/v1/witness/chain")  # type: ignore[attr-defined]
        return WitnessChain.from_wire(data or {})


class AsyncWitnessResource:
    def __init__(self, http: object) -> None:
        self._http = http

    async def chain(self) -> WitnessChain:
        data = await self._http.request("GET", "/api/v1/witness/chain")  # type: ignore[attr-defined]
        return WitnessChain.from_wire(data or {})
