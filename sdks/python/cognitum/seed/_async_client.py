"""Asynchronous :class:`AsyncSeedClient` (Phase 1)."""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any, Sequence
from types import TracebackType

import httpx

from cognitum._errors import (
    AuthError,
    CognitumError,
    NetworkError,
    ParseError,
    TimeoutError as SeedTimeoutError,
)
from cognitum.seed._client import map_error
from cognitum.seed._config import (
    SeedAuth,
    SeedClientOptions,
    SeedFailover,
    SeedTLS,
    normalise_options,
)
from cognitum.seed._models import Identity, Status
from cognitum.seed._retry import (
    RetryPolicy,
    compute_delay_ms,
    is_retriable,
    parse_retry_after,
)
from cognitum.seed._transport import build_async_client, safe_json
from cognitum.seed.resources import (
    AsyncCustodyResource,
    AsyncOtaResource,
    AsyncPairResource,
    AsyncStoreResource,
    AsyncWitnessResource,
)


def _timeout_phase(exc: httpx.TimeoutException) -> str:
    if isinstance(exc, httpx.ConnectTimeout):
        return "connect"
    if isinstance(exc, httpx.ReadTimeout):
        return "read"
    if isinstance(exc, httpx.WriteTimeout):
        return "read"
    return "total"


class _AsyncTransport:
    def __init__(self, options: SeedClientOptions) -> None:
        self._options = options
        self._client = build_async_client(options)
        self._policy = RetryPolicy(
            max_retries=options.max_retries,
            max_elapsed_ms=options.max_elapsed_ms,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        idempotent: bool | None = None,
    ) -> Any:
        method_u = method.upper()
        correlation_id = str(uuid.uuid4())
        headers = {"X-Correlation-Id": correlation_id}
        deadline = time.monotonic() + self._policy.max_elapsed_ms / 1000.0
        idem = (
            bool(idempotent)
            if idempotent is not None
            else method_u in ("GET", "HEAD")
        )

        attempt = 0
        last_exc: CognitumError | None = None
        auth_fail_count = 0

        while True:
            server_hint: int | None = None
            body_sent = False
            try:
                response = await self._client.request(
                    method_u, path, json=json, params=params, headers=headers,
                )
                body_sent = True
            except httpx.TimeoutException as exc:
                phase = _timeout_phase(exc)
                last_exc = SeedTimeoutError(
                    str(exc) or "request timed out",
                    phase=phase,  # type: ignore[arg-type]
                    correlation_id=correlation_id,
                    cause=exc,
                )
                retriable_now = is_retriable(
                    method=method_u,
                    status_code=None,
                    is_timeout=True,
                    timeout_phase=phase,
                    body_sent=body_sent,
                    idempotent=idem,
                )
            except httpx.TransportError as exc:
                last_exc = NetworkError(
                    str(exc) or "transport error",
                    cause=exc,
                    correlation_id=correlation_id,
                )
                retriable_now = is_retriable(
                    method=method_u,
                    status_code=None,
                    is_transport_error=True,
                    body_sent=body_sent,
                    idempotent=idem,
                )
            else:
                if response.status_code < 400:
                    return self._decode(response, correlation_id=correlation_id)
                last_exc = map_error(response, correlation_id=correlation_id)
                if isinstance(last_exc, AuthError):
                    auth_fail_count += 1
                    if auth_fail_count >= 3:
                        raise last_exc
                server_hint = parse_retry_after(
                    response.headers, safe_json(response)
                )
                retriable_now = last_exc.retriable and is_retriable(
                    method=method_u,
                    status_code=response.status_code,
                    body_sent=True,
                    idempotent=idem,
                )

            if attempt >= self._policy.max_retries or not retriable_now:
                raise last_exc
            if time.monotonic() >= deadline:
                raise last_exc

            delay = compute_delay_ms(
                attempt=attempt,
                policy=self._policy,
                server_hint_ms=server_hint,
            )
            await asyncio.sleep(delay / 1000.0)
            attempt += 1

    def _decode(
        self, response: httpx.Response, *, correlation_id: str
    ) -> Any:
        if not response.content:
            return {}
        ctype = response.headers.get("Content-Type", "")
        if "json" not in ctype.lower():
            return response.text
        try:
            return response.json()
        except Exception as exc:  # pragma: no cover — defensive
            raise ParseError(
                f"failed to decode JSON: {exc}",
                expected="application/json",
                got=ctype,
                raw_body=response.content,
                correlation_id=correlation_id,
            ) from exc


class AsyncSeedClient:
    """Seed-direct asynchronous client (Phase 1, single-endpoint)."""

    pair: AsyncPairResource
    store: AsyncStoreResource
    custody: AsyncCustodyResource
    witness: AsyncWitnessResource
    ota: AsyncOtaResource

    def __init__(
        self,
        endpoints: str | Sequence[str],
        *,
        auth: SeedAuth | None = None,
        tls: SeedTLS | None = None,
        routing: str = "pinned",
        failover: SeedFailover | None = None,
        timeouts: tuple[float, float, float] = (5.0, 30.0, 60.0),
        max_retries: int = 3,
        max_elapsed_ms: int = 60_000,
        user_agent: str = "cognitum-python-seed/0.2.0",
    ) -> None:
        self._options = normalise_options(
            endpoints,
            auth=auth,
            tls=tls,
            routing=routing,  # type: ignore[arg-type]
            failover=failover,
            timeouts=timeouts,
            max_retries=max_retries,
            max_elapsed_ms=max_elapsed_ms,
            user_agent=user_agent,
        )
        self._transport = _AsyncTransport(self._options)
        self.pair = AsyncPairResource(self._transport)
        self.store = AsyncStoreResource(self._transport)
        self.custody = AsyncCustodyResource(self._transport)
        self.witness = AsyncWitnessResource(self._transport)
        self.ota = AsyncOtaResource(self._transport)

    @property
    def options(self) -> SeedClientOptions:
        return self._options

    async def status(self) -> Status:
        data = await self._transport.request("GET", "/api/v1/status")
        return Status.from_wire(data or {})

    async def identity(self) -> Identity:
        data = await self._transport.request("GET", "/api/v1/identity")
        return Identity.from_wire(data or {})

    async def close(self) -> None:
        await self._transport.close()

    async def __aenter__(self) -> "AsyncSeedClient":
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        await self.close()


__all__ = ["AsyncSeedClient"]
