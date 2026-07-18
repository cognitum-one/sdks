"""Anthropic-style wire types (ADR-0024a §D3): Messages and count-tokens.

Request/response shapes only -- no HTTP call logic lands in this pass
(issue #58 / M2 scope).

Image and document content blocks are modeled for forward compatibility, but
the audited server currently rejects them (ADR-0024a Context table) --
callers MUST NOT assume they are accepted yet.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, TypedDict


class AnthropicImageSource(TypedDict):
    type: Literal["base64"]
    media_type: str
    data: str


class AnthropicContentBlock(TypedDict, total=False):
    type: Literal["text", "tool_use", "tool_result", "image"]
    text: str
    id: str
    name: str
    input: dict[str, object]
    tool_use_id: str
    content: str | list[AnthropicContentBlock]
    is_error: bool
    # Modeled for forward compatibility only -- currently rejected server-side.
    source: AnthropicImageSource


@dataclass
class AnthropicMessageParam:
    role: Literal["user", "assistant"]
    content: str | list[AnthropicContentBlock]


class AnthropicToolDefinition(TypedDict, total=False):
    name: str
    description: str
    input_schema: dict[str, object]


AnthropicToolChoice = dict[str, object]
"""``{"type": "auto"} | {"type": "any"} | {"type": "tool", "name": ...}``."""


@dataclass
class AnthropicMessageRequest:
    """``POST /v1/messages`` request. ``max_tokens`` is required by the wire shape."""

    model: str
    messages: list[AnthropicMessageParam]
    max_tokens: int
    system: str | None = None
    temperature: float | None = None
    top_p: float | None = None
    top_k: int | None = None
    stop_sequences: list[str] | None = None
    stream: bool | None = None
    tools: list[AnthropicToolDefinition] | None = None
    tool_choice: AnthropicToolChoice | None = None
    metadata: dict[str, str] | None = None


@dataclass(frozen=True)
class AnthropicUsage:
    input_tokens: int
    output_tokens: int


@dataclass(frozen=True)
class AnthropicMessage:
    """``POST /v1/messages`` response."""

    id: str
    type: Literal["message"]
    role: Literal["assistant"]
    content: list[AnthropicContentBlock]
    model: str
    stop_reason: Literal["end_turn", "max_tokens", "stop_sequence", "tool_use"] | None
    usage: AnthropicUsage
    stop_sequence: str | None = None


@dataclass
class CountTokensRequest:
    """``POST /v1/messages/count_tokens`` request.

    Mirrors the message-creation shape minus generation parameters
    (ADR-0024a §D3 Context table).
    """

    model: str
    messages: list[AnthropicMessageParam]
    system: str | None = None
    tools: list[AnthropicToolDefinition] | None = None


@dataclass(frozen=True)
class CountTokensResult:
    """``POST /v1/messages/count_tokens`` response."""

    input_tokens: int


__all__ = [
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
