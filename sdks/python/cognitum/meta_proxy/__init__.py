"""Meta Proxy client (ADR-0025a). Product namespace per ADR-0019 §D2:
``cognitum.meta_proxy``.

Issue #61 / M3: ``MetaProxyClient`` construction (§D3), ``status()`` /
``capabilities()`` (§D4), routing intent + chat.completions forwarding
(§D5-§D7), streaming (§D8), and the tractable consent-gating slice of §D9
(:mod:`cognitum.meta_proxy.consent` -- the ``cognitum_cloud`` plane is gated
on a ``cloud_fallback`` grant; sponsor budget/usage remain BLOCKED on
ADR-0025b). §D10's browser-runtime rejection is N/A for this package: Python
has no browser/WASM (Pyodide) distribution surface for ``cognitum`` (see
``pyproject.toml`` -- no such build target exists), so there is nothing to
guard. Loopback-origin construction validation (§D10's other half) is
implemented in :mod:`cognitum.meta_proxy.config`. See
:mod:`cognitum.meta_proxy.client`'s module docstring for the full deferred
list.

Per ADR-0019 §D4, this package depends on ``cognitum.agentic`` and MUST NOT
be imported by any other product module (``cognitum.meta_llm``,
``cognitum.metaharness``, ``cognitum.harnessaas``).

This package is imported eagerly by callers of ``cognitum.meta_proxy`` but
is NOT imported by ``cognitum/__init__.py`` itself, matching
``cognitum.meta_llm``'s convention (issue #20's cold-start import graph
fix).
"""

from __future__ import annotations

from cognitum.meta_proxy.auth import (
    DEFAULT_META_PROXY_TOKEN_ENV_VAR,
    LocalBearerToken,
    LocalBearerTokenCredentialProvider,
    ProxyCredential,
    WorkloadCapability,
    WorkloadCapabilityClaims,
)
from cognitum.meta_proxy.client import (
    CapabilitiesResult,
    MetaProxyChatCallOptions,
    MetaProxyClient,
)
from cognitum.meta_proxy.config import (
    DEFAULT_META_PROXY_ORIGIN,
    MetaProxyClientConfig,
    MetaProxyTelemetryEvent,
    MetaProxyTelemetryHooks,
)
from cognitum.meta_proxy.consent import (
    CLOUD_ROUTING_CONSENT_KIND,
    assert_consent_for_routing_intent,
    has_valid_consent_grant,
    intent_touches_plane,
    is_consent_grant_valid,
)
from cognitum.meta_proxy.envelope import (
    MetaProxyResponseMeta,
    MetaProxyResult,
    MetaProxyUpstreamReceipt,
)
from cognitum.meta_proxy.routing import (
    RoutingIntent,
    assert_routing_receipt_matches_intent,
)
from cognitum.meta_proxy.status import (
    MetaProxyRoutingReceipt,
    MetaProxyStatus,
    RoutingPlane,
    WorkloadPolicy,
)
from cognitum.meta_proxy.stream import (
    MetaProxyStreamEnvelope,
    MetaProxyStreamMeta,
    chat_completions_stream,
)
from cognitum.meta_proxy.time_budget import (
    DEFAULT_PROXY_CONNECT_TIMEOUT_MS,
    ProxyTimeBudget,
    ResolvedProxyTimeBudget,
    resolve_proxy_time_budget,
)

__all__ = [
    "MetaProxyClient",
    "MetaProxyChatCallOptions",
    "CapabilitiesResult",
    "DEFAULT_META_PROXY_ORIGIN",
    "MetaProxyClientConfig",
    "MetaProxyTelemetryEvent",
    "MetaProxyTelemetryHooks",
    "MetaProxyResponseMeta",
    "MetaProxyResult",
    "MetaProxyUpstreamReceipt",
    "MetaProxyRoutingReceipt",
    "MetaProxyStatus",
    "RoutingPlane",
    "WorkloadPolicy",
    # §D5 routing intent
    "RoutingIntent",
    "assert_routing_receipt_matches_intent",
    # §D9 consent gating (tractable slice -- sponsor budget/usage remain
    # BLOCKED on ADR-0025b)
    "CLOUD_ROUTING_CONSENT_KIND",
    "assert_consent_for_routing_intent",
    "has_valid_consent_grant",
    "intent_touches_plane",
    "is_consent_grant_valid",
    # §D6 authentication
    "DEFAULT_META_PROXY_TOKEN_ENV_VAR",
    "LocalBearerToken",
    "WorkloadCapabilityClaims",
    "WorkloadCapability",
    "ProxyCredential",
    "LocalBearerTokenCredentialProvider",
    # §D8 streaming
    "chat_completions_stream",
    "MetaProxyStreamEnvelope",
    "MetaProxyStreamMeta",
    "DEFAULT_PROXY_CONNECT_TIMEOUT_MS",
    "ProxyTimeBudget",
    "ResolvedProxyTimeBudget",
    "resolve_proxy_time_budget",
]
