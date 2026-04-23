"""Synchronous :class:`SeedClient` (ADR-0013a §2.3, ADR-0016a mesh shape)."""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import replace as dataclass_replace
from typing import Any, Mapping, Sequence
from types import TracebackType

import httpx

from cognitum._errors import (
    ApiError,
    AuthError,
    AuthReason,
    CognitumError,
    ConfigError,
    ConflictError,
    NetworkError,
    NotFoundError,
    NotImplementedError as SeedNotImplementedError,
    ParseError,
    RateLimitError,
    ServiceUnavailableError,
    TimeoutError as SeedTimeoutError,
    TrustScoreBlockedError,
    ValidationError,
)
from cognitum.seed._call_options import CallOptions, resolve_call_options
from cognitum.seed._config import (
    EndpointsInput,
    SeedAuth,
    SeedClientOptions,
    SeedFailover,
    SeedTLS,
    normalise_options,
)
from cognitum.seed._health import HealthProbe
from cognitum.seed.discovery._types import DiscoveryProvider
from cognitum.seed._models import Identity, PairCreateResponse, Status
from cognitum.seed._peers import Peer, PeerErrorClass, PeerSet
from cognitum.seed._retry import (
    RetryPolicy,
    compute_delay_ms,
    is_retriable,
    parse_retry_after,
)
from cognitum.seed._token_book import InMemoryTokenBook, SecretString, TokenBook
from cognitum.seed._transport import PinVerifier, build_sync_client, safe_json
from cognitum.seed.resources import (
    CustodyResource,
    MeshResource,
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
    body: Mapping[str, Any] | None = None,
) -> CognitumError:
    """Translate a 4xx/5xx response to the ADR-0004 taxonomy."""
    status = response.status_code
    if body is None:
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


# Status classes the routing layer treats as "cycle to next peer".
_CYCLE_STATUS = {500, 502, 503, 504}


