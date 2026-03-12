"""Orders resource for creating and querying orders."""

from __future__ import annotations

from typing import Any

from cognitum._http import AsyncHttpClient, SyncHttpClient
from cognitum.types import Order, OrderCreateResponse


def _parse_order(data: Any) -> Order:
    return Order(
        id=data.get("id", data.get("orderId", "")),
        email=data.get("email", ""),
        status=data.get("status", "unknown"),
        quantity=data.get("quantity", 1),
        amount_cents=data.get("amount_cents") or data.get("amountCents"),
        currency=data.get("currency", "usd"),
        created_at=data.get("created_at") or data.get("createdAt"),
        metadata=data.get("metadata", {}),
    )


def _parse_create_response(data: Any) -> OrderCreateResponse:
    return OrderCreateResponse(
        order_id=data.get("order_id", data.get("orderId", "")),
        client_secret=data.get("client_secret") or data.get("clientSecret"),
        status=data.get("status", "pending"),
    )


class OrdersResource:
    """Synchronous orders resource."""

    def __init__(self, http: SyncHttpClient) -> None:
        self._http = http

    def status(self, order_id: str) -> Order:
        """Look up order status by order ID."""
        data = self._http.get("/lookupOrderStatus", params={"orderId": order_id})
        return _parse_order(data)

    def create(self, email: str, *, quantity: int = 1) -> OrderCreateResponse:
        """Create a new presale order."""
        data = self._http.post(
            "/createPresalePaymentIntent",
            json={"email": email, "quantity": quantity},
        )
        return _parse_create_response(data)


class AsyncOrdersResource:
    """Asynchronous orders resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def status(self, order_id: str) -> Order:
        """Look up order status by order ID."""
        data = await self._http.get(
            "/lookupOrderStatus", params={"orderId": order_id}
        )
        return _parse_order(data)

    async def create(self, email: str, *, quantity: int = 1) -> OrderCreateResponse:
        """Create a new presale order."""
        data = await self._http.post(
            "/createPresalePaymentIntent",
            json={"email": email, "quantity": quantity},
        )
        return _parse_create_response(data)
