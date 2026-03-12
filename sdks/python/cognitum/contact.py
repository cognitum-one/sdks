"""Contact resource for sending messages to the Cognitum team."""

from __future__ import annotations

from typing import Any

from cognitum._http import AsyncHttpClient, SyncHttpClient


class ContactResource:
    """Synchronous contact resource."""

    def __init__(self, http: SyncHttpClient) -> None:
        self._http = http

    def send(
        self,
        name: str,
        email: str,
        message: str,
        *,
        inquiry_type: str | None = None,
    ) -> dict[str, Any]:
        """Send a contact message."""
        payload: dict[str, Any] = {
            "name": name,
            "email": email,
            "message": message,
        }
        if inquiry_type is not None:
            payload["inquiryType"] = inquiry_type
        return self._http.post("/sendContactEmail", json=payload)


class AsyncContactResource:
    """Asynchronous contact resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def send(
        self,
        name: str,
        email: str,
        message: str,
        *,
        inquiry_type: str | None = None,
    ) -> dict[str, Any]:
        """Send a contact message."""
        payload: dict[str, Any] = {
            "name": name,
            "email": email,
            "message": message,
        }
        if inquiry_type is not None:
            payload["inquiryType"] = inquiry_type
        return await self._http.post("/sendContactEmail", json=payload)
