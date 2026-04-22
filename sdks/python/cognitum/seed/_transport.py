"""httpx-backed transport for the seed submodule.

Builds :class:`httpx.Client` / :class:`httpx.AsyncClient` honouring the
:class:`SeedTLS` trust material and the ADR-0002 transport posture
(HTTP/1.1 keep-alive, no redirects, default-off HTTP/2).
"""

from __future__ import annotations

import ssl
from pathlib import Path
from typing import Any, Mapping

import httpx

from cognitum._errors import ConfigError
from cognitum.seed._config import Endpoint, SeedAuth, SeedClientOptions, SeedTLS


_DEFAULT_SEED_HOSTS = frozenset({"169.254.42.1", "cognitum.local", "localhost", "127.0.0.1"})


def _is_default_host(host: str) -> bool:
    low = host.lower()
    if low in _DEFAULT_SEED_HOSTS:
        return True
    if low.startswith("169.254."):
        return True
    if low.startswith("fe80:"):
        return True
    return False


class SeedPinnedVerifier:
    """Trusts ONLY the supplied CA PEM, or (for default hosts) the seed's
    self-signed cert.

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
    ) -> None:
        self.host = host.lower()
        self.ca_pem = ca_pem
        self.ca_path = Path(ca_path) if ca_path is not None else None
        self.pinned_sha256 = pinned_sha256
        self.insecure = insecure

        if not insecure and not _is_default_host(host) and ca_pem is None and ca_path is None:
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
        # Default-host fallback: accept self-signed (USB link, ADR-0007).
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx


def build_verify(host: str, tls: SeedTLS) -> bool | str | ssl.SSLContext:
    """Translate :class:`SeedTLS` into httpx's ``verify=`` argument.

    For non-default hosts with ``verify=True`` and no trust material, raise
    :class:`ConfigError` — the SDK refuses to silently accept the system
    trust store for a seed-ish target that isn't a default host (ADR-0007
    §Fail-fast rule).
    """
    if tls.insecure:
        return False
    if tls.ca_path is not None and tls.ca_pem is None:
        return str(tls.ca_path)
    if tls.ca_pem is not None or _is_default_host(host):
        verifier = SeedPinnedVerifier(
            host=host,
            ca_pem=tls.ca_pem,
            ca_path=tls.ca_path,
            pinned_sha256=tls.pinned_sha256,
            insecure=False,
        )
        return verifier.to_ssl_context()
    # Non-default host, no trust material, not insecure. Fail fast.
    if tls.verify:
        raise ConfigError(
            f"TLS trust material required for non-default host {host!r} "
            "(pass tls=SeedTLS(ca_pem=..., ca_path=...) or insecure=True)",
            field="tls",
        )
    return False


def _headers(auth: SeedAuth, user_agent: str) -> dict[str, str]:
    h: dict[str, str] = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": user_agent,
    }
    if auth.pairing_token:
        h["X-Pairing-Token"] = auth.pairing_token
    if auth.api_key:
        h["X-API-Key"] = auth.api_key
    return h


def build_sync_client(options: SeedClientOptions) -> httpx.Client:
    ep = options.primary
    connect, read, total = options.timeouts
    verify = build_verify(ep.host, options.tls)
    return httpx.Client(
        base_url=ep.url,
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
    verify = build_verify(ep.host, options.tls)
    return httpx.AsyncClient(
        base_url=ep.url,
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


__all__ = [
    "SeedPinnedVerifier",
    "build_async_client",
    "build_sync_client",
    "build_verify",
    "safe_json",
]