class _SyncTransport:
    """Mesh-aware HTTP transport (ADR-0016a §D3).

    Failover state machine:
    * ``NetworkError`` / ``TimeoutError`` / 5xx / 503 → cycle to the
      next peer via :meth:`PeerSet.next_after`.
    * 429 → pin to the same peer, honour ADR-0005 backoff.
    * 4xx (auth / validation / not-found) / 501 → surface immediately.
    """

    def __init__(self, options: SeedClientOptions) -> None:
        self._options = options
        self._client = build_sync_client(options)
        self._policy = RetryPolicy(
            max_retries=options.max_retries,
            max_elapsed_ms=options.max_elapsed_ms,
        )
        self._peers = PeerSet.new(list(options.endpoints))
        self._peers_lock = threading.Lock()
        self._token_book: TokenBook = options.token_book or InMemoryTokenBook()
        # Per-peer fingerprint pinner (ADR-0007 §TLS, mDNS fp= TXT).
        # Empty when discovery did not surface any fingerprints — the
        # verifier then no-ops for every peer.
        self._pin_verifier = PinVerifier(options.fingerprints)
        self._closed: bool = False
        # Trust-score counter: per-peer consecutive 401/403 count (ADR-0007
        # §Trust-score protection, issue #16 / audit P-D1). Lives on the
        # transport instance so it survives across request() calls. Reset
        # on any 2xx from that peer. Reaching 3 raises
        # :class:`TrustScoreBlockedError` — a hard abort; NOT a cycle
        # trigger for the mesh failover loop.
        self._auth_failure_counts: dict[str, int] = {}
        self._trust_lock = threading.Lock()

    def close(self) -> None:
        # Idempotent — safe to call twice. httpx.Client.close() is also
        # idempotent, but we want the `_closed` flag to be the source of
        # truth for post-close request rejection.
        if self._closed:
            return
        self._closed = True
        self._client.close()

    def _trust_record_failure(self, peer_key: str) -> int:
        with self._trust_lock:
            count = self._auth_failure_counts.get(peer_key, 0) + 1
            self._auth_failure_counts[peer_key] = count
            return count

    def _trust_reset(self, peer_key: str) -> None:
        with self._trust_lock:
            self._auth_failure_counts.pop(peer_key, None)

    def _trust_reset_all(self) -> None:
        with self._trust_lock:
            self._auth_failure_counts.clear()

    def _trust_count(self, peer_key: str) -> int:
        with self._trust_lock:
            return self._auth_failure_counts.get(peer_key, 0)

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

    def request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        idempotent: bool | None = None,
        peer_key: str | None = None,
        options: CallOptions | None = None,
    ) -> Any:
        if self._closed:
            raise RuntimeError("SeedClient is closed")
        method_u = method.upper()
        correlation_id = str(uuid.uuid4())

        # Per-call knobs merged via shared resolver (see _call_options).
        resolved = resolve_call_options(
            options,
            pinned_peer_key=peer_key,
            default_max_retries=self._policy.max_retries,
            peers=self._peers,
            peers_lock=self._peers_lock,
        )
        effective_peer_key = resolved.effective_peer_key
        per_call_max_retries = resolved.max_retries
        per_call_timeout_override = resolved.timeout_override

        if resolved.total_deadline_s is not None:
            deadline = time.monotonic() + resolved.total_deadline_s
        else:
            deadline = time.monotonic() + self._policy.max_elapsed_ms / 1000.0
        idem = bool(idempotent) if idempotent is not None else method_u in ("GET", "HEAD")

        peer = self._pick_peer(effective_peer_key)
        total_peers = len(self._peers)
        peers_tried = 0
        attempt = 0
        last_exc: CognitumError | None = None

        while True:
            headers = {"X-Correlation-Id": correlation_id}
            tok = self._token_book.get(peer.endpoint.url)
            if tok is not None:
                headers["X-Pairing-Token"] = tok.as_str()

            # Per-peer TLS fingerprint pin check (ADR-0007 §TLS). Runs
            # before httpx dispatches so a mismatch never exfiltrates
            # a pairing token. Cached per session lifetime — first use
            # per peer costs one handshake; subsequent calls no-op.
            # NOTE: TlsPinError is never retriable and never triggers
            # mesh failover — it indicates active tampering.
            if self._pin_verifier.needs_verification(peer.endpoint.url):
                self._pin_verifier.verify(peer.endpoint.url)

            url = f"{peer.endpoint.url}{path if path.startswith('/api') else '/api/v1' + path}"
            call_started = time.monotonic()
            server_hint: int | None = None

            try:
                extra_kw: dict[str, Any] = {}
                if per_call_timeout_override is not None:
                    extra_kw["timeout"] = per_call_timeout_override
                response = self._client.request(
                    method_u, url, json=json, params=params, headers=headers,
                    **extra_kw,
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
                # All peers tried — fall through to ADR-0005 retry.
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
                    # Any 2xx from this peer resets its trust-score counter
                    # (ADR-0007 §Trust-score protection).
                    self._trust_reset(peer.endpoint.url)
                    return self._decode(response, correlation_id=correlation_id)

                err_body = safe_json(response)
                last_exc = map_error(
                    response, correlation_id=correlation_id, body=err_body,
                )
                if isinstance(last_exc, AuthError):
                    # Increment the per-peer consecutive-auth-failure
                    # counter. The 3rd failure converts to a hard-abort
                    # TrustScoreBlockedError BEFORE it ever leaves the
                    # client — we want to stop before the seed's own
                    # 3-strike counter bans this IP for 5 minutes
                    # (audit P-D1, issue #16). The counter is per-peer
                    # and survives across request() calls.
                    count = self._trust_record_failure(peer.endpoint.url)
                    if count >= 3:
                        raise TrustScoreBlockedError(
                            peer_url=peer.endpoint.url,
                            status_code=last_exc.status_code,
                            correlation_id=correlation_id,
                            raw_body=last_exc.raw_body,
                            cause=last_exc,
                        )
                server_hint = parse_retry_after(response.headers, err_body)

                # Classify for peer bookkeeping.
                if status == 503:
                    self._mark_failure(peer.endpoint.url, PeerErrorClass.SERVICE_UNAVAILABLE)
                elif status in (500, 502, 504):
                    self._mark_failure(peer.endpoint.url, PeerErrorClass.SERVER_5XX)

                # Dispatch per §D3.
                if status in _CYCLE_STATUS:
                    peers_tried += 1
                    nxt = self._next_peer(peer.endpoint.url)
                    if nxt is not None and peers_tried < total_peers:
                        peer = nxt
                        continue
                    # All peers tried — fall through to ADR-0005 retry.
                elif status == 429:
                    # Pin on same peer; do NOT cycle.
                    pass
                else:
                    # 4xx (auth/validation/not-found) or 501 — surface.
                    raise last_exc

                if not last_exc.retriable or not is_retriable(
                    method=method_u,
                    status_code=status,
                    body_sent=True,
                    idempotent=idem,
                ):
                    raise last_exc

            # ADR-0005 retry path (all peers exhausted for cyclables, or
            # we're pinned on 429). Budget is total across peers.
            if attempt >= per_call_max_retries:
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
            time.sleep(delay / 1000.0)
            attempt += 1
            # Reset peer cycle counter for this retry round.
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


class SeedClient:
    """Seed-direct synchronous client (Phase 1.5 mesh-aware)."""

    pair: PairResource
    store: StoreResource
    custody: CustodyResource
    witness: WitnessResource
    ota: OtaResource
    mesh: MeshResource

    def __init__(
        self,
        endpoints: EndpointsInput,
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
        # Preserve the provider so :meth:`rediscover` can re-query it.
        # ADR-0016a §D6: explicit list remains the required primitive;
        # discovery is an opt-in Phase 1.5 upgrade path.
        self._discovery: DiscoveryProvider | None = (
            endpoints if isinstance(endpoints, DiscoveryProvider)
            and not isinstance(endpoints, (str, list, tuple))
            else None
        )
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
        self._transport = _SyncTransport(self._options)
        self.pair = PairResource(self._transport)
        self.store = StoreResource(self._transport)
        self.custody = CustodyResource(self._transport)
        self.witness = WitnessResource(self._transport)
        self.ota = OtaResource(self._transport)
        self.mesh = MeshResource(self._transport)
        # Opt-in active probe (ADR-0016a §D7).
        self._health: HealthProbe | None = None
        if self._options.health_interval is not None:
            self._health = HealthProbe(
                self._transport._client,
                self._transport._peers,
                self._options.health_interval,
            )
        # Post-close lifecycle guard. Mirrors Node's `Drop`-semantics and
        # Rust's explicit `close()` so callers can't accidentally reuse a
        # client whose httpx.Client has been shut down.
        self._closed: bool = False

    @property
    def options(self) -> SeedClientOptions:
        return self._options

    def status(self, *, options: CallOptions | None = None) -> Status:
        data = self._transport.request(
            "GET", "/api/v1/status", options=options,
        )
        return Status.from_wire(data or {})

    def identity(self, *, options: CallOptions | None = None) -> Identity:
        data = self._transport.request(
            "GET", "/api/v1/identity", options=options,
        )
        return Identity.from_wire(data or {})

    def peers_snapshot(self) -> list[Peer]:
        """Defensive copy of the SDK-local peer table."""
        with self._transport._peers_lock:
            return self._transport._peers.snapshot()

    def peers(self) -> list[Peer]:
        """SDK-local snapshot of configured peers (ADR-0016a §D7).

        Distinct from :attr:`mesh.peers`, which returns the *seed's* own
        view of ITS overlay peers. This method answers "which endpoints
        did I configure this client with and how is each one doing?".
        """
        return self.peers_snapshot()

    def rediscover(self) -> None:
        """Reset SDK-local peer state (ADR-0016b §"rediscover").

        Re-initialises the :class:`PeerSet`, clearing latency EMAs,
        state flags, and per-peer trust counters. Idempotent. When the
        client was constructed with a :class:`DiscoveryProvider` the
        provider is re-queried and the new list replaces the old one;
        otherwise the original explicit list is re-used (bookkeeping
        reset only).
        """
        from cognitum.seed._config import Endpoint

        if self._discovery is not None:
            discovered = self._discovery.discover()
            if discovered:
                new_endpoints = tuple(Endpoint.parse(p.url) for p in discovered)
                # Mutate the options so subsequent rediscover() passes
                # that don't hit the provider still see the latest list.
                self._options = dataclass_replace(
                    self._options, endpoints=new_endpoints,
                )
        with self._transport._peers_lock:
            self._transport._peers = PeerSet.new(list(self._options.endpoints))
        self._transport._trust_reset_all()

    def session(self) -> "SeedSession":
        """Open a peer-pinned :class:`SeedSession` (ADR-0016a §D4/D9).

        Pins to the currently closest-first peer; all calls through the
        returned session target that peer unless it fails hard.
        """
        from cognitum.seed._session import SeedSession

        pinned = self._transport._pick_peer(None).endpoint.url
        return SeedSession(self, pinned)

    def token_for_peer(self, peer_url: str) -> SecretString | None:
        """Introspection helper — look up a pairing token by peer URL."""
        return self._transport._token_book.get(peer_url)

    def reset_trust_score(self, peer_url: str | None = None) -> None:
        """Test-only: clear the per-peer auth-failure counter.

        Pass ``peer_url=None`` to clear every peer's counter. In
        production code, successful 2xx responses reset a peer's counter
        automatically — this escape hatch exists so tests can simulate
        recovery without roundtripping a fake 2xx response.
        """
        if peer_url is None:
            self._transport._trust_reset_all()
        else:
            self._transport._trust_reset(peer_url)

    def _pair_on_peer(
        self, peer_key: str, client_name: str
    ) -> SecretString:
        """Pair with ``client_name`` on the given peer and record the
        returned token in the :class:`TokenBook`."""
        data = self._transport.request(
            "POST",
            "/api/v1/pair",
            json={"client_name": client_name},
            peer_key=peer_key,
        )
        resp = PairCreateResponse.from_wire(data or {})
        # `resp.token` is already a SecretString (issue #15 fix).
        token = resp.token
        self._transport._token_book.set(peer_key, token)
        return token

    def close(self) -> None:
        """Release the underlying ``httpx.Client`` and stop the health
        probe (if any). Idempotent: calling a second time is a no-op.

        After ``close()``, any method that goes through the transport
        (``status()``, ``identity()``, any resource call) raises
        :class:`RuntimeError("SeedClient is closed")`. Construct a fresh
        client to continue.
        """
        if self._closed:
            return
        self._closed = True
        if self._health is not None:
            try:
                self._health.close()
            finally:
                self._health = None
        if self._discovery is not None:
            try:
                self._discovery.close()
            finally:
                self._discovery = None
        self._transport.close()

    @property
    def closed(self) -> bool:
        return self._closed

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
