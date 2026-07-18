"""OpenAI-style wire types (ADR-0024a §D3): chat completions, legacy
completions, Responses, and embeddings. Request/response shapes only -- no
HTTP call logic lands in this pass (issue #58 / M2 scope).

The SDK does not invent a universal prompt object (ADR-0024a §D3): content
blocks, tools, tool choices, finish reasons, and usage stay in this native
OpenAI-compatible namespace rather than a cross-protocol shared shape.

Dataclasses model the request/response envelopes; ``TypedDict`` models the
loosely-structured nested JSON (content parts, tool calls) to keep
construction ergonomic (``{"type": "text", "text": "..."}``) while still
type-checking under mypy.

Field names here are snake_case, matching both Python convention and the
wire's own snake_case (``max_tokens``, ``top_p``, ...) -- unlike the Node
SDK's camelCase, no case mapping is needed here once HTTP logic lands.

``routing_controls`` (ADR-0024b §D2, issue #59) is added to
``ChatCompletionRequest``, ``LegacyCompletionRequest``, and
``ResponsesRequest`` -- the same three protocol request shapes ADR-0024b's
issue names, alongside ``AnthropicMessageRequest`` in ``.anthropic``.
``EmbeddingRequest`` deliberately does NOT get this field: it is out of
ADR-0024b D11 step 1's scope.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, TypedDict

from cognitum.meta_llm.types.routing import MetaLlmRoutingControls


class ChatImageUrl(TypedDict, total=False):
    url: str
    detail: Literal["auto", "low", "high"]


class ChatContentPart(TypedDict, total=False):
    type: Literal["text", "image_url"]
    text: str
    image_url: ChatImageUrl


class ChatToolCallFunction(TypedDict):
    name: str
    arguments: str


class ChatToolCall(TypedDict):
    id: str
    type: Literal["function"]
    function: ChatToolCallFunction


@dataclass
class ChatMessage:
    role: Literal["system", "user", "assistant", "tool", "developer"]
    content: str | list[ChatContentPart] | None
    name: str | None = None
    tool_call_id: str | None = None
    tool_calls: list[ChatToolCall] | None = None


class ChatToolFunctionDef(TypedDict, total=False):
    name: str
    description: str
    parameters: dict[str, object]


class ChatToolDefinition(TypedDict):
    type: Literal["function"]
    function: ChatToolFunctionDef


ChatToolChoice = str | dict[str, object]
"""``"none" | "auto" | "required" | {"type": "function", "function": {"name": ...}}``."""


@dataclass
class ChatCompletionRequest:
    """``POST /v1/chat/completions`` request. Server currently caps ``n = 1``."""

    model: str
    messages: list[ChatMessage]
    max_tokens: int | None = None
    temperature: float | None = None
    top_p: float | None = None
    n: Literal[1] | None = None
    stream: bool | None = None
    stop: str | list[str] | None = None
    presence_penalty: float | None = None
    frequency_penalty: float | None = None
    logit_bias: dict[str, float] | None = None
    user: str | None = None
    tools: list[ChatToolDefinition] | None = None
    tool_choice: ChatToolChoice | None = None
    response_format: dict[str, str] | None = None
    seed: int | None = None
    #: ADR-0024b §D2. Body controls win over any ``X-Cognitum-*`` header.
    routing_controls: MetaLlmRoutingControls | None = None


@dataclass(frozen=True)
class ChatCompletionUsage:
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


@dataclass(frozen=True)
class ChatCompletionChoice:
    index: int
    message: ChatMessage
    finish_reason: Literal["stop", "length", "tool_calls", "content_filter"] | None
    logprobs: object | None = None


@dataclass(frozen=True)
class ChatCompletion:
    """``POST /v1/chat/completions`` response."""

    id: str
    object: Literal["chat.completion"]
    created: int
    model: str
    choices: list[ChatCompletionChoice]
    usage: ChatCompletionUsage | None = None
    system_fingerprint: str | None = None


@dataclass
class LegacyCompletionRequest:
    """``POST /v1/completions`` (legacy) request."""

    model: str
    prompt: str | list[str]
    max_tokens: int | None = None
    temperature: float | None = None
    top_p: float | None = None
    n: Literal[1] | None = None
    stream: bool | None = None
    logprobs: int | None = None
    echo: bool | None = None
    stop: str | list[str] | None = None
    presence_penalty: float | None = None
    frequency_penalty: float | None = None
    best_of: int | None = None
    logit_bias: dict[str, float] | None = None
    user: str | None = None
    #: ADR-0024b §D2. Body controls win over any ``X-Cognitum-*`` header.
    routing_controls: MetaLlmRoutingControls | None = None


@dataclass(frozen=True)
class LegacyCompletionChoice:
    text: str
    index: int
    finish_reason: Literal["stop", "length", "content_filter"] | None
    logprobs: object | None = None


@dataclass(frozen=True)
class LegacyCompletion:
    """``POST /v1/completions`` (legacy) response."""

    id: str
    object: Literal["text_completion"]
    created: int
    model: str
    choices: list[LegacyCompletionChoice]
    usage: ChatCompletionUsage | None = None


class ResponsesOutputItem(TypedDict, total=False):
    """Discriminated Responses output item. Kept intentionally partial pending GA."""

    type: Literal["message", "reasoning", "tool_call"]
    id: str
    role: Literal["assistant"]
    content: list[ChatContentPart]
    summary: list[str]
    name: str
    arguments: str


@dataclass
class ResponsesRequest:
    """``POST /v1/responses`` request.

    Current server is stateless: callers resend conversation input.
    ``previous_response_id`` is preview and MUST NOT be described as
    recovery (ADR-0024a §D3).
    """

    model: str
    input: str | list[ChatContentPart]
    instructions: str | None = None
    previous_response_id: str | None = None
    max_output_tokens: int | None = None
    temperature: float | None = None
    top_p: float | None = None
    stream: bool | None = None
    tools: list[ChatToolDefinition] | None = None
    tool_choice: ChatToolChoice | None = None
    metadata: dict[str, str] | None = None
    #: ADR-0024b §D2. Body controls win over any ``X-Cognitum-*`` header.
    routing_controls: MetaLlmRoutingControls | None = None


@dataclass(frozen=True)
class ResponsesResponse:
    """``POST /v1/responses`` response."""

    id: str
    object: Literal["response"]
    created_at: int
    model: str
    status: Literal["completed", "in_progress", "failed", "incomplete"]
    output: list[ResponsesOutputItem]
    usage: ChatCompletionUsage | None = None
    previous_response_id: str | None = None
    incomplete_details: dict[str, str] | None = None


@dataclass
class EmbeddingRequest:
    """``POST /v1/embeddings`` request."""

    model: str
    input: str | list[str]
    encoding_format: Literal["float", "base64"] | None = None
    dimensions: int | None = None
    user: str | None = None


@dataclass(frozen=True)
class EmbeddingDatum:
    object: Literal["embedding"]
    embedding: list[float]
    index: int


@dataclass(frozen=True)
class EmbeddingUsage:
    prompt_tokens: int
    total_tokens: int


@dataclass(frozen=True)
class EmbeddingResponse:
    """``POST /v1/embeddings`` response."""

    object: Literal["list"]
    data: list[EmbeddingDatum]
    model: str
    usage: EmbeddingUsage


__all__ = [
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
]
