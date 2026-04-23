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
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlparse

import httpx

from cognitum._errors import ConfigError, TlsPinError
from cognitum.seed._config import Endpoint, SeedAuth, SeedClientOptions, SeedTLS


# ADR-0007 §TLS physical-cable seed paths. Self-signed acceptance here is
# only the fallback when the caller supplied NO tls config at all.
#
# Scope is strictly link-local (physical-cable) addresses:
#   - `169.254.42.1` — USB-gadget default IP
#   - `169.254.*` — RFC 3927 link-local block (cable-scoped by routing)
#   - `fe80:*` — IPv6 link-local (cable-scoped by protocol)
#
# Explicitly excludes:
#   - `localhost` / `127.0.0.1` (issue #17 / P-B1) — loopback on shared
#     dev boxes.
#   - `cognitum.local` (security audit C3) — mDNS-resolvable on any
#     local network; an attacker on the same wifi can publish a PTR
#     pointing at their laptop and the SDK would silently accept a
#     forged self-signed cert. mDNS names REQUIRE explicit opt-in
#     (insecure=True for dev, ca_pem / fp= pinning for prod).
_DEFAULT_SEED_HOSTS = frozenset({"169.254.42.1"})

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


def _httpx_common_kwargs(
    options: SeedClientOptions, verify: Any
) -> dict[str, Any]:
    """Shared kwargs for httpx.Client / httpx.AsyncClient construction.

    Extracted so that the pinned variants ({build_sync,build_async}
    _pinned_client) can pass a custom SSLContext as ``verify`` without
    duplicating every other knob.
    """
    connect, read, _total = options.timeouts
    return {
        "timeout": httpx.Timeout(
            connect=connect, read=read, write=read, pool=connect
        ),
        "headers": _headers(options.auth, options.user_agent),
        "limits": httpx.Limits(
            max_connections=32,
            max_keepalive_connections=16,
            keepalive_expiry=30.0,
        ),
        "verify": verify,
        "cert": options.tls.client_cert,
        "follow_redirects": False,
        "http2": False,
    }


def build_sync_client(options: SeedClientOptions) -> httpx.Client:
    # Phase 1.5: no base_url pinning — the mesh loop assembles absolute
    # URLs from the picked peer. httpx still reuses the same underlying
    # connection pool across peers.
    ep = options.primary
    verify = build_verify(ep.host, options.tls, tls_explicit=options.tls_explicit)
    return httpx.Client(**_httpx_common_kwargs(options, verify))


def build_async_client(options: SeedClientOptions) -> httpx.AsyncClient:
    ep = options.primary
    verify = build_verify(ep.host, options.tls, tls_explicit=options.tls_explicit)
    return httpx.AsyncClient(**_httpx_common_kwargs(options, verify))


def build_sync_pinned_client(
    options: SeedClientOptions, context: ssl.SSLContext
) -> httpx.Client:
    """Build an httpx.Client whose SSLContext is the caller-supplied
    pinned context. Used by :class:`_SyncTransport` to route requests
    for a fingerprint-pinned peer through a dedicated client whose
    TLS layer rejects any cert that doesn't match the pinned DER (see
    :func:`build_pinned_ssl_context`). Closes the C2 TOCTOU window by
    performing the pin check on the SAME handshake the request uses.
    """
    return httpx.Client(**_httpx_common_kwargs(options, context))


def build_async_pinned_client(
    options: SeedClientOptions, context: ssl.SSLContext
) -> httpx.AsyncClient:
    """Async counterpart of :func:`build_sync_pinned_client`."""
    return httpx.AsyncClient(**_httpx_common_kwargs(options, context))


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
) -> tuple[str, bytes]:
    """Open a raw TLS socket, fetch the DER cert, return (SHA-256 hex, DER bytes).

    Uses ``ssl.get_server_certificate`` which opens with ``CERT_NONE`` and
    no hostname check when no ``ca_certs`` is supplied — that is the
    desired behaviour here because we do NOT want chain validation to
    gate the fingerprint fetch (the seed cert is self-signed by design).
    The caller compares the returned digest to the expected pin and
    uses the returned DER to build a pinned SSLContext for subsequent
    requests (see :func:`build_pinned_ssl_context`).
    """
    pem = ssl.get_server_certificate((host, port), timeout=timeout)
    # ``get_server_certificate`` returns PEM — convert back to DER so the
    # digest matches what the seed advertises in ``fp=sha256:<hex>``.
    der = ssl.PEM_cert_to_DER_cert(pem)
    return hashlib.sha256(der).hexdigest().lower(), der


