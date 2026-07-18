"""Streaming facades for Meta LLM (ADR-0024a §D5). Issue #58 / M2
continuation lands `chat.completions` streaming only this pass; Anthropic
Messages and Responses streaming are deferred follow-ups reusing
:mod:`cognitum.sse`.
"""

from __future__ import annotations

from cognitum.meta_llm.stream.chat_completions_stream import chat_completions_stream
from cognitum.meta_llm.stream.envelope import (
    ChatCompletionsStreamAccumulator,
    ChatCompletionsStreamSnapshot,
    MetaLlmStreamEnvelope,
)
from cognitum.meta_llm.stream.openai_events import (
    DecodedOpenAiSseEvent,
    OpenAiContentDeltaEvent,
    OpenAiDoneEvent,
    OpenAiFinishReasonEvent,
    OpenAiReceiptEvent,
    OpenAiRoleEvent,
    OpenAiStreamErrorEvent,
    OpenAiStreamErrorPayload,
    OpenAiStreamEvent,
    OpenAiToolCallDeltaEvent,
    OpenAiUsageEvent,
    UnknownStreamEvent,
    decode_openai_sse_event,
)

__all__ = [
    "chat_completions_stream",
    "MetaLlmStreamEnvelope",
    "ChatCompletionsStreamAccumulator",
    "ChatCompletionsStreamSnapshot",
    "OpenAiRoleEvent",
    "OpenAiContentDeltaEvent",
    "OpenAiToolCallDeltaEvent",
    "OpenAiFinishReasonEvent",
    "OpenAiUsageEvent",
    "OpenAiReceiptEvent",
    "OpenAiStreamErrorPayload",
    "OpenAiStreamErrorEvent",
    "OpenAiDoneEvent",
    "UnknownStreamEvent",
    "OpenAiStreamEvent",
    "DecodedOpenAiSseEvent",
    "decode_openai_sse_event",
]
