"""httpx-backed transport for the seed submodule.

Builds :class:`httpx.Client` / :class:`httpx.AsyncClient` honouring the
:class:`SeedTLS` trust material and the ADR-0002 transport posture
(HTTP/1.1 keep-alive, no redirects, default-off HTTP/2).
"""

from __future__ import annotations

import hashlib
import ssl
import threading
import warnings
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from cognitum._errors import ConfigError, TlsPinError
from cognitum.seed._config import SeedAuth, SeedClientOptions, SeedTLS

# ADR-0007 §TLS physical-cable seed paths. Self-signed acceptance here is
# only the fallback when the caller supplied NO tls config at all.
# Explicitly excludes `localhost` / `127.0.0.1` (issue #17 / P-B1): those
# are general-purpose loopback addresses on shared dev boxes and must not
# bypass verification by default — a dev talking to a local seed must opt
# in via `tls=SeedTLS(insecure=True)`.
_DEFAULT_SEED_HOSTS = frozenset({"169.254.42.1", "cognitum.local"})

# Module-level latch so we only warn once per (host) about the default
# self-signed fallback — avoids log-spam while still surfacing the
# situation in production traces.
_WARNED_DEFAULT_HOSTS: set[str] = set()


def _is_default_host(host: str) -> bool:
    low = host.lower()
    if low in _DEFAULT_SEED_HOSTS:
        return True
    if low.startswith("169.254."):
        return True
    if low.startswith("fe80:"):
        return True
    return False


def _warn_default_host_insecure(host: str) -> None:
    """Emit a one-time warning when a default host falls back to
    self-signed acceptance without the caller passing a CA or
    ``insecure=True`` (ADR-0007 §TLS)."""
    key = host.lower()
    if key in _WARNED_DEFAULT_HOSTS:
        return
    _WARNED_DEFAULT_HOSTS.add(key)
    warnings.warn(
        f"SeedClient: TLS verification disabled for host {host!r} by "
        "default-host allowlist. Set tls=SeedTLS(ca_pem=...) or "
        "tls=SeedTLS(ca_path=...) for production.",
        UserWarning,
        stacklevel=3,
    )


class SeedPinnedVerifier:
    """Trusts ONLY the supplied CA PEM, or (for default hosts with no
    explicit TLS config) the seed's self-signed cert.

    Implements ADR-0007 §TLS pinning interface.
    """

    def __init__(
        self,
        *,
        host: str,
        ca_pem: bytes | str | None = None,
        ca_path: Path | str | None = None,
        pinned_sha256: bytes | None = None,
        insecure: bool = False,
        allow_default_host_fallback: bool = False,
    ) -> None:
        self.host = host.lower()
        self.ca_pem = ca_pem
        self.ca_path = Path(ca_path) if ca_path is not None else None
        self.pinned_sha256 = pinned_sha256
        self.insecure = insecure
        self.allow_default_host_fallback = allow_default_host_fallback

        if (
            not insecure
            and not (allow_default_host_fallback and _is_default_host(host))
            and ca_pem is None
            and ca_path is None
        ):
            raise ConfigError(
                "TLS trust material required for non-default hosts "
                "(pass tls=SeedTLS(ca_pem=...) or insecure=True)",
                field="tls",
            )

    def to_ssl_context(self) -> ssl.SSLContext:
        if self.insecure:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            return ctx
        ctx = ssl.create_default_context()
        if self.ca_pem is not None:
            data = (
                self.ca_pem
                if isinstance(self.ca_pem, str)
                else self.ca_pem.decode("utf-8")
            )
            ctx.load_verify_locations(cadata=data)
            return ctx
        if self.ca_path is not None:
            ctx.load_verify_locations(cafile=str(self.ca_path))
            return ctx
        # Default-host fallback — only reached when caller passed NO tls
        # config (ADR-0007 §TLS USB-link exception).
        _warn_default_host_insecure(self.host)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx


