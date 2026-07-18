"""Meta LLM protocol-specific wire types (ADR-0024a §D3).

Split by wire family: :mod:`.openai` (chat completions, legacy completions,
Responses, embeddings) and :mod:`.anthropic` (Messages, count-tokens).
"""

from __future__ import annotations

from cognitum.meta_llm.types.anthropic import (
    AnthropicContentBlock,
    AnthropicImageSource,
    AnthropicMessage,
    AnthropicMessageParam,
    AnthropicMessageRequest,
    AnthropicToolChoice,
    AnthropicToolDefinition,
    AnthropicUsage,
    CountTokensRequest,
    CountTokensResult,
)
from cognitum.meta_llm.types.openai import (
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
    # OpenAI-style
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
    # Anthropic-style
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
