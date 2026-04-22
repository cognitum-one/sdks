"""Typed configuration dataclasses for :class:`SeedClient` (ADR-0016 shape).

Phase 1.5 accepts 1..N endpoints; with N==1 the client degenerates to
single-mode behaviour (zero API change). Mesh routing is delivered via
:class:`PeerSet`, per-peer :class:`TokenBook`, and the session-sticky
request loop in :mod:`cognitum.seed._client`.
"""

from __future__ import annotations

import ssl
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Mapping, Sequence, Union
from urllib.parse import urlparse

from cognitum._errors import ConfigError
from cognitum.seed._token_book import InMemoryTokenBook, TokenBook


Routing = Literal["session", "pinned", "round-robin", "read-any-write-one"]
VerifyInput = Union[bool, str, Path, ssl.SSLContext, "object"]


@dataclass(slots=True, frozen=True)
class Endpoint:
    """A normalised seed endpoint."""

    url: str
    host: str
    port: int
    scheme: str

    @classmethod
    def parse(cls, raw: str) -> Endpoint:
        if not isinstance(raw, str) or not raw:
            raise ConfigError("endpoint must be a non-empty string", field="endpoints")
        # Allow "host:port" shorthand by defaulting to https://
        if "://" not in raw:
            raw = f"https://{raw}"
        parsed = urlparse(raw)
        if parsed.scheme not in ("http", "https"):
            raise ConfigError(
                f"unsupported scheme {parsed.scheme!r} (expected http/https)",
                field="endpoints",
            )
        host = parsed.hostname or ""
        if not host:
            raise ConfigError(f"cannot parse host from {raw!r}", field="endpoints")
        port = parsed.port or (8443 if parsed.scheme == "https" else 80)
        return cls(
            url=f"{parsed.scheme}://{host}:{port}",
            host=host,
            port=port,
            scheme=parsed.scheme,
        )


@dataclass(slots=True, frozen=True, repr=False)
class SeedAuth:
    """Credential bundle. Phase 1 honours ``pairing_token`` only; the other
    fields are accepted so the API shape matches ADR-0016.

    ``__repr__`` / ``__str__`` deliberately redact ``pairing_token`` and
    ``api_key`` (audit P-A1 / ADR-0007 §Credential handling). The values
    remain accessible as attributes; only the formatter paths are scrubbed.
    Note ``token_book`` is a ``Mapping[str, str]`` and its raw values are
    NOT rendered in repr either — the count is surfaced instead.
    """

    pairing_token: str | None = None
    api_key: str | None = None           # reserved for cloud / future
    token_book: Mapping[str, str] = field(default_factory=dict)

    def __repr__(self) -> str:
        pt = "<redacted>" if self.pairing_token else None
        ak = "<redacted>" if self.api_key else None
        tb_len = len(self.token_book) if self.token_book else 0
        return (
            f"SeedAuth(pairing_token={pt!r}, api_key={ak!r}, "
            f"token_book=<{tb_len} peers>)"
        )

    def __str__(self) -> str:
        return self.__repr__()


@dataclass(slots=True, frozen=True)
class SeedTLS:
    """TLS trust configuration.

    Exactly one of ``ca_pem`` / ``insecure`` / ``verify`` / ``pinned_sha256``
    should be meaningful at a time. The client builds the final
    :class:`ssl.SSLContext` (via :class:`SeedPinnedVerifier`) from this.
    """

    ca_pem: bytes | str | None = None
    ca_path: Path | None = None
    verify: bool = True
    insecure: bool = False
    pinned_sha256: bytes | None = None
    client_cert: tuple[str, str] | None = None


@dataclass(slots=True, frozen=True)
class SeedFailover:
    """Failover tuning — Phase 1.5."""

    health_check_interval_ms: int = 10_000
    unhealthy_threshold: int = 3
    healthy_threshold: int = 2


@dataclass(slots=True, frozen=True)
class SeedClientOptions:
    """Canonical, normalised client configuration (Phase 1.5 mesh-aware)."""

    endpoints: tuple[Endpoint, ...]
    auth: SeedAuth
    tls: SeedTLS
    routing: Routing = "session"
    failover: SeedFailover | None = None
    timeouts: tuple[float, float, float] = (5.0, 30.0, 60.0)
    max_retries: int = 3
    max_elapsed_ms: int = 60_000
    user_agent: str = "cognitum-python-seed/0.2.0"
    health_interval: float | None = None
    # token_book is mutable by design — callers can pair_all() after
    # construction. Kept out of the hash by frozen=True semantics (we
    # don't hash SeedClientOptions).
    token_book: TokenBook | None = None
    # True when the caller explicitly passed a `tls=...` value to the
    # client constructor. When False, the default-host allowlist in
    # :mod:`_transport` is allowed to fall back to self-signed acceptance
    # (with a one-time warning). When True, the caller's SeedTLS is
    # honoured strictly regardless of host (issue #17 / P-B1).
    tls_explicit: bool = False

    @property
    def primary(self) -> Endpoint:
        return self.endpoints[0]

    @property
    def is_mesh(self) -> bool:
        return len(self.endpoints) > 1


