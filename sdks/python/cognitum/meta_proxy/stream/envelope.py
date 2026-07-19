"""``MetaProxyStreamEnvelope[E]`` (ADR-0025a §D8): "Chat and Messages use
ADR-0024a's lossless protocol streams and add plane and Proxy version
metadata." Rather than adding fields to the frozen ``MetaLlmStreamEnvelope``
shape (:mod:`cognitum.meta_llm.stream.envelope` -- "do not add fields
without an ADR update"), this wraps it with a ``proxy_meta`` facet carrying
exactly the Proxy-specific evidence: product/protocol version (from the
response headers, same as non-streaming ``MetaProxyResponseMeta``) and the
routing/upstream receipts once observed on the wire (ADR-0025a §D4/§D7).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from cognitum.meta_llm.stream.envelope import MetaLlmStreamEnvelope
from cognitum.meta_llm.stream.openai_events import OpenAiStreamEvent
from cognitum.meta_proxy.envelope import MetaProxyUpstreamReceipt
from cognitum.meta_proxy.status import MetaProxyRoutingReceipt


@dataclass(frozen=True)
class MetaProxyStreamMeta:
    """Proxy-specific metadata layered onto every streamed envelope (ADR-0025a §D8)."""

    product_version: str | None = None
    protocol_version: str | None = None
    #: Plane-routing evidence observed so far on this stream (ADR-0025a §D4).
    #: ``None`` until the wire payload carrying ``cognitum_routing_receipt``
    #: arrives (typically, but not necessarily, the terminal chunk) -- once
    #: observed, every subsequently-yielded envelope carries it.
    routing_receipt: MetaProxyRoutingReceipt | None = None
    #: Upstream (Cognitum-cloud) usage/receipt evidence, once observed (ADR-0025a §D7/§D8).
    upstream_receipt: MetaProxyUpstreamReceipt | None = None


@dataclass(frozen=True)
class MetaProxyStreamEnvelope:
    """Every streamed envelope from ``MetaProxyClient.chat.completions_stream`` (ADR-0025a §D8).

    Composition rather than inheritance of ``MetaLlmStreamEnvelope`` (a
    frozen dataclass) -- ``inner`` holds the reused ADR-0024a envelope
    verbatim (``event``/``sequence``/``received_at``/``request_id``/
    ``raw_event_name``/``unknown_fields``), and ``proxy_meta`` carries the
    Proxy-only facet ADR-0025a §D8 adds on top.
    """

    inner: MetaLlmStreamEnvelope[OpenAiStreamEvent]
    proxy_meta: MetaProxyStreamMeta

    @property
    def event(self) -> OpenAiStreamEvent:
        return self.inner.event

    @property
    def sequence(self) -> int:
        return self.inner.sequence

    @property
    def received_at(self) -> str:
        return self.inner.received_at

    @property
    def request_id(self) -> str:
        return self.inner.request_id

    @property
    def raw_event_name(self) -> str | None:
        return self.inner.raw_event_name

    @property
    def unknown_fields(self) -> dict[str, Any] | None:
        return self.inner.unknown_fields


__all__ = ["MetaProxyStreamEnvelope", "MetaProxyStreamMeta"]
