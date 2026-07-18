"""Meta LLM serving client (ADR-0024a). Product namespace per ADR-0019 §D2:
``cognitum.meta_llm``.

Issue #58 / M2 start: ``MetaLlmClient`` construction, wire types, and real
``health()`` / ``whoami()`` / ``models()`` implementations. Streaming
(§D5), the five protocol operations' HTTP logic, and ADR-0024b routing
controls are deliberately out of scope -- see follow-up issues.

Per ADR-0019 §D4, this package depends on ``cognitum.agentic`` and MUST NOT
be imported by any other product module (``cognitum.meta_proxy``,
``cognitum.metaharness``, ``cognitum.harnessaas``).

This package is imported eagerly by callers of ``cognitum.meta_llm`` but is
NOT imported by ``cognitum/__init__.py`` itself, preserving the cold-start
import graph fix from issue #20 (matching ``cognitum.agentic``'s convention)
-- cloud-only and seed-only callers never pay for this module's import cost.
"""

from __future__ import annotations

from cognitum.meta_llm.client import MetaLlmClient
from cognitum.meta_llm.config import (
    MetaLlmClientConfig,
    MetaLlmRoutingControls,
    MetaLlmSafetyControl,
    MetaLlmTelemetryEvent,
    MetaLlmTelemetryHooks,
)
from cognitum.meta_llm.discovery import (
    MetaLlmHealth,
    MetaLlmModelInfo,
    MetaLlmModelList,
    MetaLlmWhoAmI,
)
from cognitum.meta_llm.envelope import MetaLlmReceipt, MetaLlmResponseMeta, MetaLlmResult
from cognitum.meta_llm.stream import (
    ChatCompletionsStreamAccumulator,
    ChatCompletionsStreamSnapshot,
    DecodedOpenAiSseEvent,
    MetaLlmStreamEnvelope,
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
from cognitum.meta_llm.types import (
    AnthropicContentBlock,
    AnthropicImageSource,
    AnthropicMessage,
    AnthropicMessageParam,
    AnthropicMessageRequest,
    AnthropicToolChoice,
    AnthropicToolDefinition,
    AnthropicUsage,
    ChatCompletion,
    ChatCompletionChoice,
    ChatCompletionRequest,
    ChatCompletionUsage,
    ChatContentPart,
    ChatImageUrl,
    ChatMessage,
    ChatToolCall,
    ChatToolCallFunction,
    ChatToolChoice,
    ChatToolDefinition,
    ChatToolFunctionDef,
    CountTokensRequest,
    CountTokensResult,
    EmbeddingDatum,
    EmbeddingRequest,
    EmbeddingResponse,
    EmbeddingUsage,
    LegacyCompletion,
    LegacyCompletionChoice,
    LegacyCompletionRequest,
    ResponsesOutputItem,
    ResponsesRequest,
    ResponsesResponse,
)

__all__ = [
    "MetaLlmClient",
    "MetaLlmClientConfig",
    "MetaLlmRoutingControls",
    "MetaLlmSafetyControl",
    "MetaLlmTelemetryEvent",
    "MetaLlmTelemetryHooks",
    "MetaLlmHealth",
    "MetaLlmModelInfo",
    "MetaLlmModelList",
    "MetaLlmWhoAmI",
    "MetaLlmReceipt",
    "MetaLlmResponseMeta",
    "MetaLlmResult",
    # Streaming (ADR-0024a §D5)
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
    # OpenAI-style wire types
    "ChatImageUrl",
    "ChatContentPart",
    "ChatToolCallFunction",
    "ChatToolCall",
    "ChatMessage",
    "ChatToolFunctionDef",
    "ChatToolDefinition",
    "ChatToolChoice",
    "ChatCompletionRequest",
    "ChatCompletionUsage",
    "ChatCompletionChoice",
    "ChatCompletion",
    "LegacyCompletionRequest",
    "LegacyCompletionChoice",
    "LegacyCompletion",
    "ResponsesOutputItem",
    "ResponsesRequest",
    "ResponsesResponse",
    "EmbeddingRequest",
    "EmbeddingDatum",
    "EmbeddingUsage",
    "EmbeddingResponse",
    # Anthropic-style wire types
    "AnthropicImageSource",
    "AnthropicContentBlock",
    "AnthropicMessageParam",
    "AnthropicToolDefinition",
    "AnthropicToolChoice",
    "AnthropicMessageRequest",
    "AnthropicUsage",
    "AnthropicMessage",
    "CountTokensRequest",
    "CountTokensResult",
]
