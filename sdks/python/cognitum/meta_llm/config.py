"""MetaLlmClient construction and deployment ownership (ADR-0024a §D1).

Type-only scaffolding plus construction-time validation for issue #58 / M2.
Construction performs NO I/O -- see :mod:`cognitum.meta_llm.client` for the
first real HTTP-backed operations (``health``, ``whoami``, ``models``).
"""

from __future__ import annotations

import ipaddress
import re
import warnings
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol
from urllib.parse import urlparse

if TYPE_CHECKING:
    import httpx

    from cognitum.agentic import BudgetPolicy, CapabilitySet, CredentialProvider, RequestContext

_HTTPS_RE = re.compile(r"^https://", re.IGNORECASE)

#: One-shot latch so the ``allow_insecure_http`` escape hatch only ever
#: warns once per base_url, matching the seed module's
#: ``_warn_default_host_insecure`` pattern (``cognitum.seed._transport``).
_WARNED_INSECURE_HTTP: set[str] = set()


def _extract_host(url: str) -> str | None:
    return urlparse(url).hostname


def _is_loopback_host(host: str) -> bool:
    """``True`` only for a literal IPv4/IPv6 loopback address. Hostname
    resolution (e.g. "localhost") is deliberately excluded -- ADR-0022 §D3:
    "Hostname resolution to loopback is insufficient for the default-safe
    mode because rebinding can change the destination."
    """
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _warn_insecure_http_once(base_url: str) -> None:
    if base_url in _WARNED_INSECURE_HTTP:
        return
    _WARNED_INSECURE_HTTP.add(base_url)
    warnings.warn(
        "MetaLlmClientConfig: HTTP (non-TLS) transport is ENABLED via "
        f'allow_insecure_http for loopback base_url "{base_url}". Never use this '
        "in production — see ADR-0022 §D3.",
        UserWarning,
        stacklevel=3,
    )


class MetaLlmRoutingControls(dict[str, Any]):
    """ADR-0024b product-specific routing controls.

    Frozen as an opaque placeholder here -- the concrete shape lands with
    issue #59 (ADR-0024b: Meta LLM platform resources, routing, and usage).
    """


class MetaLlmSafetyControl(dict[str, Any]):
    """ADR-0024b product-specific safety control.

    See :class:`MetaLlmRoutingControls` for the same issue #59 deferral note.
    """


@dataclass(frozen=True)
class MetaLlmTelemetryEvent:
    """A single telemetry observation emitted around one MetaLlmClient operation."""

    operation: str
    request_id: str
    http_status: int | None = None
    duration_ms: float | None = None
    retry_after_ms: int | None = None
    idempotent_replay: bool | None = None


class MetaLlmTelemetryHooks(Protocol):
    """Caller-supplied telemetry hooks (ADR-0028).

    Deliberately minimal in this pass -- no cost/usage aggregation, no drift
    detection wiring yet. Hooks MUST NOT receive secrets; callers wire
    redaction via ``SecretRedactor`` from :mod:`cognitum.agentic` before
    logging anything derived from these events.
    """

    def on_request_start(self, operation: str, request_id: str) -> None: ...

    def on_request_end(self, event: MetaLlmTelemetryEvent) -> None: ...


@dataclass
class MetaLlmClientConfig:
    """Construction config for :class:`cognitum.meta_llm.client.MetaLlmClient`
    (ADR-0024a §D1).
    """

    #: Explicit HTTPS origin. A production URL becomes a default only after
    #: publication in the contract bundle (ADR-0024a §D1) -- there is no
    #: built-in default here, unlike the root ``Cognitum`` client.
    base_url: str
    #: Opt out of the HTTPS-origin requirement for local development and
    #: tests only. Never set this against a real deployment.
    allow_insecure_http: bool = False
    credential_provider: CredentialProvider | None = None
    #: Injectable ``httpx.AsyncClient``, for tests. Defaults to a private
    #: client constructed from ``base_url``.
    transport: httpx.AsyncClient | None = None
    default_request_context: RequestContext | None = None
    default_routing_controls: MetaLlmRoutingControls | None = None
    default_safety_control: MetaLlmSafetyControl | None = None
    budget_policy: BudgetPolicy | None = None
    #: Static compatibility-table entry consulted by ``capabilities()`` until
    #: a runtime capabilities endpoint is published (ADR-0024a §D9 gate #3).
    capabilities_snapshot: CapabilitySet | None = None
    telemetry: MetaLlmTelemetryHooks | None = None

    def __post_init__(self) -> None:
        if not self.base_url:
            raise ValueError("MetaLlmClientConfig.base_url is required")
        base_url = self.base_url.rstrip("/")
        if not _HTTPS_RE.match(base_url):
            if not self.allow_insecure_http:
                raise ValueError(
                    "MetaLlmClientConfig.base_url must be an explicit HTTPS origin "
                    f'(ADR-0024a §D1); got "{self.base_url}". Set allow_insecure_http=True '
                    "for local development only."
                )
            # ADR-0022 §D3: disabling TLS is allowed only for loopback
            # development, emits a local warning hook, and cannot be
            # enabled through a generic environment variable in
            # production builds.
            host = _extract_host(base_url)
            if not host or not _is_loopback_host(host):
                raise ValueError(
                    "MetaLlmClientConfig.allow_insecure_http is only permitted for "
                    f'literal IPv4/IPv6 loopback base URLs (ADR-0022 §D3); got "{self.base_url}". '
                    'Hostname resolution to loopback (e.g. "localhost") is insufficient.'
                )
            _warn_insecure_http_once(base_url)
        self.base_url = base_url


__all__ = [
    "MetaLlmRoutingControls",
    "MetaLlmSafetyControl",
    "MetaLlmTelemetryEvent",
    "MetaLlmTelemetryHooks",
    "MetaLlmClientConfig",
]
