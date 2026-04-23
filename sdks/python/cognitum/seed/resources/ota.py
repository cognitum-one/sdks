"""OTA resource — ``/api/v1/ota/*``."""

from __future__ import annotations

from cognitum.seed._call_options import CallOptions
from cognitum.seed._models import OtaCheckNowResponse, OtaConfig


class OtaResource:
    def __init__(self, http: object) -> None:
        self._http = http

    def config(self, *, options: CallOptions | None = None) -> OtaConfig:
        data = self._http.request(  # type: ignore[attr-defined]
            "GET", "/api/v1/ota/config", options=options,
        )
        return OtaConfig.from_wire(data or {})

    def check_now(
        self, *, options: CallOptions | None = None
    ) -> OtaCheckNowResponse:
        data = self._http.request(  # type: ignore[attr-defined]
            "POST", "/api/v1/ota/check-now", json={}, options=options,
        )
        return OtaCheckNowResponse.from_wire(data or {})


class AsyncOtaResource:
    def __init__(self, http: object) -> None:
        self._http = http

    async def config(
        self, *, options: CallOptions | None = None
    ) -> OtaConfig:
        data = await self._http.request(  # type: ignore[attr-defined]
            "GET", "/api/v1/ota/config", options=options,
        )
        return OtaConfig.from_wire(data or {})

    async def check_now(
        self, *, options: CallOptions | None = None
    ) -> OtaCheckNowResponse:
        data = await self._http.request(  # type: ignore[attr-defined]
            "POST", "/api/v1/ota/check-now", json={}, options=options,
        )
        return OtaCheckNowResponse.from_wire(data or {})