def build_verify(
    host: str,
    tls: SeedTLS,
    *,
    tls_explicit: bool = False,
) -> bool | str | ssl.SSLContext:
    """Translate :class:`SeedTLS` into httpx's ``verify=`` argument.

    ``tls_explicit`` is ``True`` when the caller passed a ``tls=...``
    argument to the client constructor. When ``False``, the default-host
    allowlist is allowed to fall back to self-signed acceptance (with a
    one-time ``UserWarning``). When ``True``, the caller's ``SeedTLS`` is
    honoured strictly — ``verify=True`` with no trust material raises
    :class:`ConfigError` regardless of host (issue #17 / ADR-0007 §TLS
    Fail-fast rule).
    """
    if tls.insecure:
        return False
    if tls.ca_path is not None and tls.ca_pem is None:
        return str(tls.ca_path)
    if tls.ca_pem is not None:
        verifier = SeedPinnedVerifier(
            host=host,
            ca_pem=tls.ca_pem,
            ca_path=tls.ca_path,
            pinned_sha256=tls.pinned_sha256,
            insecure=False,
            allow_default_host_fallback=False,
        )
        return verifier.to_ssl_context()
    # No CA material. Default-host self-signed fallback ONLY when the
    # caller provided no tls config — this prevents the prior silent
    # bypass when a caller explicitly opted into `SeedTLS()` on a host
    # like `localhost` that was in the (now-shrunk) allowlist.
    if _is_default_host(host) and not tls_explicit:
        verifier = SeedPinnedVerifier(
            host=host,
            ca_pem=None,
            ca_path=None,
            pinned_sha256=tls.pinned_sha256,
            insecure=False,
            allow_default_host_fallback=True,
        )
        return verifier.to_ssl_context()
    # Either non-default host, OR caller explicitly passed
    # tls=SeedTLS(verify=True) and expects strict verification.
    if tls.verify:
        raise ConfigError(
            f"TLS trust material required for host {host!r} "
            "(pass tls=SeedTLS(ca_pem=..., ca_path=...) or insecure=True)",
            field="tls",
        )
    return False


def _headers(auth: SeedAuth, user_agent: str) -> dict[str, str]:
    """Headers that do NOT include per-peer auth.

    ``X-Pairing-Token`` is injected per-request by the mesh request loop
    using the :class:`TokenBook` (ADR-0016a §D5) so each peer sees its
    own token. Phase 1 single-peer callers still honour
    ``auth.pairing_token`` via the same book (see
    :func:`normalise_options`).
    """
    h: dict[str, str] = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": user_agent,
    }
    if auth.api_key:
        h["X-API-Key"] = auth.api_key
    return h


def build_sync_client(options: SeedClientOptions) -> httpx.Client:
    # Phase 1.5: no base_url pinning — the mesh loop assembles absolute
    # URLs from the picked peer. httpx still reuses the same underlying
    # connection pool across peers.
    ep = options.primary
    connect, read, total = options.timeouts
    verify = build_verify(ep.host, options.tls, tls_explicit=options.tls_explicit)
    return httpx.Client(
        timeout=httpx.Timeout(connect=connect, read=read, write=read, pool=connect),
        headers=_headers(options.auth, options.user_agent),
        limits=httpx.Limits(
            max_connections=32,
            max_keepalive_connections=16,
            keepalive_expiry=30.0,
        ),
        verify=verify,
        cert=options.tls.client_cert,
        follow_redirects=False,
        http2=False,
    )


def build_async_client(options: SeedClientOptions) -> httpx.AsyncClient:
    ep = options.primary
    connect, read, total = options.timeouts
    verify = build_verify(ep.host, options.tls, tls_explicit=options.tls_explicit)
    return httpx.AsyncClient(
        timeout=httpx.Timeout(connect=connect, read=read, write=read, pool=connect),
        headers=_headers(options.auth, options.user_agent),
        limits=httpx.Limits(
            max_connections=32,
            max_keepalive_connections=16,
            keepalive_expiry=30.0,
        ),
        verify=verify,
        cert=options.tls.client_cert,
        follow_redirects=False,
        http2=False,
    )


def safe_json(response: httpx.Response) -> Mapping[str, Any] | None:
    ctype = response.headers.get("Content-Type", "")
    if "json" not in ctype.lower() and not response.content:
        return None
    try:
        data = response.json()
    except Exception:  # pragma: no cover — defensive
        return None
    return data if isinstance(data, dict) else None


