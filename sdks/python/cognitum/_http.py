"""Internal HTTP transport layer with retry logic and error mapping."""

from __future__ import annotations

import time
from typing import Any

import httpx

from cognitum.agentic.retry_after import parse_retry_after_ms
from cognitum.errors import (
    AuthError,
    CognitumError,
    NotFoundError,
    RateLimitError,
    ValidationError,
)

# ADR-0005 §Retriable outcomes — 502 and 504 are retriable gateway/upstream
# timeout responses. Closes cognitum-one/sdks#8. Mirrors the seed-side set in
# ``cognitum/seed/_retry.py`` but kept self-contained so the cloud transport
# does not cross the seed package boundary (ADR-0013b §6 / §"cloud path").
_RETRYABLE_STATUS_CODES: frozenset[int] = frozenset({429, 500, 502, 503, 504})

# ADR-0005 §Idempotency rule — methods whose repeat is safe by spec.
# POST/PATCH are excluded; callers must opt-in via ``idempotent=True`` to
# retry write verbs after a status response indicates the server accepted
# (or may have accepted) the body. Closes cognitum-one/sdks#9.
_IDEMPOTENT_METHODS: frozenset[str] = frozenset(
    {"GET", "HEAD", "PUT", "DELETE", "OPTIONS"}
)


# Transport failures that happen before the request leaves this process, so
# the server cannot have seen the body. Only these are safe to retry for a
# non-idempotent method (ADR-0005 §Idempotency rule). A ReadTimeout, a
# WriteError or a dropped connection mid-response may follow a request the
# server already accepted, so a POST is not resent after one.
_PRE_SEND_TRANSPORT_ERRORS: tuple[type[httpx.TransportError], ...] = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.PoolTimeout,
)


def _transport_error_retryable(exc: httpx.TransportError, is_idempotent: bool) -> bool:
    return is_idempotent or isinstance(exc, _PRE_SEND_TRANSPORT_ERRORS)


def _retry_after_seconds(response: httpx.Response) -> float | None:
    """``Retry-After`` in seconds, accepting both RFC 9110 forms, or ``None``."""
    retry_after_ms = parse_retry_after_ms(response.headers.get("Retry-After"))
    return retry_after_ms / 1000 if retry_after_ms is not None else None


def _resolve_idempotent(method: str, idempotent: bool | None) -> bool:
    """Return the effective idempotency flag for ``method``.

    When ``idempotent`` is ``None`` (default), use the ADR-0005 method table;
    when the caller passes an explicit bool, honour it.
    """
    if idempotent is not None:
        return idempotent
    return method.upper() in _IDEMPOTENT_METHODS


def _map_error(response: httpx.Response) -> CognitumError:
    """Map an HTTP error response to the appropriate SDK exception."""
    status = response.status_code
    try:
        body = response.json()
        message = body.get("error", body.get("message", response.text))
    except Exception:
        message = response.text or f"HTTP {status}"

    if isinstance(message, dict):
        message = message.get("message", str(message))

    if status in (401, 403):
        return AuthError(str(message))
    if status == 404:
        return NotFoundError(str(message))
    if status in (400, 422):
        return ValidationError(str(message))
    if status == 429:
        return RateLimitError(
            str(message),
            retry_after_seconds=_retry_after_seconds(response),
        )
    return CognitumError(str(message), code=f"http_{status}")


# ADR-0005 delay cap. It also caps a server's Retry-After hint, which may be
# an HTTP-date hours ahead.
_MAX_DELAY_S = 30.0


def _backoff_delay(attempt: int) -> float:
    """Exponential backoff: 0.5s, 1s, 2s, ..."""
    return min(0.5 * (2**attempt), _MAX_DELAY_S)


