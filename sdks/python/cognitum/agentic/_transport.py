"""Shared httpx defaults for the product clients (meta-llm, HarnessaaS, Meta Proxy)."""

from __future__ import annotations

import httpx

#: Default timeout for a product client's own ``httpx.AsyncClient``.
#:
#: httpx applies a 5-second timeout to every phase unless told otherwise, so
#: a generation, a HarnessaaS ``solve()`` or a stream's first byte that takes
#: longer than 5 s used to fail with an empty transport error. Node and Rust
#: set no read timeout either. Only establishing the connection is bounded
#: here; read, write and pool waits are not.
#:
#: What still bounds a call: Meta Proxy's ``ProxyTimeBudget`` (connect and
#: overall deadline before headers, first-byte and idle timeouts after) and,
#: for meta-llm streams, ``request_context.time_budget`` once headers have
#: arrived. Neither meta-llm nor HarnessaaS enforces a caller deadline while
#: waiting for response headers, so a server that accepts the connection and
#: never answers is waited on until the caller cancels. To bound that, pass
#: your own ``transport=httpx.AsyncClient(timeout=...)``.
DEFAULT_HTTP_TIMEOUT = httpx.Timeout(None, connect=10.0)


def describe_transport_error(cause: BaseException) -> str:
    """Name the exception type, since httpx timeouts often stringify to ``""``."""
    text = str(cause)
    name = type(cause).__name__
    return f"{name}: {text}" if text else name
