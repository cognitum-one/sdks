"""Asynchronous Cognitum client."""

from __future__ import annotations

from types import TracebackType
from typing import Any

from cognitum._http import AsyncHttpClient
from cognitum.brain import AsyncBrainResource
from cognitum.catalog import AsyncCatalogResource
from cognitum.contact import AsyncContactResource
from cognitum.devices import AsyncDevicesResource
from cognitum.leads import AsyncLeadsResource
from cognitum.mcp import AsyncMcpResource
from cognitum.orders import AsyncOrdersResource
from cognitum.types import HealthResponse

_DEFAULT_BASE_URL = "https://us-central1-cognitum-20260110.cloudfunctions.net"


class AsyncCognitum:
    """Asynchronous client for the Cognitum API.

    Usage::

        async with AsyncCognitum(api_key="sk-...") as client:
            products = await client.catalog.browse()
            print(products)
    """

    catalog: AsyncCatalogResource
    orders: AsyncOrdersResource
    leads: AsyncLeadsResource
    contact: AsyncContactResource
    devices: AsyncDevicesResource
    mcp: AsyncMcpResource
    brain: AsyncBrainResource

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str | None = None,
        timeout: float = 30.0,
        max_retries: int = 3,
    ) -> None:
        self._http = AsyncHttpClient(
            base_url=base_url or _DEFAULT_BASE_URL,
            api_key=api_key,
            timeout=timeout,
            max_retries=max_retries,
        )
        self.catalog = AsyncCatalogResource(self._http)
        self.orders = AsyncOrdersResource(self._http)
        self.leads = AsyncLeadsResource(self._http)
        self.contact = AsyncContactResource(self._http)
        self.devices = AsyncDevicesResource(self._http)
        self.mcp = AsyncMcpResource(self._http)
        self.brain = AsyncBrainResource(self._http)

    async def health(self) -> HealthResponse:
        """Check API health status."""
        data: dict[str, Any] = await self._http.get("/health")
        return HealthResponse(
            status=data.get("status", "ok"),
            version=data.get("version"),
            timestamp=data.get("timestamp"),
        )

    async def close(self) -> None:
        """Close the underlying HTTP transport."""
        await self._http.close()

    async def __aenter__(self) -> AsyncCognitum:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        await self.close()