class SyncHttpClient:
    """Synchronous HTTP client with automatic retries and error mapping."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float = 30.0,
        max_retries: int = 3,
    ) -> None:
        self._max_retries = max_retries
        self._client = httpx.Client(
            base_url=base_url,
            timeout=timeout,
            headers={
                "X-API-Key": api_key,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )

    def request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        idempotent: bool | None = None,
    ) -> Any:
        """Execute a request with ADR-0005 retry policy.

        Parameters
        ----------
        idempotent:
            ``None`` (default) — auto-resolve from ``method``:
            GET/HEAD/PUT/DELETE/OPTIONS retry on retriable status; POST/PATCH
            do not.
            ``True`` — caller attests semantic idempotency; retries enabled
            even for POST/PATCH (e.g. read-only semantic POSTs).
            ``False`` — force non-retriable even for GETs (rare).
        """
        is_idempotent = _resolve_idempotent(method, idempotent)
        last_exc: Exception | None = None
        for attempt in range(self._max_retries + 1):
            try:
                response = self._client.request(
                    method, path, json=json, params=params
                )
            except httpx.TransportError as exc:
                last_exc = exc
                # Pre-send failures are always retriable; anything later
                # only for idempotent requests (ADR-0005).
                if attempt < self._max_retries and _transport_error_retryable(
                    exc, is_idempotent
                ):
                    time.sleep(_backoff_delay(attempt))
                    continue
                raise CognitumError(f"Transport error: {exc}") from exc

            if response.status_code < 400:
                if not response.content:
                    return {}
                return response.json()

            if (
                response.status_code in _RETRYABLE_STATUS_CODES
                and is_idempotent
                and attempt < self._max_retries
            ):
                delay = _backoff_delay(attempt)
                retry_after = _retry_after_seconds(response)
                if retry_after is not None:
                    delay = min(_MAX_DELAY_S, max(delay, retry_after))
                time.sleep(delay)
                last_exc = _map_error(response)
                continue

            raise _map_error(response)

        if last_exc is not None:
            if isinstance(last_exc, CognitumError):
                raise last_exc
            raise CognitumError(f"Request failed after retries: {last_exc}") from last_exc
        raise CognitumError("Request failed after retries")

    def get(self, path: str, *, params: dict[str, Any] | None = None) -> Any:
        return self.request("GET", path, params=params)

    def post(
        self,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        idempotent: bool | None = None,
    ) -> Any:
        return self.request(
            "POST", path, json=json, params=params, idempotent=idempotent
        )

    def close(self) -> None:
        self._client.close()


class AsyncHttpClient:
    """Asynchronous HTTP client with automatic retries and error mapping."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float = 30.0,
        max_retries: int = 3,
    ) -> None:
        self._max_retries = max_retries
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout,
            headers={
                "X-API-Key": api_key,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        idempotent: bool | None = None,
    ) -> Any:
        """Async twin of :meth:`SyncHttpClient.request`.

        See the sync docstring for the ``idempotent`` semantics; the two
        clients share the same ADR-0005 policy.
        """
        import asyncio

        is_idempotent = _resolve_idempotent(method, idempotent)
        last_exc: Exception | None = None
        for attempt in range(self._max_retries + 1):
            try:
                response = await self._client.request(
                    method, path, json=json, params=params
                )
            except httpx.TransportError as exc:
                last_exc = exc
                # Pre-send failures are always retriable; anything later
                # only for idempotent requests (ADR-0005).
                if attempt < self._max_retries and _transport_error_retryable(
                    exc, is_idempotent
                ):
                    await asyncio.sleep(_backoff_delay(attempt))
                    continue
                raise CognitumError(f"Transport error: {exc}") from exc

            if response.status_code < 400:
                if not response.content:
                    return {}
                return response.json()

            if (
                response.status_code in _RETRYABLE_STATUS_CODES
                and is_idempotent
                and attempt < self._max_retries
            ):
                delay = _backoff_delay(attempt)
                retry_after = _retry_after_seconds(response)
                if retry_after is not None:
                    delay = min(_MAX_DELAY_S, max(delay, retry_after))
                await asyncio.sleep(delay)
                last_exc = _map_error(response)
                continue

            raise _map_error(response)

        if last_exc is not None:
            if isinstance(last_exc, CognitumError):
                raise last_exc
            raise CognitumError(f"Request failed after retries: {last_exc}") from last_exc
        raise CognitumError("Request failed after retries")

    async def get(self, path: str, *, params: dict[str, Any] | None = None) -> Any:
        return await self.request("GET", path, params=params)

    async def post(
        self,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        idempotent: bool | None = None,
    ) -> Any:
        return await self.request(
            "POST", path, json=json, params=params, idempotent=idempotent
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def stream_sse(self, path: str, *, json: dict[str, Any] | None = None):
        """Yield raw SSE lines from a streaming POST request."""
        async with self._client.stream("POST", path, json=json) as response:
            if response.status_code >= 400:
                await response.aread()
                raise _map_error(response)
            async for line in response.aiter_lines():
                yield line
