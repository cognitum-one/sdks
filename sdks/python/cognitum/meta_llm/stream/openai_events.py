"""OpenAI ``chat.completions`` streaming event types (ADR-0024a §D5): role,
content delta, tool-call fragments, finish reason, trailing usage, the
Cognitum receipt, a terminal wire-level error event, and the ``[DONE]``
sentinel. Any recognized-but-not-decoded shape falls back to
:class:`UnknownStreamEvent` rather than raising.

The receipt facet (``OpenAiReceiptEvent``) now carries the concrete
ADR-0024b §D3 ``MetaLlmReceipt`` shape (issue #59, D11 migration step 1)
rather than the earlier generic ADR-0028 ``ExecutionReceipt`` stub -- this
is the "receipt field ... already anticipated" slot the streaming pass
(PR #88) reserved for it.

One raw SSE ``data:`` payload can decode into *multiple* facets (e.g. one
chunk carrying both a content delta and, on the last chunk, a finish
reason) -- :func:`decode_openai_sse_event` returns all of them, each
becoming its own
:class:`cognitum.meta_llm.stream.envelope.MetaLlmStreamEnvelope` with its
own sequence number, preserving per-facet granularity rather than
flattening a chunk into one opaque event.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Literal

from cognitum.meta_llm.types.openai import ChatCompletionUsage
from cognitum.meta_llm.types.receipt import MetaLlmReceipt, parse_meta_llm_receipt
from cognitum.sse import SseEvent


@dataclass(frozen=True)
class OpenAiRoleEvent:
    index: int
    role: str
    type: Literal["role"] = "role"


@dataclass(frozen=True)
class OpenAiContentDeltaEvent:
    index: int
    delta: str
    type: Literal["content_delta"] = "content_delta"


@dataclass(frozen=True)
class OpenAiToolCallDeltaEvent:
    index: int
    tool_call_index: int
    id: str | None = None
    function_name: str | None = None
    arguments_delta: str | None = None
    type: Literal["tool_call_delta"] = "tool_call_delta"


@dataclass(frozen=True)
class OpenAiFinishReasonEvent:
    index: int
    finish_reason: str
    type: Literal["finish_reason"] = "finish_reason"


@dataclass(frozen=True)
class OpenAiUsageEvent:
    usage: ChatCompletionUsage
    type: Literal["usage"] = "usage"


@dataclass(frozen=True)
class OpenAiReceiptEvent:
    receipt: MetaLlmReceipt
    type: Literal["receipt"] = "receipt"


@dataclass(frozen=True)
class OpenAiStreamErrorPayload:
    message: str
    type: str | None = None
    code: str | None = None
    param: str | None = None


@dataclass(frozen=True)
class OpenAiStreamErrorEvent:
    """A wire-level terminal error event embedded in the SSE stream itself
    (``data: {"error": {...}}``).
    """

    error: OpenAiStreamErrorPayload
    type: Literal["error"] = "error"


@dataclass(frozen=True)
class OpenAiDoneEvent:
    """The literal ``data: [DONE]`` sentinel that closes a successful
    OpenAI chat-completions stream.
    """

    type: Literal["done"] = "done"


@dataclass(frozen=True)
class UnknownStreamEvent:
    """A syntactically valid SSE event whose payload this decoder does not
    recognize. Never a crash.
    """

    raw: Any
    type: Literal["unknown"] = "unknown"


OpenAiStreamEvent = (
    OpenAiRoleEvent
    | OpenAiContentDeltaEvent
    | OpenAiToolCallDeltaEvent
    | OpenAiFinishReasonEvent
    | OpenAiUsageEvent
    | OpenAiReceiptEvent
    | OpenAiStreamErrorEvent
    | OpenAiDoneEvent
    | UnknownStreamEvent
)

#: Top-level JSON keys this decoder understands; everything else is preserved as ``unknown_fields``.
_KNOWN_TOP_LEVEL_KEYS = {
    "id",
    "object",
    "created",
    "model",
    "choices",
    "usage",
    "cognitum_receipt",
    "system_fingerprint",
    "error",
}


@dataclass
class DecodedOpenAiSseEvent:
    events: list[OpenAiStreamEvent]
    unknown_fields: dict[str, Any] | None = None


def decode_openai_sse_event(raw: SseEvent) -> DecodedOpenAiSseEvent:
    """Decode one generic :class:`~cognitum.sse.SseEvent` into zero or more
    :class:`OpenAiStreamEvent` objects. Never raises -- malformed JSON or an
    unrecognized shape becomes an :class:`UnknownStreamEvent` (ADR-0024a
    §D5: "Unknown valid events become ``UnknownStreamEvent``").
    """
    raw_data = raw.data
    trimmed = raw_data.strip()
    if trimmed == "[DONE]":
        return DecodedOpenAiSseEvent(events=[OpenAiDoneEvent()])

    try:
        parsed = json.loads(raw_data)
    except (json.JSONDecodeError, ValueError):
        return DecodedOpenAiSseEvent(events=[UnknownStreamEvent(raw=raw_data)])

    if not isinstance(parsed, dict):
        return DecodedOpenAiSseEvent(events=[UnknownStreamEvent(raw=parsed)])

    events: list[OpenAiStreamEvent] = []

    error = parsed.get("error")
    if isinstance(error, dict):
        message = error.get("message")
        message = message if isinstance(message, str) else "unknown error"
        error_type = error.get("type")
        error_type = error_type if isinstance(error_type, str) else None
        error_code = error.get("code")
        error_code = error_code if isinstance(error_code, str) else None
        error_param = error.get("param")
        error_param = error_param if isinstance(error_param, str) else None
        events.append(
            OpenAiStreamErrorEvent(
                error=OpenAiStreamErrorPayload(
                    message=message,
                    type=error_type,
                    code=error_code,
                    param=error_param,
                )
            )
        )

    choices = parsed.get("choices")
    if isinstance(choices, list):
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            index_raw = choice.get("index")
            index: int = index_raw if isinstance(index_raw, int) else 0
            delta_raw = choice.get("delta")
            delta: dict[str, Any] = delta_raw if isinstance(delta_raw, dict) else {}

            role = delta.get("role")
            if isinstance(role, str):
                events.append(OpenAiRoleEvent(index=index, role=role))
            content = delta.get("content")
            if isinstance(content, str) and len(content) > 0:
                events.append(OpenAiContentDeltaEvent(index=index, delta=content))
            tool_calls = delta.get("tool_calls")
            if isinstance(tool_calls, list):
                for tool_call in tool_calls:
                    if not isinstance(tool_call, dict):
                        continue
                    fn = tool_call.get("function")
                    fn = fn if isinstance(fn, dict) else {}
                    tool_call_index = tool_call.get("index")
                    tool_call_index = tool_call_index if isinstance(tool_call_index, int) else 0
                    tool_call_id = tool_call.get("id")
                    tool_call_id = tool_call_id if isinstance(tool_call_id, str) else None
                    fn_name = fn.get("name")
                    fn_name = fn_name if isinstance(fn_name, str) else None
                    fn_args = fn.get("arguments")
                    fn_args = fn_args if isinstance(fn_args, str) else None
                    events.append(
                        OpenAiToolCallDeltaEvent(
                            index=index,
                            tool_call_index=tool_call_index,
                            id=tool_call_id,
                            function_name=fn_name,
                            arguments_delta=fn_args,
                        )
                    )
            finish_reason = choice.get("finish_reason")
            if isinstance(finish_reason, str):
                events.append(OpenAiFinishReasonEvent(index=index, finish_reason=finish_reason))

    usage = parsed.get("usage")
    if isinstance(usage, dict):
        events.append(
            OpenAiUsageEvent(
                usage=ChatCompletionUsage(
                    prompt_tokens=usage.get("prompt_tokens", 0),
                    completion_tokens=usage.get("completion_tokens", 0),
                    total_tokens=usage.get("total_tokens", 0),
                )
            )
        )

    if "cognitum_receipt" in parsed:
        receipt = parse_meta_llm_receipt(parsed["cognitum_receipt"])
        if receipt is not None:
            events.append(OpenAiReceiptEvent(receipt=receipt))

    if not events:
        events.append(UnknownStreamEvent(raw=parsed))

    unknown_fields = {k: v for k, v in parsed.items() if k not in _KNOWN_TOP_LEVEL_KEYS}
    return DecodedOpenAiSseEvent(events=events, unknown_fields=unknown_fields or None)


__all__ = [
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