def normalise_options(
    endpoints: str | Sequence[str],
    *,
    auth: SeedAuth | None = None,
    tls: SeedTLS | None = None,
    routing: Routing = "session",
    failover: SeedFailover | None = None,
    timeouts: tuple[float, float, float] = (5.0, 30.0, 60.0),
    max_retries: int = 3,
    max_elapsed_ms: int = 60_000,
    user_agent: str = "cognitum-python-seed/0.2.0",
    health_interval: float | None = None,
    token_book: TokenBook | None = None,
) -> SeedClientOptions:
    """Phase 1.5 validation: accept 1..N endpoints.

    N==1 degenerates to Phase 1 single-mode semantics. For N>1 the caller
    should also provide a :class:`TokenBook` if peers need distinct
    pairing tokens — a single ``auth.pairing_token`` will be propagated
    to every peer via the book at client-build time.
    """

    if isinstance(endpoints, str):
        raw_list: list[str] = [endpoints]
    elif isinstance(endpoints, (list, tuple)):
        raw_list = list(endpoints)
    else:
        raise ConfigError(
            "endpoints must be str or list[str]", field="endpoints"
        )

    if len(raw_list) == 0:
        raise ConfigError("endpoints must not be empty", field="endpoints")

    parsed = tuple(Endpoint.parse(e) for e in raw_list)

    # Remember whether the caller passed tls explicitly — this gates the
    # default-host self-signed fallback in `_transport.build_verify`
    # (issue #17).
    tls_explicit = tls is not None
    tls_cfg = tls or SeedTLS()
    # Guardrail: insecure requires explicit opt-in.
    if tls_cfg.insecure and tls_cfg.verify:
        # insecure wins but we normalise to keep `verify` coherent.
        tls_cfg = SeedTLS(
            ca_pem=tls_cfg.ca_pem,
            ca_path=tls_cfg.ca_path,
            verify=False,
            insecure=True,
            pinned_sha256=tls_cfg.pinned_sha256,
            client_cert=tls_cfg.client_cert,
        )

    if len(timeouts) != 3:
        raise ConfigError(
            "timeouts must be (connect, read, total) tuple of 3 floats",
            field="timeouts",
        )
    for i, v in enumerate(timeouts):
        if not isinstance(v, (int, float)) or v <= 0:
            name = ("connect", "read", "total")[i]
            raise ConfigError(
                f"timeouts.{name} must be a positive number", field="timeouts"
            )

    if routing not in ("session", "pinned", "round-robin", "read-any-write-one"):
        raise ConfigError(f"unknown routing mode: {routing!r}", field="routing")

    if health_interval is not None and health_interval <= 0:
        raise ConfigError(
            "health_interval must be a positive number of seconds",
            field="health_interval",
        )

    book = token_book if token_book is not None else InMemoryTokenBook()

    # If the caller supplied a single pairing token via `auth`, seed the
    # book for every peer that doesn't already have an entry (ADR-0016a
    # §D5 "single token for all peers when the caller asserts they
    # share"). We do this here (not in the client) so the public
    # SeedClientOptions carries the propagated state.
    if (auth or SeedAuth()).pairing_token:
        from cognitum.seed._token_book import SecretString

        tok_str = (auth or SeedAuth()).pairing_token
        assert tok_str is not None
        for ep in parsed:
            if book.get(ep.url) is None:
                book.set(ep.url, SecretString(tok_str))

    return SeedClientOptions(
        endpoints=parsed,
        auth=auth or SeedAuth(),
        tls=tls_cfg,
        routing=routing,
        failover=failover,
        timeouts=tuple(float(v) for v in timeouts),  # type: ignore[arg-type]
        max_retries=max_retries,
        max_elapsed_ms=max_elapsed_ms,
        user_agent=user_agent,
        health_interval=health_interval,
        token_book=book,
        tls_explicit=tls_explicit,
    )


__all__ = [
    "Endpoint",
    "Routing",
    "SeedAuth",
    "SeedClientOptions",
    "SeedFailover",
    "SeedTLS",
    "VerifyInput",
    "normalise_options",
]