def _fetch_peer_cert_sha256(
    host: str, port: int, *, timeout: float = 5.0
) -> str:
    """Open a raw TLS socket, fetch the DER cert, return SHA-256 hex.

    Uses ``ssl.get_server_certificate`` which opens with ``CERT_NONE`` and
    no hostname check when no ``ca_certs`` is supplied — that is the
    desired behaviour here because we do NOT want chain validation to
    gate the fingerprint fetch (the seed cert is self-signed by design).
    The caller compares the returned digest to the expected pin.
    """
    pem = ssl.get_server_certificate((host, port), timeout=timeout)
    # ``get_server_certificate`` returns PEM — convert back to DER so the
    # digest matches what the seed advertises in ``fp=sha256:<hex>``.
    der = ssl.PEM_cert_to_DER_cert(pem)
    return hashlib.sha256(der).hexdigest().lower()


class PinVerifier:
    """Per-peer TLS fingerprint pin verifier (ADR-0007 §TLS).

    Pre-check strategy: before httpx dispatches the first request to a
    peer with an expected ``fp=sha256:<hex>``, we open a raw TLS socket
    and compute the server-cert DER SHA-256. The result is cached per
    peer-URL for the session lifetime; mismatches raise
    :class:`TlsPinError` with no insecure fallback — even when the
    caller set ``insecure=True`` on ``SeedTLS``.

    Chosen over a custom ``httpx.HTTPTransport`` subclass because the
    httpx connection layer does not expose a post-handshake callback
    that reaches the caller's context cleanly, and the pre-check gives
    us a single well-defined place to raise a canonical exception.
    The trade-off is one extra TLS handshake per peer at first use —
    acceptable given peer counts are single-digit (ADR-0016a).
    """

    __slots__ = ("_expected", "_verified", "_lock")

    def __init__(self, expected: Mapping[str, str]) -> None:
        # Normalise keys and values once so lookups by peer URL are
        # cheap and case-insensitive on the hex digest.
        self._expected: dict[str, str] = {
            k: v.lower() for k, v in expected.items()
        }
        self._verified: set[str] = set()
        self._lock = threading.Lock()

    def expected_for(self, peer_url: str) -> str | None:
        return self._expected.get(peer_url)

    def needs_verification(self, peer_url: str) -> bool:
        with self._lock:
            return (
                peer_url in self._expected and peer_url not in self._verified
            )

    def verify(self, peer_url: str) -> None:
        """Verify ``peer_url``. Raises :class:`TlsPinError` on mismatch.

        Idempotent: subsequent calls for an already-verified peer are
        cheap no-ops. Callers should only invoke this when they hold a
        pinned fingerprint for the peer (see :meth:`needs_verification`).
        """

        with self._lock:
            if peer_url not in self._expected:
                return
            if peer_url in self._verified:
                return
            expected = self._expected[peer_url]

        parsed = urlparse(peer_url)
        host = parsed.hostname or ""
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        try:
            actual = _fetch_peer_cert_sha256(host, port)
        except Exception as exc:  # noqa: BLE001 — surface as TlsPinError
            raise TlsPinError(
                "TLS fingerprint pin check failed: "
                f"could not fetch cert from {peer_url!r}: {exc}",
                peer_url=peer_url,
                expected=expected,
                actual=None,
                cause=exc,
            ) from exc
        if actual != expected:
            raise TlsPinError(
                f"TLS fingerprint pin mismatch for {peer_url!r}: "
                f"expected {expected}, got {actual}",
                peer_url=peer_url,
                expected=expected,
                actual=actual,
            )
        with self._lock:
            self._verified.add(peer_url)

    def mark_verified(self, peer_url: str) -> None:
        """Test hook: mark a peer as already verified (bypasses fetch)."""
        with self._lock:
            self._verified.add(peer_url)


__all__ = [
    "PinVerifier",
    "SeedPinnedVerifier",
    "build_async_client",
    "build_sync_client",
    "build_verify",
    "safe_json",
]
