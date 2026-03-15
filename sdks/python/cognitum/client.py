"""Synchronous Cognitum client."""

from __future__ import annotations

from types import TracebackType
from typing import Any

from cognitum._http import SyncHttpClient
from cognitum.brain import BrainResource
from cognitum.catalog import CatalogResource
from cognitum.contact import ContactResource
from cognitum.devices import DevicesResource
from cognitum.leads import LeadsResource
from cognitum.mcp import McpResource
from cognitum.orders import OrdersResource
from cognitum.types import HealthResponse

_DEFAULT_BASE_URL = "https://api.cognitum.one"


class Cognitum:
    """Synchronous client for the Cognitum API.

    Usage::

        with Cognitum(api_key="sk-...") as client:
            products = client.catalog.browse()
            print(products)
    """

    catalog: CatalogResource
    orders: OrdersResource
    leads: LeadsResource
    contact: ContactResource
    devices: DevicesResource
    mcp: McpResource
    brain: BrainResource

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str | None = None,
        timeout: float = 30.0,
        max_retries: int = 3,
    ) -> None:
        self._http = SyncHttpClient(
            base_url=base_url or _DEFAULT_BASE_URL,
            api_key=api_key,
            timeout=timeout,
            max_retries=max_retries,
        )
        self.catalog = CatalogResource(self._http)
        self.orders = OrdersResource(self._http)
        self.leads = LeadsResource(self._http)
        self.contact = ContactResource(self._http)
        self.devices = DevicesResource(self._http)
        self.mcp = McpResource(self._http)
        self.brain = BrainResource(self._http)

    def health(self) -> HealthResponse:
        """Check API health status."""
        data: dict[str, Any] = self._http.get("/health")
        return HealthResponse(
            status=data.get("status", "ok"),
            version=data.get("version"),
            timestamp=data.get("timestamp"),
        )

    def close(self) -> None:
        """Close the underlying HTTP transport."""
        self._http.close()

    def __enter__(self) -> Cognitum:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        self.close()