class _PinnedToCertContext(ssl.SSLContext):
    """SSLContext that accepts EXACTLY one cert, by DER bytes.

    Security audit C2 — the previous design opened a separate raw TLS
    socket to verify the pin, then used a DIFFERENT httpx handshake for
    the actual request. An active attacker could answer handshake #1
    with the real cert and handshake #2 with a forged cert, then be
    cached as ``_verified`` forever. This class closes that window by
    verifying on the SAME handshake httpx uses: the overridden
    :meth:`wrap_socket` runs on the live connection, compares the
    presented peer cert against the pinned DER, and closes+raises on
    mismatch.

    Why subclass SSLContext rather than wrap it: httpx passes its
    ``verify=`` argument directly to the underlying httpcore transport
    which calls ``ctx.wrap_socket(...)`` during connection setup. An
    override here is the narrowest hook that still participates in the
    real TLS handshake.
    """

    def __new__(cls, *args: Any, **kwargs: Any) -> "_PinnedToCertContext":
        # SSLContext constructors take the protocol as a positional arg
        # via ``__new__`` (see CPython ssl.py). Subclasses must respect
        # that. We pick TLS_CLIENT because this context is for outbound
        # connections to the seed.
        return super().__new__(cls, ssl.PROTOCOL_TLS_CLIENT)

    def __init__(self, expected_der: bytes) -> None:
        # Don't call super().__init__() — ssl._SSLContext constructs
        # everything it needs in __new__; a second init raises TypeError
        # on Python 3.14+.
        self._expected_der = expected_der
        # We perform our own check; the default verifier would reject
        # the self-signed seed cert.
        self.check_hostname = False
        self.verify_mode = ssl.CERT_NONE

    def wrap_socket(  # type: ignore[override]
        self,
        sock: Any,
        *args: Any,
        server_hostname: str | None = None,
        **kwargs: Any,
    ) -> ssl.SSLSocket:
        # Force handshake inline so ``getpeercert(binary_form=True)``
        # returns the actual peer cert before we hand the socket back
        # to httpx. If we returned a pre-handshake socket, a caller
        # could start writing plaintext-framed bytes before we had a
        # chance to verify.
        kwargs["do_handshake_on_connect"] = True
        ssock = super().wrap_socket(
            sock, *args, server_hostname=server_hostname, **kwargs
        )
        actual_der = ssock.getpeercert(binary_form=True)
        if actual_der != self._expected_der:
            # Log the mismatched digest for the caller's error, then
            # close the socket so no request data crosses the wire.
            try:
                ssock.unwrap()
            except (OSError, ssl.SSLError):
                pass
            ssock.close()
            expected_sha = hashlib.sha256(self._expected_der).hexdigest()
            actual_sha = (
                hashlib.sha256(actual_der).hexdigest()
                if actual_der
                else "<none>"
            )
            raise ssl.SSLCertVerificationError(
                f"TLS fingerprint pin mismatch for {server_hostname!r}: "
                f"expected {expected_sha}, got {actual_sha}"
            )
        return ssock


def build_pinned_ssl_context(
    *, expected_sha256: str, host: str, port: int, timeout: float = 5.0
) -> ssl.SSLContext:
    """Fetch the peer cert, verify it matches ``expected_sha256``, and
    return an SSLContext that accepts ONLY that specific cert on all
    future handshakes routed through it.

    This closes the TOCTOU window present in the prior out-of-band
    verify design: the returned context's :meth:`wrap_socket` runs on
    the live httpx connection and compares the real peer cert bytes,
    not a cached boolean. An attacker who swapped in a forged cert
    between the fingerprint fetch and the first HTTP request will fail
    the wrap_socket check — the socket is closed before any request
    bytes cross the wire.

    Raises :class:`TlsPinError` if the fingerprint fetch fails or the
    digest does not match ``expected_sha256``.
    """
    try:
        actual_hex, der = _fetch_peer_cert_sha256(host, port, timeout=timeout)
    except Exception as exc:  # noqa: BLE001 — surface as TlsPinError
        raise TlsPinError(
            f"TLS fingerprint pin fetch failed for host {host!r}: {exc}",
            peer_url=f"https://{host}:{port}",
            expected=expected_sha256.lower(),
            actual=None,
            cause=exc,
        ) from exc
    expected_lower = expected_sha256.lower()
    if actual_hex != expected_lower:
        raise TlsPinError(
            f"TLS fingerprint pin mismatch for host {host!r}: "
            f"expected {expected_lower}, got {actual_hex}",
            peer_url=f"https://{host}:{port}",
            expected=expected_lower,
            actual=actual_hex,
        )
    return _PinnedToCertContext(der)


# NOTE: the previous `PinVerifier` class was removed as part of the
# security audit C2 fix. It performed pin verification on a SEPARATE
# TLS socket (via `ssl.get_server_certificate`) and cached a boolean
# "verified" flag — an attacker could answer handshake #1 with the real
# cert and handshake #2 (the actual httpx request) with a forged cert
# and bypass the pin forever. Replacement: `_PinnedToCertContext` +
# `build_pinned_ssl_context` above, wired into `_client.py` so the pin
# check runs on the SAME handshake httpx uses. No caching of a boolean;
# the context holds the pinned DER and the `wrap_socket` override
# verifies every connection.


__all__ = [
    "SeedPinnedVerifier",
    "build_async_client",
    "build_async_pinned_client",
    "build_pinned_ssl_context",
    "build_sync_client",
    "build_sync_pinned_client",
    "build_verify",
    "safe_json",
]
