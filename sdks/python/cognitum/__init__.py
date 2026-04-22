"""Cognitum SDK for Python -- official client library.

Usage::

    from cognitum import Cognitum, AsyncCognitum

    # Synchronous
    with Cognitum(api_key="sk-...") as client:
        products = client.catalog.browse()

    # Asynchronous
    async with AsyncCognitum(api_key="sk-...") as client:
        products = await client.catalog.browse()
"""

# perf-note: these eager imports make `from cognitum.seed import SeedClient`
# transitively load the cloud surface (catalog, orders, brain, mcp,
# async_client, _http, types) — ~11 extra modules, ~50 ms cold-start hit
# for seed-only users. Fix options: (a) lazy `__getattr__` on the root
# package, (b) drop seed re-exports from root. Either is a minor breakage
# for unusual import patterns, so routed via ADR rather than changed here.
from cognitum.async_client import AsyncCognitum
from cognitum.client import Cognitum
from cognitum.errors import (
    ApiError,
    AuthError,
    AuthReason,
    CognitumError,
    ConfigError,
    ConflictError,
    NetworkError,
    NotFoundError,
    NotImplementedError,  # noqa: A004 — distinct from builtins
    ParseError,
    RateLimitError,
    ServiceUnavailableError,
    TimeoutError,  # noqa: A004 — distinct from builtins
    ValidationError,
)
from cognitum.seed import AsyncSeedClient, SeedClient
from cognitum.types import (
    BrainMemory,
    BrainSearchResult,
    BrainShareParams,
    CatalogResponse,
    CognitumConfig,
    ContactSendParams,
    Device,
    DeviceRegisterParams,
    FleetStatus,
    HealthResponse,
    LeadSubscribeParams,
    McpTool,
    McpToolResult,
    Order,
    OrderCreateParams,
    OrderCreateResponse,
    Product,
)

__all__ = [
    # Clients
    "Cognitum",
    "AsyncCognitum",
    "SeedClient",
    "AsyncSeedClient",
    # Errors
    "CognitumError",
    "AuthError",
    "AuthReason",
    "RateLimitError",
    "ValidationError",
    "NotFoundError",
    "NotImplementedError",
    "ConflictError",
    "ServiceUnavailableError",
    "ApiError",
    "NetworkError",
    "TimeoutError",
    "ParseError",
    "ConfigError",
    # Types
    "CognitumConfig",
    "Product",
    "CatalogResponse",
    "Order",
    "OrderCreateParams",
    "OrderCreateResponse",
    "LeadSubscribeParams",
    "ContactSendParams",
    "McpTool",
    "McpToolResult",
    "Device",
    "FleetStatus",
    "DeviceRegisterParams",
    "HealthResponse",
    "BrainMemory",
    "BrainShareParams",
    "BrainSearchResult",
]

__version__ = "0.1.0"
