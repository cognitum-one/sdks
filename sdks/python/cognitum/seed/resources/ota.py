"""OTA resource — ``/api/v1/ota/*``."""

from __future__ import annotations

from cognitum.seed._models import OtaCheckNowResponse, OtaConfig


class OtaResource:
    def __init__(self, http: object) -> None:
        self._http = http

    def config(self) -> OtaConfig:
        data = self._http.request("GET", "/api/v1/ota/config")  # type: ignore[attr-defined]
        return OtaConfig.from_wire(data or {})

    def check_now(self) -> OtaCheckNowResponse:
        data = self._http.request("POST", "/api/v1/ota/check-now", json={})  # type: ignore[attr-defined]
        return OtaCheckNowResponse.from_wire(data or {})


class AsyncOtaResource:
    def __init__(self, http: object) -> None:
        self._http = http

    async def config(self) -> OtaConfig:
        data = await self._http.request("GET", "/api/v1/ota/config")  # type: ignore[attr-defined]
        return OtaConfig.from_wire(data or {})

    async def check_now(self) -> OtaCheckNowResponse:
        data = await self._http.request(  # type: ignore[attr-defined]
            "POST", "/api/v1/ota/check-now", json={},
        )
        return OtaCheckNowResponse.from_wire(data or {})
