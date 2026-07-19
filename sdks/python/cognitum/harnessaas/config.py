"""``HarnessaaSClient`` construction and deployment ownership (ADR-0027a,
ADR-0019 §D2). Issue #67/#68 / M5 start.

**Scope note (2026-07-19 reconciliation audit, issue #67):** the upstream
``cognitum-one/harnessaas`` service is genuinely SYNCHRONOUS today --
``POST /solve`` is one HTTP request/response with no job/poll/SSE/approval
contract anywhere in the running service (see
``docs/adr/0027a-harnessaas-jobs-events-approvals-and-artifacts.md``'s
"2026-07-19 reconciliation audit" context-section note). ADR-0027a's
"Decision" section (an async ``SolveHandle``/``/v1/solves/*`` job resource)
is an explicit PROPOSAL for something that does not exist upstream yet --
this module intentionally does NOT build against it.

Construction performs NO I/O -- see :mod:`cognitum.harnessaas.client` for
the real HTTP-backed operations (``health``, ``solve``, ``lineage``).
"""

from __future__ import annotations

import ipaddress
import re
import warnings
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol
from urllib.parse import urlparse

if TYPE_CHECKING:
    import httpx

    from cognitum.agentic import BudgetPolicy, CapabilitySet, CredentialProvider, RequestContext

_HTTPS_RE = re.compile(r"^https://", re.IGNORECASE)

#: One-shot latch so the ``allow_insecure_http`` escape hatch only ever
#: warns once per base_url, matching ``cognitum.meta_llm.config``'s pattern.
_WARNED_INSECURE_HTTP: set[str] = set()


def _extract_host(url: str) -> str | None:
    return urlparse(url).hostname


def _is_loopback_host(host: str) -> bool:
    """``True`` only for a literal IPv4/IPv6 loopback address. Hostname
    resolution (e.g. "localhost") is deliberately excluded -- ADR-0022 §D3.
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
        "HarnessaaSClientConfig: HTTP (non-TLS) transport is ENABLED via "
        f'allow_insecure_http for loopback base_url "{base_url}". Never use this '
        "in production — see ADR-0022 §D3.",
        UserWarning,
        stacklevel=3,
    )


@dataclass(frozen=True)
class HarnessaaSTelemetryEvent:
    """A single telemetry observation emitted around one HarnessaaSClient operation."""

    operation: str
    request_id: str
    http_status: int | None = None
    duration_ms: float | None = None
    retry_after_ms: int | None = None


class HarnessaaSTelemetryHooks(Protocol):
    """Caller-supplied telemetry hooks (ADR-0028). Hooks MUST NOT receive
    secrets; callers wire redaction via ``SecretRedactor`` from
    :mod:`cognitum.agentic` before logging anything derived from these events.
    """

    def on_request_start(self, operation: str, request_id: str) -> None: ...

    def on_request_end(self, event: HarnessaaSTelemetryEvent) -> None: ...


@dataclass
class HarnessaaSClientConfig:
    """Construction config for :class:`cognitum.harnessaas.client.HarnessaaSClient`
    (ADR-0027a, ADR-0019 §D1).
    """

    #: Explicit HTTPS origin. No built-in default -- no contract bundle is
    #: published for HarnessaaS yet (ADR-0027a §D11 blocker #1).
    base_url: str
    #: Opt out of the HTTPS-origin requirement for local development and
    #: tests only. Never set this against a real deployment.
    allow_insecure_http: bool = False
    credential_provider: CredentialProvider | None = None
    #: Injectable ``httpx.AsyncClient``, for tests. Defaults to a private
    #: client constructed from ``base_url``.
    transport: httpx.AsyncClient | None = None
    default_request_context: RequestContext | None = None
    budget_policy: BudgetPolicy | None = None
    #: Static compatibility-table entry consulted by ``capabilities()``. No
    #: runtime capabilities endpoint is published for HarnessaaS yet.
    capabilities_snapshot: CapabilitySet | None = None
    telemetry: HarnessaaSTelemetryHooks | None = None

    def __post_init__(self) -> None:
        if not self.base_url:
            raise ValueError("HarnessaaSClientConfig.base_url is required")
        base_url = self.base_url.rstrip("/")
        if not _HTTPS_RE.match(base_url):
            if not self.allow_insecure_http:
                raise ValueError(
                    "HarnessaaSClientConfig.base_url must be an explicit HTTPS origin "
                    f'(ADR-0027a); got "{self.base_url}". Set allow_insecure_http=True '
                    "for local development only."
                )
            # ADR-0022 §D3: disabling TLS is allowed only for loopback
            # development, emits a local warning hook, and cannot be
            # enabled through a generic environment variable in
            # production builds.
            host = _extract_host(base_url)
            if not host or not _is_loopback_host(host):
                raise ValueError(
                    "HarnessaaSClientConfig.allow_insecure_http is only permitted for "
                    f'literal IPv4/IPv6 loopback base URLs (ADR-0022 §D3); got "{self.base_url}". '
                    'Hostname resolution to loopback (e.g. "localhost") is insufficient.'
                )
            _warn_insecure_http_once(base_url)
        self.base_url = base_url


__all__ = [
    "HarnessaaSTelemetryEvent",
    "HarnessaaSTelemetryHooks",
    "HarnessaaSClientConfig",
]
