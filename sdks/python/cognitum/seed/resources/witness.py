"""Witness resource — ``/api/v1/witness/*``."""

from __future__ import annotations

from cognitum.seed._call_options import CallOptions
from cognitum.seed._models import WitnessChain


class WitnessResource:
    def __init__(self, http: object) -> None:
        self._http = http

    def chain(
        self, *, options: CallOptions | None = None
    ) -> WitnessChain:
        data = self._http.request(  # type: ignore[attr-defined]
            "GET", "/api/v1/witness/chain", options=options,
        )
        return WitnessChain.from_wire(data or {})


class AsyncWitnessResource:
    def __init__(self, http: object) -> None:
        self._http = http

    async def chain(
        self, *, options: CallOptions | None = None
    ) -> WitnessChain:
        data = await self._http.request(  # type: ignore[attr-defined]
            "GET", "/api/v1/witness/chain", options=options,
        )
        return WitnessChain.from_wire(data or {})
