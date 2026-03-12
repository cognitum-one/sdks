"""Devices resource for OTA device management."""

from __future__ import annotations

from typing import Any

from cognitum._http import AsyncHttpClient, SyncHttpClient
from cognitum.types import Device


def _parse_device(data: Any) -> Device:
    return Device(
        device_id=data.get("device_id", data.get("deviceId", "")),
        public_key=data.get("public_key") or data.get("publicKey"),
        firmware_version=data.get("firmware_version") or data.get("firmwareVersion"),
        last_seen=data.get("last_seen") or data.get("lastSeen"),
        status=data.get("status", "active"),
        metadata=data.get("metadata", {}),
    )


class DevicesResource:
    """Synchronous devices resource."""

    def __init__(self, http: SyncHttpClient) -> None:
        self._http = http

    def register(
        self,
        public_key: str,
        *,
        firmware_version: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> Device:
        """Register a new device with its Ed25519 public key."""
        payload: dict[str, Any] = {"publicKey": public_key}
        if firmware_version is not None:
            payload["firmwareVersion"] = firmware_version
        if metadata is not None:
            payload["metadata"] = metadata
        data = self._http.post("/seedRegisterDevice", json=payload)
        return _parse_device(data)

    def check_update(
        self, device_id: str, *, current_version: str | None = None
    ) -> dict[str, Any]:
        """Check whether a firmware update is available."""
        params: dict[str, Any] = {"deviceId": device_id}
        if current_version is not None:
            params["currentVersion"] = current_version
        return self._http.get("/seedCheckUpdate", params=params)

    def heartbeat(self, device_id: str) -> dict[str, Any]:
        """Send a device heartbeat."""
        return self._http.post("/seedHeartbeat", json={"deviceId": device_id})


class AsyncDevicesResource:
    """Asynchronous devices resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def register(
        self,
        public_key: str,
        *,
        firmware_version: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> Device:
        """Register a new device with its Ed25519 public key."""
        payload: dict[str, Any] = {"publicKey": public_key}
        if firmware_version is not None:
            payload["firmwareVersion"] = firmware_version
        if metadata is not None:
            payload["metadata"] = metadata
        data = await self._http.post("/seedRegisterDevice", json=payload)
        return _parse_device(data)

    async def check_update(
        self, device_id: str, *, current_version: str | None = None
    ) -> dict[str, Any]:
        """Check whether a firmware update is available."""
        params: dict[str, Any] = {"deviceId": device_id}
        if current_version is not None:
            params["currentVersion"] = current_version
        return await self._http.get("/seedCheckUpdate", params=params)

    async def heartbeat(self, device_id: str) -> dict[str, Any]:
        """Send a device heartbeat."""
        return await self._http.post(
            "/seedHeartbeat", json={"deviceId": device_id}
        )
