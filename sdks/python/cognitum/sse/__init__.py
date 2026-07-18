"""Protocol-agnostic Server-Sent Events parsing (ADR-0024a §D5). No
Meta-LLM (or any other product) knowledge lives here -- reused as-is by
every streaming protocol facade.
"""

from __future__ import annotations

from cognitum.sse.parser import (
    DEFAULT_MAX_BUFFERED_BYTES,
    DEFAULT_MAX_EVENT_BYTES,
    DEFAULT_MAX_LINE_BYTES,
    DEFAULT_MAX_MALFORMED_EVENTS,
    SseEvent,
    SseParseError,
    SseParser,
    SseParserFinishResult,
)

__all__ = [
    "SseEvent",
    "SseParseError",
    "SseParserFinishResult",
    "SseParser",
    "DEFAULT_MAX_LINE_BYTES",
    "DEFAULT_MAX_EVENT_BYTES",
    "DEFAULT_MAX_BUFFERED_BYTES",
    "DEFAULT_MAX_MALFORMED_EVENTS",
]
