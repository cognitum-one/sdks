"""Typed data models for the Cognitum SDK."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class CognitumConfig:
    """Configuration for Cognitum client instances."""

    api_key: str
    base_url: str = "https://api.cognitum.one"
    timeout: float = 30.0
    max_retries: int = 3


# ---------- Catalog ----------


@dataclass(frozen=True)
class Product:
    """A product in the Cognitum catalog."""

    id: str
    name: str
    description: str
    category: str | None = None
    price_cents: int | None = None
    currency: str = "usd"
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class CatalogResponse:
    """Response from catalog browse."""

    products: list[Product]
    total: int = 0


# ---------- Orders ----------


@dataclass(frozen=True)
class Order:
    """An existing order."""

    id: str
    email: str
    status: str
    quantity: int = 1
    amount_cents: int | None = None
    currency: str = "usd"
    created_at: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class OrderCreateParams:
    """Parameters for creating an order."""

    email: str
    quantity: int = 1


@dataclass(frozen=True)
class OrderCreateResponse:
    """Response from order creation."""

    order_id: str
    client_secret: str | None = None
    status: str = "pending"


# ---------- Leads ----------


@dataclass(frozen=True)
class LeadSubscribeParams:
    """Parameters for lead subscription."""

    email: str
    product: str | None = None


# ---------- Contact ----------


@dataclass(frozen=True)
class ContactSendParams:
    """Parameters for sending a contact message."""

    name: str
    email: str
    message: str
    inquiry_type: str | None = None


# ---------- MCP ----------


@dataclass(frozen=True)
class McpTool:
    """An MCP tool definition."""

    name: str
    description: str
    input_schema: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class McpToolResult:
    """Result from an MCP tool invocation."""

    content: Any = None
    is_error: bool = False
    error_message: str | None = None


# ---------- Devices ----------


@dataclass(frozen=True)
class Device:
    """A registered device."""

    device_id: str
    public_key: str | None = None
    firmware_version: str | None = None
    last_seen: str | None = None
    status: str = "active"
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class FleetStatus:
    """Fleet-level statistics."""

    total_devices: int = 0
    online_devices: int = 0
    outdated_devices: int = 0
    latest_firmware: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class DeviceRegisterParams:
    """Parameters for registering a device."""

    public_key: str
    firmware_version: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


# ---------- Health ----------


@dataclass(frozen=True)
class HealthResponse:
    """Response from health check endpoint."""

    status: str
    version: str | None = None
    timestamp: str | None = None


# ---------- Brain ----------


@dataclass(frozen=True)
class BrainMemory:
    """A memory entry in the brain knowledge base."""

    id: str
    content: str
    author: str | None = None
    score: float = 0.0
    created_at: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class BrainShareParams:
    """Parameters for sharing knowledge."""

    content: str
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class BrainSearchResult:
    """Result from a brain knowledge search."""

    memories: list[BrainMemory]
    total: int = 0
    query: str | None = None
