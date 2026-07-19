"""Streaming facade for `MetaProxyClient` (ADR-0025a §D8). Issue #61 / M3
continuation lands `chat.completions_stream` only this pass; Anthropic
Messages streaming is a deferred follow-up reusing the same
:mod:`cognitum.sse` parser and :mod:`cognitum.meta_llm.stream.openai_events` decoder.
"""

from __future__ import annotations

from cognitum.meta_proxy.stream.chat_completions_stream import chat_completions_stream
from cognitum.meta_proxy.stream.envelope import MetaProxyStreamEnvelope, MetaProxyStreamMeta

__all__ = [
    "chat_completions_stream",
    "MetaProxyStreamEnvelope",
    "MetaProxyStreamMeta",
]
