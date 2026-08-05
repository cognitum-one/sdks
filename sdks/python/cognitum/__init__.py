"""Cognitum SDK for Python -- official client library.

Usage::

    from cognitum import Cognitum, AsyncCognitum

    # Synchronous
    with Cognitum(api_key="sk-...") as client:
        products = client.catalog.browse()

    # Asynchronous
    async with AsyncCognitum(api_key="sk-...") as client:
        products = await client.catalog.browse()

Cold-start import graph (issue #20)
-----------------------------------

``from cognitum.seed import SeedClient`` used to transitively load the whole
cloud surface (``catalog``, ``orders``, ``brain``, ``mcp``, ``async_client``,
``_http``, ``types``) because importing any subpackage runs the parent
``cognitum/__init__.py`` first. That added ~32 ms of eager cloud imports
(cumulative ~51 ms) to seed-only callers.

The fix is PEP 562 lazy ``__getattr__``: top-level re-exports
(``Cognitum``, ``AsyncCognitum``, errors, types) resolve on first
attribute access rather than on package import. Backward-compat is
preserved — ``from cognitum import Cognitum`` still works, it's just
lazier. Direct submodule imports (``from cognitum.seed import SeedClient``,
``from cognitum.client import Cognitum``) now skip the cloud surface
entirely when they don't need it.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

# Seed-direct imports stay eager — ``cognitum.seed`` is already a
# subpackage and loads independently of this __getattr__, but users who
# do ``from cognitum import SeedClient`` should still hit the same lazy
# path below to avoid re-triggering cloud module loads.

__version__ = "0.4.0-rc.1"


# Map of public names → (module, attr) for PEP 562 lazy resolution.
# Keep this table in sync with __all__ below.
_LAZY_ATTRS: dict[str, tuple[str, str]] = {
    # Cloud clients
    "Cognitum": ("cognitum.client", "Cognitum"),
    "AsyncCognitum": ("cognitum.async_client", "AsyncCognitum"),
    # Seed clients (re-exported for convenience)
    "SeedClient": ("cognitum.seed", "SeedClient"),
    "AsyncSeedClient": ("cognitum.seed", "AsyncSeedClient"),
    # Errors (canonical taxonomy lives in cognitum._errors, re-exported
    # via cognitum.errors for 0.1.x backward compat)
    "CognitumError": ("cognitum.errors", "CognitumError"),
    "AuthError": ("cognitum.errors", "AuthError"),
    "AuthReason": ("cognitum.errors", "AuthReason"),
    "RateLimitError": ("cognitum.errors", "RateLimitError"),
    "ValidationError": ("cognitum.errors", "ValidationError"),
    "NotFoundError": ("cognitum.errors", "NotFoundError"),
    "NotImplementedError": ("cognitum.errors", "NotImplementedError"),
    "ConflictError": ("cognitum.errors", "ConflictError"),
    "ServiceUnavailableError": ("cognitum.errors", "ServiceUnavailableError"),
    "ApiError": ("cognitum.errors", "ApiError"),
    "NetworkError": ("cognitum.errors", "NetworkError"),
    "TimeoutError": ("cognitum.errors", "TimeoutError"),
    "ParseError": ("cognitum.errors", "ParseError"),
    "ConfigError": ("cognitum.errors", "ConfigError"),
    # Cloud types
    "CognitumConfig": ("cognitum.types", "CognitumConfig"),
    "Product": ("cognitum.types", "Product"),
    "CatalogResponse": ("cognitum.types", "CatalogResponse"),
    "Order": ("cognitum.types", "Order"),
    "OrderCreateParams": ("cognitum.types", "OrderCreateParams"),
    "OrderCreateResponse": ("cognitum.types", "OrderCreateResponse"),
    "LeadSubscribeParams": ("cognitum.types", "LeadSubscribeParams"),
    "ContactSendParams": ("cognitum.types", "ContactSendParams"),
    "McpTool": ("cognitum.types", "McpTool"),
    "McpToolResult": ("cognitum.types", "McpToolResult"),
    "Device": ("cognitum.types", "Device"),
    "FleetStatus": ("cognitum.types", "FleetStatus"),
    "DeviceRegisterParams": ("cognitum.types", "DeviceRegisterParams"),
    "HealthResponse": ("cognitum.types", "HealthResponse"),
    "BrainMemory": ("cognitum.types", "BrainMemory"),
    "BrainShareParams": ("cognitum.types", "BrainShareParams"),
    "BrainSearchResult": ("cognitum.types", "BrainSearchResult"),
}


def __getattr__(name: str) -> Any:
    """PEP 562 — resolve public names lazily on first access."""
    spec = _LAZY_ATTRS.get(name)
    if spec is None:
        raise AttributeError(f"module 'cognitum' has no attribute {name!r}")
    module_name, attr = spec
    # Local import so we only touch cloud modules when the caller asks.
    import importlib

    module = importlib.import_module(module_name)
    value = getattr(module, attr)
    # Cache on the package module so subsequent accesses skip the hook.
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    """Include lazy attributes in ``dir(cognitum)`` for REPL discovery."""
    return sorted(list(globals().keys()) + list(_LAZY_ATTRS.keys()))


if TYPE_CHECKING:  # pragma: no cover — static-analysis only
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
        NotImplementedError,  # noqa: A004
        ParseError,
        RateLimitError,
        ServiceUnavailableError,
        TimeoutError,  # noqa: A004
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
