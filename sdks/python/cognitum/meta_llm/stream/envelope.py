"""``MetaLlmStreamEnvelope[E]`` (ADR-0024a §D5's frozen streaming envelope
shape) plus a small optional text/tool accumulator over a
``chat.completions`` event stream (D5 point 2: "an optional text/tool
accumulator over that stream").
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Generic, TypeVar

from cognitum.meta_llm.stream.openai_events import OpenAiStreamEvent
from cognitum.meta_llm.types.openai import ChatCompletionUsage
from cognitum.meta_llm.types.receipt import MetaLlmReceipt

E = TypeVar("E")


@dataclass(frozen=True)
class MetaLlmStreamEnvelope(Generic[E]):
    """Wraps every parsed stream event with sequencing/provenance metadata.

    Frozen shape per ADR-0024a §D5 -- do not add fields without an ADR update.
    """

    event: E
    #: 1-based order of this event within one logical stream call.
    sequence: int
    #: ISO-8601 timestamp of when this envelope was produced locally.
    received_at: str
    request_id: str
    #: The underlying SSE ``event:`` field name, if any (OpenAI chat
    #: completions does not set one).
    raw_event_name: str | None = None
    #: Fields present on the wire payload that this decoder does not
    #: recognize -- preserved losslessly.
    unknown_fields: dict[str, Any] | None = None


@dataclass
class ChatCompletionsStreamSnapshot:
    role: str | None = None
    content_by_choice: dict[int, str] = field(default_factory=dict)
    tool_calls_by_choice: dict[int, list[dict[str, str | None]]] = field(default_factory=dict)
    finish_reason_by_choice: dict[int, str] = field(default_factory=dict)
    usage: ChatCompletionUsage | None = None
    receipt: MetaLlmReceipt | None = None
    completed: bool = False


class ChatCompletionsStreamAccumulator:
    """Accumulates a ``chat.completions`` stream's role/content/tool-call/
    finish/usage/receipt facets into one final snapshot. Works identically
    whether the stream ended successfully or was cut short -- the caller
    absorbs whatever envelopes were yielded before a terminal error and
    reads :meth:`snapshot` for the partial result (ADR-0024a §D5: partial
    state is whatever was already delivered through normal iteration, not a
    separately-reconstructed value).
    """

    def __init__(self) -> None:
        self._role: str | None = None
        self._content_by_index: dict[int, str] = {}
        self._tool_calls_by_index: dict[int, dict[int, dict[str, str | None]]] = {}
        self._finish_reason_by_index: dict[int, str] = {}
        self._usage: ChatCompletionUsage | None = None
        self._receipt: MetaLlmReceipt | None = None
        self._done = False

    def absorb(self, envelope: MetaLlmStreamEnvelope[OpenAiStreamEvent]) -> None:
        # Direct `event.type == "..."` comparisons (rather than routing
        # through a separately-typed `kind` variable) so mypy's tagged-union
        # narrowing on the `Literal[...]` discriminant actually applies to
        # `event` within each branch.
        event = envelope.event
        if event.type == "role":
            self._role = event.role
        elif event.type == "content_delta":
            existing_content = self._content_by_index.get(event.index, "")
            self._content_by_index[event.index] = existing_content + event.delta
        elif event.type == "tool_call_delta":
            by_index = self._tool_calls_by_index.setdefault(event.index, {})
            existing = by_index.setdefault(
                event.tool_call_index, {"id": None, "name": None, "arguments": ""}
            )
            if event.id:
                existing["id"] = event.id
            if event.function_name:
                existing["name"] = event.function_name
            if event.arguments_delta:
                existing["arguments"] = (existing["arguments"] or "") + event.arguments_delta
        elif event.type == "finish_reason":
            self._finish_reason_by_index[event.index] = event.finish_reason
        elif event.type == "usage":
            self._usage = event.usage
        elif event.type == "receipt":
            self._receipt = event.receipt
        elif event.type == "done":
            self._done = True

    def snapshot(self) -> ChatCompletionsStreamSnapshot:
        return ChatCompletionsStreamSnapshot(
            role=self._role,
            content_by_choice=dict(self._content_by_index),
            tool_calls_by_choice={
                index: list(by_index.values())
                for index, by_index in self._tool_calls_by_index.items()
            },
            finish_reason_by_choice=dict(self._finish_reason_by_index),
            usage=self._usage,
            receipt=self._receipt,
            completed=self._done,
        )


__all__ = [
    "MetaLlmStreamEnvelope",
    "ChatCompletionsStreamSnapshot",
    "ChatCompletionsStreamAccumulator",
]
