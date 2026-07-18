"""Meta Proxy client (ADR-0025a). Product namespace per ADR-0019 §D2:
``cognitum.meta_proxy``.

Issue #61 / M3 start: ``MetaProxyClient`` construction (§D3) and real
``status()`` / ``capabilities()`` implementations (§D4). Data-plane
forwarding (§D5-§D9) and loopback/browser security beyond loopback-origin
construction validation (§D10) are deliberately out of scope -- see
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

from cognitum.meta_proxy.client import CapabilitiesResult, MetaProxyClient
from cognitum.meta_proxy.config import (
    DEFAULT_META_PROXY_ORIGIN,
    MetaProxyClientConfig,
    MetaProxyTelemetryEvent,
    MetaProxyTelemetryHooks,
)
from cognitum.meta_proxy.envelope import (
    MetaProxyResponseMeta,
    MetaProxyResult,
    MetaProxyUpstreamReceipt,
)
from cognitum.meta_proxy.status import (
    MetaProxyRoutingReceipt,
    MetaProxyStatus,
    RoutingPlane,
    WorkloadPolicy,
)

__all__ = [
    "MetaProxyClient",
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
]
