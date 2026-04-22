"""Asynchronous :class:`AsyncSeedClient` (Phase 1.5 mesh-aware)."""

from __future__ import annotations

import asyncio
import threading
import time
import uuid
from typing import Any, Sequence
from types import TracebackType

import httpx

from cognitum._errors import (
    ApiError,
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
from cognitum.seed._health import AsyncHealthProbe
from cognitum.seed._models import Identity, PairCreateResponse, Status
from cognitum.seed._peers import Peer, PeerErrorClass, PeerSet
from cognitum.seed._retry import (
    RetryPolicy,
    compute_delay_ms,
    is_retriable,
    parse_retry_after,
)
from cognitum.seed._token_book import InMemoryTokenBook, SecretString, TokenBook
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


_CYCLE_STATUS = {500, 502, 503, 504}


class _AsyncTransport:
    def __init__(self, options: SeedClientOptions) -> None:
        self._options = options
        self._client = build_async_client(options)
        self._policy = RetryPolicy(
            max_retries=options.max_retries,
            max_elapsed_ms=options.max_elapsed_ms,
        )
        self._peers = PeerSet.new(list(options.endpoints))
        # A plain threading.Lock is fine — PeerSet mutations are
        # microsecond-scale and non-async.
        self._peers_lock = threading.Lock()
        self._token_book: TokenBook = options.token_book or InMemoryTokenBook()

    async def close(self) -> None:
        await self._client.aclose()

    def _pick_peer(self, pinned_key: str | None) -> Peer:
        with self._peers_lock:
            if pinned_key is not None:
                found = self._peers.find_by_key(pinned_key)
                if found is not None:
                    return found
            return self._peers.pick()

    def _next_peer(self, failed_key: str) -> Peer | None:
        with self._peers_lock:
            failed = self._peers.find_by_key(failed_key)
            if failed is None:
                return None
            return self._peers.next_after(failed)

    def _mark_success(self, key: str, latency_s: float) -> None:
        with self._peers_lock:
            self._peers.mark_success(key, latency_s)

    def _mark_failure(self, key: str, cls: PeerErrorClass) -> None:
        with self._peers_lock:
            self._peers.mark_failure(key, cls)

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        idempotent: bool | None = None,
        peer_key: str | None = None,
    ) -> Any:
        method_u = method.upper()
        correlation_id = str(uuid.uuid4())
        deadline = time.monotonic() + self._policy.max_elapsed_ms / 1000.0
        idem = (
            bool(idempotent)
            if idempotent is not None
            else method_u in ("GET", "HEAD")
        )

        peer = self._pick_peer(peer_key)
        total_peers = len(self._peers)
        peers_tried = 0
        attempt = 0
        last_exc: CognitumError | None = None
        auth_fail_count = 0

        while True:
            headers = {"X-Correlation-Id": correlation_id}
            tok = self._token_book.get(peer.endpoint.url)
            if tok is not None:
                headers["X-Pairing-Token"] = tok.as_str()

            url = f"{peer.endpoint.url}{path if path.startswith('/api') else '/api/v1' + path}"
            call_started = time.monotonic()
            server_hint: int | None = None

            try:
                response = await self._client.request(
                    method_u, url, json=json, params=params, headers=headers,
                )
            except httpx.TimeoutException as exc:
                phase = _timeout_phase(exc)
                last_exc = SeedTimeoutError(
                    str(exc) or "request timed out",
                    phase=phase,  # type: ignore[arg-type]
                    correlation_id=correlation_id,
                    cause=exc,
                )
                self._mark_failure(peer.endpoint.url, PeerErrorClass.TIMEOUT)
                peers_tried += 1
                nxt = self._next_peer(peer.endpoint.url)
                if nxt is not None and peers_tried < total_peers:
                    peer = nxt
                    continue
                if not is_retriable(
                    method=method_u,
                    status_code=None,
                    is_timeout=True,
                    timeout_phase=phase,
                    body_sent=False,
                    idempotent=idem,
                ):
                    raise last_exc
            except httpx.TransportError as exc:
                last_exc = NetworkError(
                    str(exc) or "transport error",
                    cause=exc,
                    correlation_id=correlation_id,
                )
                self._mark_failure(peer.endpoint.url, PeerErrorClass.NETWORK)
                peers_tried += 1
                nxt = self._next_peer(peer.endpoint.url)
                if nxt is not None and peers_tried < total_peers:
                    peer = nxt
                    continue
                if not is_retriable(
                    method=method_u,
                    status_code=None,
                    is_transport_error=True,
                    body_sent=False,
                    idempotent=idem,
                ):
                    raise last_exc
            else:
                status = response.status_code
                if status < 400:
                    self._mark_success(
                        peer.endpoint.url, time.monotonic() - call_started,
                    )
                    return self._decode(response, correlation_id=correlation_id)

                err_body = safe_json(response)
                last_exc = map_error(
                    response, correlation_id=correlation_id, body=err_body,
                )
                if isinstance(last_exc, AuthError):
                    auth_fail_count += 1
                    if auth_fail_count >= 3:
                        raise last_exc
                server_hint = parse_retry_after(response.headers, err_body)

                if status == 503:
                    self._mark_failure(peer.endpoint.url, PeerErrorClass.SERVICE_UNAVAILABLE)
                elif status in (500, 502, 504):
                    self._mark_failure(peer.endpoint.url, PeerErrorClass.SERVER_5XX)

                if status in _CYCLE_STATUS:
                    peers_tried += 1
                    nxt = self._next_peer(peer.endpoint.url)
                    if nxt is not None and peers_tried < total_peers:
                        peer = nxt
                        continue
                elif status == 429:
                    pass
                else:
                    raise last_exc

                if not last_exc.retriable or not is_retriable(
                    method=method_u,
                    status_code=status,
                    body_sent=True,
                    idempotent=idem,
                ):
                    raise last_exc

            if attempt >= self._policy.max_retries:
                if last_exc is not None:
                    raise last_exc
                raise ApiError("seed: max retries exhausted", status_code=0)
            if time.monotonic() >= deadline:
                if last_exc is not None:
                    raise last_exc
                raise SeedTimeoutError(
                    "seed: total deadline exceeded",
                    phase="total",
                    correlation_id=correlation_id,
                )

            delay = compute_delay_ms(
                attempt=attempt,
                policy=self._policy,
                server_hint_ms=server_hint,
            )
            await asyncio.sleep(delay / 1000.0)
            attempt += 1
            peers_tried = 0

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
    """Seed-direct asynchronous client (Phase 1.5 mesh-aware)."""

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
        routing: str = "session",
        failover: SeedFailover | None = None,
        timeouts: tuple[float, float, float] = (5.0, 30.0, 60.0),
        max_retries: int = 3,
        max_elapsed_ms: int = 60_000,
        user_agent: str = "cognitum-python-seed/0.2.0",
        health_interval: float | None = None,
        token_book: TokenBook | None = None,
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
            health_interval=health_interval,
            token_book=token_book,
        )
        self._transport = _AsyncTransport(self._options)
        self.pair = AsyncPairResource(self._transport)
        self.store = AsyncStoreResource(self._transport)
        self.custody = AsyncCustodyResource(self._transport)
        self.witness = AsyncWitnessResource(self._transport)
        self.ota = AsyncOtaResource(self._transport)
        # AsyncHealthProbe must be started from within a running loop —
        # defer until first use via __aenter__ or explicit start().
        self._health: AsyncHealthProbe | None = None

    @property
    def options(self) -> SeedClientOptions:
        return self._options

    async def status(self) -> Status:
        data = await self._transport.request("GET", "/api/v1/status")
        return Status.from_wire(data or {})

    async def identity(self) -> Identity:
        data = await self._transport.request("GET", "/api/v1/identity")
        return Identity.from_wire(data or {})

    def peers_snapshot(self) -> list[Peer]:
        with self._transport._peers_lock:
            return self._transport._peers.snapshot()

    def session(self) -> "AsyncSeedSession":
        """Open a peer-pinned :class:`AsyncSeedSession`."""
        from cognitum.seed._session import AsyncSeedSession

        pinned = self._transport._pick_peer(None).endpoint.url
        return AsyncSeedSession(self, pinned)

    def token_for_peer(self, peer_url: str) -> SecretString | None:
        return self._transport._token_book.get(peer_url)

    async def _pair_on_peer(
        self, peer_key: str, client_name: str
    ) -> SecretString:
        data = await self._transport.request(
            "POST",
            "/api/v1/pair",
            json={"client_name": client_name},
            peer_key=peer_key,
        )
        resp = PairCreateResponse.from_wire(data or {})
        token = SecretString(resp.token)
        self._transport._token_book.set(peer_key, token)
        return token

    def _ensure_health_probe(self) -> None:
        if (
            self._health is None
            and self._options.health_interval is not None
        ):
            self._health = AsyncHealthProbe(
                self._transport._client,
                self._transport._peers,
                self._options.health_interval,
            )

    async def close(self) -> None:
        if self._health is not None:
            try:
                await self._health.close()
            finally:
                self._health = None
        await self._transport.close()

    async def __aenter__(self) -> "AsyncSeedClient":
        self._ensure_health_probe()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        await self.close()


__all__ = ["AsyncSeedClient"]
