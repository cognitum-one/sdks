"""Response-body parsing for every ``MetaLlmClient`` direct nonstream
operation (ADR-0024a §D3). Split out of ``client.py`` to keep that file
under the project's 500-line convention as the operation count grew from
two (``chat.completions``/``messages.create``, PR #86) to six (this pass
adds ``completions``, ``responses``, ``embeddings``, and
``messages.count_tokens``).

Each function takes the raw parsed-JSON ``dict`` returned by
``nonstream.post_json_idempotent`` and constructs the protocol-specific
dataclass response type (ADR-0024a §D3: "The SDK does not invent a
universal prompt object"). No field-name mapping happens elsewhere in this
pass -- the wire is already snake_case, matching these dataclasses'
convention, unlike the Node SDK's camelCase (see ``types/openai.py``'s
module docstring).
"""

from __future__ import annotations

from typing import Any

from cognitum.meta_llm.types import (
    AnthropicMessage,
    AnthropicUsage,
    ChatCompletion,
    ChatCompletionChoice,
    ChatCompletionUsage,
    ChatMessage,
    CountTokensResult,
    EmbeddingDatum,
    EmbeddingResponse,
    EmbeddingUsage,
    LegacyCompletion,
    LegacyCompletionChoice,
    ResponsesResponse,
)


def parse_chat_completion(data: dict[str, Any]) -> ChatCompletion:
    usage_data = data.get("usage")
    usage = (
        ChatCompletionUsage(
            prompt_tokens=usage_data["prompt_tokens"],
            completion_tokens=usage_data["completion_tokens"],
            total_tokens=usage_data["total_tokens"],
        )
        if usage_data
        else None
    )
    choices = [
        ChatCompletionChoice(
            index=c["index"],
            message=ChatMessage(
                role=c["message"]["role"],
                content=c["message"].get("content"),
                name=c["message"].get("name"),
                tool_call_id=c["message"].get("tool_call_id"),
                tool_calls=c["message"].get("tool_calls"),
            ),
            finish_reason=c.get("finish_reason"),
            logprobs=c.get("logprobs"),
        )
        for c in data.get("choices", [])
    ]
    return ChatCompletion(
        id=data["id"],
        object=data.get("object", "chat.completion"),
        created=data["created"],
        model=data["model"],
        choices=choices,
        usage=usage,
        system_fingerprint=data.get("system_fingerprint"),
    )


def parse_anthropic_message(data: dict[str, Any]) -> AnthropicMessage:
    usage_data = data["usage"]
    return AnthropicMessage(
        id=data["id"],
        type=data.get("type", "message"),
        role=data["role"],
        content=data.get("content", []),
        model=data["model"],
        stop_reason=data.get("stop_reason"),
        usage=AnthropicUsage(
            input_tokens=usage_data["input_tokens"],
            output_tokens=usage_data["output_tokens"],
        ),
        stop_sequence=data.get("stop_sequence"),
    )


def parse_legacy_completion(data: dict[str, Any]) -> LegacyCompletion:
    usage_data = data.get("usage")
    usage = (
        ChatCompletionUsage(
            prompt_tokens=usage_data["prompt_tokens"],
            completion_tokens=usage_data["completion_tokens"],
            total_tokens=usage_data["total_tokens"],
        )
        if usage_data
        else None
    )
    choices = [
        LegacyCompletionChoice(
            text=c["text"],
            index=c["index"],
            finish_reason=c.get("finish_reason"),
            logprobs=c.get("logprobs"),
        )
        for c in data.get("choices", [])
    ]
    return LegacyCompletion(
        id=data["id"],
        object=data.get("object", "text_completion"),
        created=data["created"],
        model=data["model"],
        choices=choices,
        usage=usage,
    )


def parse_responses_response(data: dict[str, Any]) -> ResponsesResponse:
    usage_data = data.get("usage")
    usage = (
        ChatCompletionUsage(
            prompt_tokens=usage_data["prompt_tokens"],
            completion_tokens=usage_data["completion_tokens"],
            total_tokens=usage_data["total_tokens"],
        )
        if usage_data
        else None
    )
    return ResponsesResponse(
        id=data["id"],
        object=data.get("object", "response"),
        created_at=data["created_at"],
        model=data["model"],
        status=data["status"],
        # `ResponsesOutputItem` is a `TypedDict` (a discriminated, loosely
        # structured shape) -- passed through as raw dicts, same convention
        # as `ChatContentPart`/`AnthropicContentBlock` elsewhere in this
        # package rather than constructing a dataclass per discriminant.
        output=data.get("output", []),
        usage=usage,
        previous_response_id=data.get("previous_response_id"),
        incomplete_details=data.get("incomplete_details"),
    )


def parse_embedding_response(data: dict[str, Any]) -> EmbeddingResponse:
    usage_data = data["usage"]
    items = [
        EmbeddingDatum(
            object=d.get("object", "embedding"),
            embedding=d["embedding"],
            index=d["index"],
        )
        for d in data.get("data", [])
    ]
    return EmbeddingResponse(
        object=data.get("object", "list"),
        data=items,
        model=data["model"],
        usage=EmbeddingUsage(
            prompt_tokens=usage_data["prompt_tokens"],
            total_tokens=usage_data["total_tokens"],
        ),
    )


def parse_count_tokens_result(data: dict[str, Any]) -> CountTokensResult:
    return CountTokensResult(input_tokens=data["input_tokens"])


__all__ = [
    "parse_chat_completion",
    "parse_anthropic_message",
    "parse_legacy_completion",
    "parse_responses_response",
    "parse_embedding_response",
    "parse_count_tokens_result",
]
