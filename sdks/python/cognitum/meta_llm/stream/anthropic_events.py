"""Anthropic ``messages`` streaming event types (ADR-0024a §D5, issue #58
M2 continuation -- item 2 of the tracked "what's left" list). Mirrors
``.openai_events``'s decode discipline exactly, but for the Anthropic
Messages wire protocol: ``message_start``, ``content_block_start``,
``content_block_delta``, ``content_block_stop``, ``message_delta``,
``message_stop``, ``ping``, and a wire-level ``error`` event. Any
recognized SSE frame whose payload shape this decoder does not understand
falls back to :class:`UnknownStreamEvent` rather than raising -- same
contract as the OpenAI decoder.

Unlike OpenAI chat-completions chunks (which carry no ``event:`` field and
pack multiple facets into one JSON object), Anthropic's wire sets a real
SSE ``event:`` name that duplicates the JSON payload's own ``"type"``
field (ADR-0024a §D5 ground truth). This decoder switches on the JSON
payload's ``"type"`` (falling back to ``raw.event`` only if the JSON
itself has none) so a well-formed payload is never hidden by a
mismatched/missing ``event:`` field -- the JSON body is authoritative,
exactly as it is for the OpenAI decoder's ``choices[].delta`` shape.

``ping`` is modeled as its own recognized variant (:class:`AnthropicPingEvent`),
NOT ``unknown`` -- it carries no payload but is a real, expected keepalive
frame, not a decode failure.

The Cognitum receipt facet (``cognitum_receipt``) is decoded from whichever
event payload carries it, same top-level-key check as
``decode_openai_sse_event`` -- ADR-0024a treats the receipt facet as
protocol-uniform, not chat-completions-specific.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal

from cognitum.meta_llm.types.anthropic import AnthropicContentBlock, AnthropicUsage
from cognitum.meta_llm.types.receipt import MetaLlmReceipt, parse_meta_llm_receipt
from cognitum.sse import SseEvent


@dataclass(frozen=True)
class AnthropicStreamMessageStart:
    """The ``message`` object embedded in a ``message_start`` event -- a
    message whose content/usage are still being filled in.
    """

    id: str
    role: str
    model: str
    usage: AnthropicUsage
    content: list[AnthropicContentBlock] = field(default_factory=list)
    stop_reason: str | None = None
    stop_sequence: str | None = None


@dataclass(frozen=True)
class AnthropicMessageStartEvent:
    message: AnthropicStreamMessageStart
    type: Literal["message_start"] = "message_start"


@dataclass(frozen=True)
class AnthropicContentBlockStartEvent:
    """The content block a ``content_block_start`` event opens at
    ``index`` -- fields fill in via subsequent ``content_block_delta``s.
    ``content_block`` reuses the same ``{"type": "text", ...}`` /
    ``{"type": "tool_use", ...}`` shape as :data:`AnthropicContentBlock`.
    """

    index: int
    content_block: AnthropicContentBlock
    type: Literal["content_block_start"] = "content_block_start"


@dataclass(frozen=True)
class AnthropicContentBlockDeltaEvent:
    index: int
    delta: dict[str, Any]
    type: Literal["content_block_delta"] = "content_block_delta"


@dataclass(frozen=True)
class AnthropicContentBlockStopEvent:
    index: int
    type: Literal["content_block_stop"] = "content_block_stop"


@dataclass(frozen=True)
class AnthropicMessageDeltaEvent:
    delta: dict[str, Any]
    usage: dict[str, int] | None = None
    type: Literal["message_delta"] = "message_delta"


@dataclass(frozen=True)
class AnthropicMessageStopEvent:
    """The wire terminal condition for a successful Anthropic Messages
    stream -- there is no ``[DONE]`` sentinel.
    """

    type: Literal["message_stop"] = "message_stop"


@dataclass(frozen=True)
class AnthropicPingEvent:
    """Keepalive heartbeat. Carries no payload; recognized deliberately
    rather than falling back to :class:`UnknownStreamEvent`.
    """

    type: Literal["ping"] = "ping"


@dataclass(frozen=True)
class AnthropicStreamErrorPayload:
    type: str
    message: str


@dataclass(frozen=True)
class AnthropicStreamErrorEvent:
    """A wire-level terminal error event embedded in the SSE stream itself
    (``data: {"type":"error","error":{...}}``).
    """

    error: AnthropicStreamErrorPayload
    type: Literal["error"] = "error"


@dataclass(frozen=True)
class AnthropicReceiptEvent:
    receipt: MetaLlmReceipt
    type: Literal["receipt"] = "receipt"


@dataclass(frozen=True)
class UnknownStreamEvent:
    """A syntactically valid SSE event whose payload this decoder does not
    recognize. Never a crash.
    """

    raw: Any
    type: Literal["unknown"] = "unknown"


AnthropicStreamEvent = (
    AnthropicMessageStartEvent
    | AnthropicContentBlockStartEvent
    | AnthropicContentBlockDeltaEvent
    | AnthropicContentBlockStopEvent
    | AnthropicMessageDeltaEvent
    | AnthropicMessageStopEvent
    | AnthropicPingEvent
    | AnthropicStreamErrorEvent
    | AnthropicReceiptEvent
    | UnknownStreamEvent
)

#: Top-level JSON keys this decoder understands; everything else is preserved as ``unknown_fields``.
_KNOWN_TOP_LEVEL_KEYS = {
    "type",
    "message",
    "index",
    "content_block",
    "delta",
    "usage",
    "error",
    "cognitum_receipt",
}


@dataclass
class DecodedAnthropicSseEvent:
    events: list[AnthropicStreamEvent]
    unknown_fields: dict[str, Any] | None = None


def _str_field(obj: Any, key: str, default: str = "") -> str:
    # A local variable (rather than re-calling ``obj.get(key)`` inside the
    # ternary) so mypy can actually narrow it via `isinstance` -- narrowing
    # does not apply across repeated call expressions.
    value = obj.get(key)
    return value if isinstance(value, str) else default


def _opt_str_field(obj: Any, key: str) -> str | None:
    value = obj.get(key)
    return value if isinstance(value, str) else None


def _int_field(obj: Any, key: str, default: int = 0) -> int:
    value = obj.get(key)
    return value if isinstance(value, int) else default


def _dict_field(obj: Any, key: str) -> dict[str, Any]:
    value = obj.get(key)
    return value if isinstance(value, dict) else {}


def _list_field(obj: Any, key: str) -> list[Any]:
    value = obj.get(key)
    return value if isinstance(value, list) else []


def _decode_content_block(raw: Any) -> AnthropicContentBlock | None:
    if not isinstance(raw, dict):
        return None
    block_type = raw.get("type")
    if block_type == "text":
        return AnthropicContentBlock(type="text", text=_str_field(raw, "text"))
    if block_type == "tool_use":
        return AnthropicContentBlock(
            type="tool_use",
            id=_str_field(raw, "id"),
            name=_str_field(raw, "name"),
            input=_dict_field(raw, "input"),
        )
    return None


def _decode_message_start(raw: Any) -> AnthropicStreamMessageStart | None:
    if not isinstance(raw, dict):
        return None
    usage_raw = _dict_field(raw, "usage")
    decoded_blocks = (_decode_content_block(item) for item in _list_field(raw, "content"))
    content = [block for block in decoded_blocks if block is not None]
    return AnthropicStreamMessageStart(
        id=_str_field(raw, "id"),
        role=_str_field(raw, "role", "assistant"),
        model=_str_field(raw, "model"),
        content=content,
        stop_reason=_opt_str_field(raw, "stop_reason"),
        stop_sequence=_opt_str_field(raw, "stop_sequence"),
        usage=AnthropicUsage(
            input_tokens=_int_field(usage_raw, "input_tokens"),
            output_tokens=_int_field(usage_raw, "output_tokens"),
        ),
    )


def decode_anthropic_sse_event(raw: SseEvent) -> DecodedAnthropicSseEvent:
    """Decode one generic :class:`~cognitum.sse.SseEvent` into zero or more
    :data:`AnthropicStreamEvent` objects. Never raises -- malformed JSON or
    an unrecognized shape becomes an :class:`UnknownStreamEvent` (same
    contract as :func:`~cognitum.meta_llm.stream.openai_events.decode_openai_sse_event`).
    """
    try:
        parsed = json.loads(raw.data)
    except (json.JSONDecodeError, ValueError):
        return DecodedAnthropicSseEvent(events=[UnknownStreamEvent(raw=raw.data)])

    if not isinstance(parsed, dict):
        return DecodedAnthropicSseEvent(events=[UnknownStreamEvent(raw=parsed)])

    events: list[AnthropicStreamEvent] = []
    event_type = parsed.get("type") if isinstance(parsed.get("type"), str) else raw.event

    if event_type == "message_start":
        message = _decode_message_start(parsed.get("message"))
        if message is not None:
            events.append(AnthropicMessageStartEvent(message=message))
    elif event_type == "content_block_start":
        content_block = _decode_content_block(parsed.get("content_block"))
        if content_block is not None:
            index = parsed.get("index")
            events.append(
                AnthropicContentBlockStartEvent(
                    index=index if isinstance(index, int) else 0,
                    content_block=content_block,
                )
            )
    elif event_type == "content_block_delta":
        delta_raw = parsed.get("delta")
        delta_type = delta_raw.get("type") if isinstance(delta_raw, dict) else None
        if isinstance(delta_raw, dict) and delta_type in ("text_delta", "input_json_delta"):
            index = parsed.get("index")
            events.append(
                AnthropicContentBlockDeltaEvent(
                    index=index if isinstance(index, int) else 0,
                    delta=delta_raw,
                )
            )
    elif event_type == "content_block_stop":
        index = parsed.get("index")
        events.append(AnthropicContentBlockStopEvent(index=index if isinstance(index, int) else 0))
    elif event_type == "message_delta":
        events.append(
            AnthropicMessageDeltaEvent(
                delta=_dict_field(parsed, "delta"),
                usage=_dict_field(parsed, "usage") or None,
            )
        )
    elif event_type == "message_stop":
        events.append(AnthropicMessageStopEvent())
    elif event_type == "ping":
        events.append(AnthropicPingEvent())
    elif event_type == "error":
        error_raw = _dict_field(parsed, "error")
        events.append(
            AnthropicStreamErrorEvent(
                error=AnthropicStreamErrorPayload(
                    type=_str_field(error_raw, "type", "unknown_error"),
                    message=_str_field(error_raw, "message", "unknown error"),
                )
            )
        )

    # ADR-0024a: the Cognitum receipt facet is protocol-uniform -- decode it
    # from whichever event payload carries the top-level key, same as the
    # OpenAI decoder, regardless of which `type` this event otherwise was.
    if "cognitum_receipt" in parsed:
        receipt = parse_meta_llm_receipt(parsed["cognitum_receipt"])
        if receipt is not None:
            events.append(AnthropicReceiptEvent(receipt=receipt))

    if not events:
        events.append(UnknownStreamEvent(raw=parsed))

    unknown_fields = {k: v for k, v in parsed.items() if k not in _KNOWN_TOP_LEVEL_KEYS}
    return DecodedAnthropicSseEvent(events=events, unknown_fields=unknown_fields or None)


__all__ = [
    "AnthropicStreamMessageStart",
    "AnthropicMessageStartEvent",
    "AnthropicContentBlockStartEvent",
    "AnthropicContentBlockDeltaEvent",
    "AnthropicContentBlockStopEvent",
    "AnthropicMessageDeltaEvent",
    "AnthropicMessageStopEvent",
    "AnthropicPingEvent",
    "AnthropicStreamErrorPayload",
    "AnthropicStreamErrorEvent",
    "AnthropicReceiptEvent",
    "UnknownStreamEvent",
    "AnthropicStreamEvent",
    "DecodedAnthropicSseEvent",
    "decode_anthropic_sse_event",
]
