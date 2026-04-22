"""Synchronous :class:`SeedClient` (ADR-0013a §2.3, ADR-0016 shape)."""

from __future__ import annotations

import time
import uuid
from typing import Any, Sequence
from types import TracebackType

import httpx

from cognitum._errors import (
    ApiError,
    AuthError,
    AuthReason,
    CognitumError,
    ConflictError,
    NetworkError,
    NotFoundError,
    NotImplementedError as SeedNotImplementedError,
    ParseError,
    RateLimitError,
    ServiceUnavailableError,
    TimeoutError as SeedTimeoutError,
    ValidationError,
)
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
from cognitum.seed._transport import build_sync_client, safe_json
from cognitum.seed.resources import (
    CustodyResource,
    OtaResource,
    PairResource,
    StoreResource,
    WitnessResource,
)


def _timeout_phase(exc: httpx.TimeoutException) -> str:
    if isinstance(exc, httpx.ConnectTimeout):
        return "connect"
    if isinstance(exc, httpx.ReadTimeout):
        return "read"
    if isinstance(exc, httpx.WriteTimeout):
        return "read"
    return "total"


def map_error(
    response: httpx.Response,
    *,
    correlation_id: str | None = None,
) -> CognitumError:
    """Translate a 4xx/5xx response to the ADR-0004 taxonomy."""
    status = response.status_code
    body = safe_json(response)
    raw = response.content if response.content else None

    if body is not None:
        message = (
            body.get("error") or body.get("message") or response.text or f"HTTP {status}"
        )
    else:
        message = response.text or f"HTTP {status}"
    if isinstance(message, dict):
        message = message.get("message") or str(message)
    message = str(message)

    low_msg = message.lower()

    if status == 401:
        return AuthError(
            message,
            reason=AuthReason.INVALID_CREDENTIALS,
            status_code=status,
            raw_body=raw,
            correlation_id=correlation_id,
        )
    if status == 403:
        reason = AuthReason.INVALID_CREDENTIALS
        if "not paired" in low_msg:
            reason = AuthReason.NOT_PAIRED
        elif "window" in low_msg:
            reason = AuthReason.PAIRING_WINDOW_CLOSED
        elif "lockdown" in low_msg or "mtls" in low_msg:
            reason = AuthReason.LOCKDOWN_MTLS_REQUIRED
        return AuthError(
            message,
            reason=reason,
            status_code=status,
            raw_body=raw,
            correlation_id=correlation_id,
        )
    if status == 404:
        return NotFoundError(
            message, status_code=status, raw_body=raw, correlation_id=correlation_id
        )
    if status in (400, 405, 422):
        return ValidationError(
            message, status_code=status, raw_body=raw, correlation_id=correlation_id
        )
    if status == 409:
        return ConflictError(
            message, status_code=status, raw_body=raw, correlation_id=correlation_id
        )
    if status == 429:
        hint = parse_retry_after(response.headers, body)
        return RateLimitError(
            message,
            retry_after_ms=hint if hint is not None else 1000,
            status_code=status,
            raw_body=raw,
            correlation_id=correlation_id,
        )
    if status == 501:
        return SeedNotImplementedError(
            message,
            endpoint=str(response.request.url.path) if response.request else "",
            correlation_id=correlation_id,
        )
    if status == 503:
        hint = parse_retry_after(response.headers, body)
        return ServiceUnavailableError(
            message,
            retry_after_ms=hint,
            status_code=status,
            raw_body=raw,
            correlation_id=correlation_id,
        )
    return ApiError(
        message, status_code=status, raw_body=raw, correlation_id=correlation_id
    )


class _SyncTransport:
    """Internal HTTP transport composing httpx + retry loop."""

    def __init__(self, options: SeedClientOptions) -> None:
        self._options = options
        self._client = build_sync_client(options)
        self._policy = RetryPolicy(
            max_retries=options.max_retries,
            max_elapsed_ms=options.max_elapsed_ms,
        )

    def close(self) -> None:
        self._client.close()

    # The main retry loop (ADR-0013b §6.1). Retries only when safe; respects
    # caller-attested idempotency for POST.
    def request(
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
        idem = bool(idempotent) if idempotent is not None else method_u in ("GET", "HEAD")

        attempt = 0
        last_exc: CognitumError | None = None
        auth_fail_count = 0

        while True:
            server_hint: int | None = None
            body_sent = False
            try:
                response = self._client.request(
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
            time.sleep(delay / 1000.0)
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


class SeedClient:
    """Seed-direct synchronous client (Phase 1, single-endpoint)."""

    pair: PairResource
    store: StoreResource
    custody: CustodyResource
    witness: WitnessResource
    ota: OtaResource

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
        self._transport = _SyncTransport(self._options)
        self.pair = PairResource(self._transport)
        self.store = StoreResource(self._transport)
        self.custody = CustodyResource(self._transport)
        self.witness = WitnessResource(self._transport)
        self.ota = OtaResource(self._transport)

    @property
    def options(self) -> SeedClientOptions:
        return self._options

    def status(self) -> Status:
        data = self._transport.request("GET", "/api/v1/status")
        return Status.from_wire(data or {})

    def identity(self) -> Identity:
        data = self._transport.request("GET", "/api/v1/identity")
        return Identity.from_wire(data or {})

    def close(self) -> None:
        self._transport.close()

    def __enter__(self) -> "SeedClient":
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        self.close()


__all__ = ["SeedClient", "map_error"]
