"""Streaming facades for Meta LLM (ADR-0024a §D5). Issue #58 / M2
continuation: `chat.completions` streaming (PR #88) and, this pass,
Anthropic Messages streaming (item 2 of the tracked "what's left" list) --
both wired onto the same generic :mod:`cognitum.sse` parser. Responses
streaming remains a deferred follow-up.
"""

from __future__ import annotations

from cognitum.meta_llm.stream.anthropic_events import (
    AnthropicContentBlockDeltaEvent,
    AnthropicContentBlockStartEvent,
    AnthropicContentBlockStopEvent,
    AnthropicMessageDeltaEvent,
    AnthropicMessageStartEvent,
    AnthropicMessageStopEvent,
    AnthropicPingEvent,
    AnthropicReceiptEvent,
    AnthropicStreamErrorEvent,
    AnthropicStreamErrorPayload,
    AnthropicStreamEvent,
    AnthropicStreamMessageStart,
    DecodedAnthropicSseEvent,
    decode_anthropic_sse_event,
)
from cognitum.meta_llm.stream.chat_completions_stream import chat_completions_stream
from cognitum.meta_llm.stream.envelope import (
    ChatCompletionsStreamAccumulator,
    ChatCompletionsStreamSnapshot,
    MetaLlmStreamEnvelope,
)
from cognitum.meta_llm.stream.messages_stream import messages_stream
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
    "messages_stream",
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
    "AnthropicMessageStartEvent",
    "AnthropicStreamMessageStart",
    "AnthropicContentBlockStartEvent",
    "AnthropicContentBlockDeltaEvent",
    "AnthropicContentBlockStopEvent",
    "AnthropicMessageDeltaEvent",
    "AnthropicMessageStopEvent",
    "AnthropicPingEvent",
    "AnthropicStreamErrorPayload",
    "AnthropicStreamErrorEvent",
    "AnthropicReceiptEvent",
    "AnthropicStreamEvent",
    "DecodedAnthropicSseEvent",
    "decode_anthropic_sse_event",
]
