"""Result and metadata envelope (ADR-0025a §D3).

Deliberately its OWN shape rather than a reuse of ``MetaLlmResult``
(:mod:`cognitum.meta_llm.envelope`) -- ADR-0025a §D3 specifies distinct
fields (``product_version``, ``routing_receipt``, ``upstream_receipt``) that
``MetaLlmResult`` does not have, reflecting that every Proxy response must
be able to carry plane-routing evidence (§D4) that a direct Meta LLM
response never needs.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Generic, TypeVar

if TYPE_CHECKING:
    from cognitum.meta_proxy.status import MetaProxyRoutingReceipt

#: Placeholder for an upstream (Cognitum-cloud) receipt forwarded through the
#: Proxy (ADR-0025a §D7, deferred). Kept as ``Any`` rather than
#: ``dict[str, Any]`` so callers cannot treat an absent receipt as a shaped,
#: empty value -- same rationale as ``MetaLlmReceipt``.
MetaProxyUpstreamReceipt = Any

T = TypeVar("T")


@dataclass(frozen=True)
class MetaProxyResponseMeta:
    """Per-response metadata carried alongside every ``MetaProxyResult`` (ADR-0025a §D3)."""

    request_id: str
    http_status: int
    product_version: str | None = None
    protocol_version: str | None = None
    #: Seconds until retry is safe (standard ``Retry-After`` semantics) --
    #: note this is ``retry_after``, NOT ``retry_after_ms`` like
    #: ``MetaLlmResponseMeta`` (ADR-0025a §D3 names the field
    #: ``retry_after``, without an ``_ms`` suffix).
    retry_after: float | None = None
    #: Plane-routing evidence for this response (ADR-0025a §D4). Reserved
    #: for §D7 -- ``status()``/``capabilities()`` this pass never populate it.
    routing_receipt: MetaProxyRoutingReceipt | None = None
    upstream_receipt: MetaProxyUpstreamReceipt | None = None
    warnings: list[str] | None = None
    unknown_headers: dict[str, str] | None = None


@dataclass(frozen=True)
class MetaProxyResult(Generic[T]):
    """Envelope wrapping every MetaProxyClient operation result (ADR-0025a §D3)."""

    data: T
    meta: MetaProxyResponseMeta


__all__ = ["MetaProxyUpstreamReceipt", "MetaProxyResponseMeta", "MetaProxyResult"]
