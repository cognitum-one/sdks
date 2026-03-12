"""Leads resource for newsletter / waitlist subscriptions."""

from __future__ import annotations

from typing import Any

from cognitum._http import AsyncHttpClient, SyncHttpClient


class LeadsResource:
    """Synchronous leads resource."""

    def __init__(self, http: SyncHttpClient) -> None:
        self._http = http

    def subscribe(self, email: str, *, product: str | None = None) -> dict[str, Any]:
        """Subscribe an email to the notify / waitlist list."""
        payload: dict[str, Any] = {"email": email}
        if product is not None:
            payload["product"] = product
        return self._http.post("/saveNotifyLead", json=payload)


class AsyncLeadsResource:
    """Asynchronous leads resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def subscribe(
        self, email: str, *, product: str | None = None
    ) -> dict[str, Any]:
        """Subscribe an email to the notify / waitlist list."""
        payload: dict[str, Any] = {"email": email}
        if product is not None:
            payload["product"] = product
        return await self._http.post("/saveNotifyLead", json=payload)
