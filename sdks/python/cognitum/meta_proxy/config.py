"""MetaProxyClient construction and deployment ownership (ADR-0025a §D3).

Type-only scaffolding plus construction-time validation for issue #61 / M3
start. Construction performs NO I/O -- see :mod:`cognitum.meta_proxy.client`
for the first real HTTP-backed operations (``status``, ``capabilities``).

Unlike :mod:`cognitum.meta_llm`'s client (ADR-0024a), which talks directly
to Cognitum's cloud service and therefore requires an explicit HTTPS origin
with no built-in default, ``MetaProxyClient`` talks to an ALREADY-RUNNING
local Meta Proxy sidecar process. Per ADR-0025a's Context section, the Rust
foreground binary "binds to ``127.0.0.1:11435`` by default" -- so this
client's ``origin`` defaults to that literal loopback address, and literal
loopback is the only origin considered safe by default (ADR-0025a §D10:
"Literal loopback is the only stable origin"). This module does NOT
install, start, or reconfigure that process -- see ADR-0025b's
``MetaProxyManager`` for that (owned separately, and independent of this
client per §D1's decision).
"""

from __future__ import annotations

import ipaddress
import warnings
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol
from urllib.parse import urlparse

if TYPE_CHECKING:
    import httpx

    from cognitum.agentic import (
        BudgetPolicy,
        CapabilitySet,
        ConsentGrant,
        CredentialProvider,
        RequestContext,
    )

#: Default loopback origin -- matches the Rust proxy binary's default bind
#: (ADR-0025a Context).
DEFAULT_META_PROXY_ORIGIN = "http://127.0.0.1:11435"

#: One-shot latch so the ``allow_non_loopback`` escape hatch only ever warns
#: once per origin, matching :mod:`cognitum.meta_llm.config`'s
#: ``_WARNED_INSECURE_HTTP`` pattern.
_WARNED_NON_LOOPBACK: set[str] = set()


def _extract_host(url: str) -> str | None:
    return urlparse(url).hostname


def _is_loopback_host(host: str) -> bool:
    """``True`` only for a literal IPv4/IPv6 loopback address. Hostname
    resolution (e.g. "localhost") is deliberately excluded -- ADR-0025a
    §D10: "Hostnames resolving to loopback are insufficient in default-safe
    mode."
    """
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def bearer_target_allowed(origin: str, allow_non_loopback: bool) -> bool:
    """``True`` when a local bearer may be attached to a request to
    ``origin`` (ADR-0025a §D6/§D10): literal loopback always, or any origin
    only when ``allow_non_loopback`` is explicitly set (dangerous preview).

    Defense-in-depth for the bearer-attachment path -- construction already
    rejects a non-loopback origin unless ``allow_non_loopback`` is set, so
    this guards against any future path that reaches the transport without
    re-checking.
    """
    if allow_non_loopback:
        return True
    host = _extract_host(origin)
    return bool(host and _is_loopback_host(host))


def _warn_non_loopback_once(origin: str) -> None:
    if origin in _WARNED_NON_LOOPBACK:
        return
    _WARNED_NON_LOOPBACK.add(origin)
    warnings.warn(
        f'MetaProxyClientConfig: non-loopback origin "{origin}" is ENABLED via '
        "allow_non_loopback. This is DANGEROUS PREVIEW (ADR-0025a §D10) -- the current "
        "Proxy has no separate TLS, remote identity, firewall, or restricted-CORS "
        "contract for this mode. Never use this in production.",
        UserWarning,
        stacklevel=3,
    )


class MetaProxyTelemetryHooks(Protocol):
    """Caller-supplied telemetry hooks (ADR-0028), matching
    :class:`cognitum.meta_llm.config.MetaLlmTelemetryHooks`'s convention.
    Hooks MUST NOT receive secrets.
    """

    def on_request_start(self, operation: str, request_id: str) -> None: ...

    def on_request_end(self, event: MetaProxyTelemetryEvent) -> None: ...


