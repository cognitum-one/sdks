"""Shared httpx defaults for the product clients (meta-llm, HarnessaaS, Meta Proxy)."""

from __future__ import annotations

import httpx

#: Default timeout for a product client's own ``httpx.AsyncClient``.
#:
#: httpx applies a 5-second timeout to every phase unless told otherwise, so
#: a generation, a HarnessaaS ``solve()`` or a stream's first byte that takes
#: longer than 5 s used to fail with an empty transport error. Node and Rust
#: set no read timeout, and the SDK's own time budgets (``request_context``
#: deadlines, Meta Proxy's ``ProxyTimeBudget``) bound the wait when a caller
#: asks for it. Only establishing the connection is bounded here. To change
#: it, pass your own ``transport=httpx.AsyncClient(timeout=...)``.
DEFAULT_HTTP_TIMEOUT = httpx.Timeout(None, connect=10.0)


def describe_transport_error(cause: BaseException) -> str:
    """Name the exception type, since httpx timeouts often stringify to ``""``."""
    text = str(cause)
    name = type(cause).__name__
    return f"{name}: {text}" if text else name
