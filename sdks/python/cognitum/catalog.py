"""Catalog resource for browsing products."""

from __future__ import annotations

from typing import Any

from cognitum._http import AsyncHttpClient, SyncHttpClient
from cognitum.types import CatalogResponse, Product


def _parse_catalog(data: Any) -> CatalogResponse:
    raw_products = data.get("products", data.get("templates", []))
    products = [
        Product(
            id=p.get("id", ""),
            name=p.get("name", ""),
            description=p.get("description", ""),
            category=p.get("category"),
            price_cents=p.get("price_cents") or p.get("priceCents"),
            currency=p.get("currency", "usd"),
            metadata=p.get("metadata", {}),
        )
        for p in raw_products
    ]
    return CatalogResponse(
        products=products,
        total=data.get("total", len(products)),
    )


class CatalogResource:
    """Synchronous catalog resource."""

    def __init__(self, http: SyncHttpClient) -> None:
        self._http = http

    def browse(self, *, category: str | None = None) -> CatalogResponse:
        """Browse the product catalog, optionally filtered by category."""
        params: dict[str, Any] = {}
        if category is not None:
            params["category"] = category
        data = self._http.get("/listTemplates", params=params or None)
        return _parse_catalog(data)


class AsyncCatalogResource:
    """Asynchronous catalog resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def browse(self, *, category: str | None = None) -> CatalogResponse:
        """Browse the product catalog, optionally filtered by category."""
        params: dict[str, Any] = {}
        if category is not None:
            params["category"] = category
        data = await self._http.get("/listTemplates", params=params or None)
        return _parse_catalog(data)