@dataclass(frozen=True)
class MetaProxyTelemetryEvent:
    """A single telemetry observation emitted around one MetaProxyClient operation."""

    operation: str
    request_id: str
    http_status: int | None = None
    duration_ms: float | None = None
    retry_after_ms: int | None = None


@dataclass
class MetaProxyClientConfig:
    """Construction config for :class:`cognitum.meta_proxy.client.MetaProxyClient`
    (ADR-0025a §D3).

    D6 (authentication and workload capabilities) is explicitly deferred --
    this pass accepts only the same shared ``CredentialProvider`` protocol
    (ADR-0022) that ``MetaLlmClient`` uses, standing in for D3's
    ``local_credential_provider`` field. ``ProxyCredential``'s
    ``LocalBearerToken | WorkloadCapability`` discriminated union and
    capability minting via an injected ``MetaProxyLifecycleProvider`` are
    follow-up work (§D6, ADR-0025b, ADR-0026a).
    """

    #: Loopback origin for the already-running Meta Proxy sidecar. Defaults
    #: to ``DEFAULT_META_PROXY_ORIGIN`` when omitted (ADR-0025a §D3, Context).
    origin: str = DEFAULT_META_PROXY_ORIGIN
    #: Opt out of the loopback-only requirement. Dangerous preview per
    #: ADR-0025a §D10 -- never set this against a real deployment.
    allow_non_loopback: bool = False
    #: Local credential provider (ADR-0025a §D3: "It receives its local
    #: credential from the typed provider in ADR-0022"). Required for
    #: ``status()``/``capabilities()`` -- the Proxy's ``/status`` route is
    #: authenticated (ADR-0025a Context).
    local_credential_provider: CredentialProvider | None = None
    #: Injectable ``httpx.AsyncClient``, for tests. Defaults to a private
    #: client constructed from ``origin``.
    transport: httpx.AsyncClient | None = None
    default_request_context: RequestContext | None = None
    budget_policy: BudgetPolicy | None = None
    #: Expected Proxy product version, checked against ``MetaProxyStatus``'s
    #: ``compatible_sdk_range``/``product_version`` (ADR-0025a §D2). A
    #: mismatch surfaces as a ``MetaProxyResponseMeta.warnings`` entry
    #: rather than a hard failure.
    expected_proxy_version: str | None = None
    #: Static compatibility-table entry consulted by ``capabilities()``
    #: alongside the real ``/status`` call (ADR-0025a §D4).
    capabilities_snapshot: CapabilitySet | None = None
    telemetry: MetaProxyTelemetryHooks | None = None
    #: Locally-held ADR-0022 §D7 consent grants this caller presents to the
    #: client (ADR-0025a §D9). Checked before any data-plane call whose
    #: ``RoutingIntent`` allows or requires a consent-gated plane -- currently
    #: ``cognitum_cloud``, gated on a ``cloud_fallback`` grant
    #: (``cognitum.meta_proxy.consent``). Credential presence
    #: (``local_credential_provider``) is NEVER a substitute for an entry here.
    consent_grants: list[ConsentGrant] | None = None

    def __post_init__(self) -> None:
        origin = (self.origin or DEFAULT_META_PROXY_ORIGIN).rstrip("/")
        if not origin.lower().startswith(("http://", "https://")):
            raise ValueError(f'MetaProxyClientConfig.origin must be an http(s) URL; got "{origin}"')
        host = _extract_host(origin)
        if not host or not _is_loopback_host(host):
            if not self.allow_non_loopback:
                raise ValueError(
                    "MetaProxyClientConfig.origin must be a literal IPv4/IPv6 loopback "
                    f'address (ADR-0025a §D10); got "{origin}". Hostname resolution to '
                    'loopback (e.g. "localhost") is insufficient. Set '
                    "allow_non_loopback=True only for the dangerous-preview remote case "
                    "described in §D10."
                )
            _warn_non_loopback_once(origin)
        self.origin = origin


__all__ = [
    "DEFAULT_META_PROXY_ORIGIN",
    "MetaProxyTelemetryEvent",
    "MetaProxyTelemetryHooks",
    "MetaProxyClientConfig",
    "bearer_target_allowed",
]
