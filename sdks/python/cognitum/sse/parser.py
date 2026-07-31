"""Protocol-agnostic Server-Sent Events (SSE) byte-level parser (ADR-0024a
§D5, ADR-0023 §D8 for the caller-facing time budgets that wrap this parser
-- this module itself has no timing logic).

Pure state machine with NO Meta-LLM (or any other product) knowledge --
this module is reused as-is for Anthropic Messages streaming and Responses
streaming when those land in follow-up work (issue #58 tracks only
``chat.completions`` streaming this pass). Consumes raw bytes via
:meth:`SseParser.feed` (arbitrary fragmentation: chunks may split mid-line,
mid-field, or mid-UTF-8 codepoint -- bytes are buffered and only decoded
once a complete line's bytes are known, so a split multi-byte codepoint at
a chunk boundary is always safe) and yields fully-parsed :class:`SseEvent`
objects. Multiple ``data:`` lines are joined with ``\\n`` per the SSE spec;
comment lines (leading ``:``) are dropped; CRLF, lone CR, and LF line
endings are all accepted.

Bounded-garbage handling (ADR-0024a §D5 "bounded unknown events"): a single
physical line over ``max_line_bytes``, one event's joined ``data:`` payload
over ``max_event_bytes``, or unterminated buffered bytes over
``max_buffered_bytes`` are all dropped as malformed rather than growing
memory without bound; ``max_malformed_events`` caps how many such drops are
tolerated before :meth:`SseParser.feed` raises :class:`SseParseError` and
the caller must abort the stream.

Deliberate simplification vs. the full WHATWG EventSource processing
model: the ``id``/``retry`` fields reset with every dispatched event rather
than persisting as a ``last-event-id`` across events (SSE reconnection
semantics) -- none of the three target protocols (OpenAI, Anthropic,
Responses) rely on client-driven SSE reconnection this pass.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

#: Sane defaults (ADR-0024a §D5 defers exact numbers to "the contract
#: bundle", which does not exist yet -- these are a documented starting
#: point, not a frozen contract value): generous enough for real chat
#: completions (a single ``data:`` line rarely exceeds a few KiB; a full
#: accumulated event practically never approaches 256 KiB), while still
#: bounding a hostile or buggy server's memory impact.
DEFAULT_MAX_LINE_BYTES = 64 * 1024
DEFAULT_MAX_EVENT_BYTES = 256 * 1024
DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024
DEFAULT_MAX_MALFORMED_EVENTS = 50

_LF = 0x0A
_CR = 0x0D
_DIGITS_RE = re.compile(r"^[0-9]+$")


@dataclass(frozen=True)
class SseEvent:
    """One fully-parsed, dispatched SSE event (generic -- no protocol knowledge)."""

    data: str
    event: str | None = None
    id: str | None = None
    retry: int | None = None


class SseParseError(Exception):
    """Fatal parser condition -- the stream must be aborted (too much unparseable garbage)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class SseParserFinishResult:
    """Result of :meth:`SseParser.finish`."""

    events: list[SseEvent] = field(default_factory=list)
    had_undispatched_data: bool = False
    malformed_event_count: int = 0


class SseParser:
    """Push-based SSE state machine: feed bytes in, get parsed events out. Not itself async."""

    def __init__(
        self,
        *,
        max_line_bytes: int = DEFAULT_MAX_LINE_BYTES,
        max_event_bytes: int = DEFAULT_MAX_EVENT_BYTES,
        max_buffered_bytes: int = DEFAULT_MAX_BUFFERED_BYTES,
        max_malformed_events: int = DEFAULT_MAX_MALFORMED_EVENTS,
    ) -> None:
        self._max_line_bytes = max_line_bytes
        self._max_event_bytes = max_event_bytes
        self._max_buffered_bytes = max_buffered_bytes
        self._max_malformed_events = max_malformed_events

        self._buffer = b""

        self._event_type: str | None = None
        self._data_lines: list[str] = []
        self._data_bytes_len = 0
        self._event_id: str | None = None
        self._retry_ms: int | None = None
        self._poisoned = False

        self._malformed_count = 0

    def feed(self, chunk: bytes) -> list[SseEvent]:
        """Feed the next chunk of raw bytes (any size, any split point --
        including mid-UTF-8-codepoint). Returns zero or more fully-dispatched
        events, in order. Raises :class:`SseParseError` if a hard limit is
        exceeded.
        """
        self._append_to_buffer(chunk)
        events: list[SseEvent] = []
        while True:
            line = self._take_line(at_eof=False)
            if line is None:
                break
            event = self._process_line(line)
            if event is not None:
                events.append(event)
        return events

    def finish(self) -> SseParserFinishResult:
        """Signal end of stream (no more bytes will ever arrive). Resolves the
        one ambiguity :meth:`feed` cannot: a trailing lone CR with nothing
        after it is held back by :meth:`feed` because a following LF (making
        it CRLF) might still arrive -- at true EOF that ambiguity is resolved
        (no more bytes are coming, so a trailing CR IS a terminator), and
        this may therefore flush one final event. Any OTHER undispatched
        partial event/line (i.e. real data with no terminator at all) is
        dropped, matching the SSE spec: dispatch only happens on a blank
        line, and a stream that closes mid-event never sends one. This does
        NOT raise -- whether an incomplete stream is an error is
        protocol-specific (e.g. "did we see ``[DONE]``?"), which is the
        caller's decision, not this generic parser's.
        """
        events: list[SseEvent] = []
        while True:
            line = self._take_line(at_eof=True)
            if line is None:
                break
            event = self._process_line(line)
            if event is not None:
                events.append(event)
        return SseParserFinishResult(
            events=events,
            had_undispatched_data=len(self._data_lines) > 0 or len(self._buffer) > 0,
            malformed_event_count=self._malformed_count,
        )

    def _append_to_buffer(self, chunk: bytes) -> None:
        self._buffer += chunk
        if len(self._buffer) > self._max_buffered_bytes:
            raise SseParseError(
                "buffer_overflow",
                f"SSE parser buffered {len(self._buffer)} bytes without a line "
                f"terminator (limit {self._max_buffered_bytes})",
            )

    def _take_line(self, *, at_eof: bool) -> bytes | None:
        """Removes and returns the next complete line's raw bytes (terminator
        excluded), or ``None`` if no complete line is available yet. Accepts
        LF, CRLF, and lone CR (SSE/HTML spec line-terminator rule).

        A trailing CR with no following byte yet is ambiguous -- it might be
        the first half of a CRLF pair whose LF just hasn't arrived, or it
        might be a lone-CR terminator. :meth:`feed` calls this with
        ``at_eof=False`` and withholds judgement until a following byte (or
        true end of stream) disambiguates it, so a CRLF pair split exactly at
        the CR/LF boundary across two :meth:`feed` calls is handled
        correctly. :meth:`finish` calls this with ``at_eof=True``, resolving
        that same trailing CR as a valid terminator since no more bytes will
        ever arrive.
        """
        buf = self._buffer
        for i, byte in enumerate(buf):
            if byte == _LF:
                line = buf[:i]
                self._buffer = buf[i + 1 :]
                return line
            if byte == _CR:
                if i + 1 < len(buf):
                    consumed = i + 2 if buf[i + 1] == _LF else i + 1
                    line = buf[:i]
                    self._buffer = buf[consumed:]
                    return line
                if at_eof:
                    line = buf[:i]
                    self._buffer = buf[i + 1 :]
                    return line
                return None  # need more bytes to know if this is CRLF or a lone CR
        return None

    def _note_malformed(self) -> None:
        self._malformed_count += 1
        if self._malformed_count > self._max_malformed_events:
            raise SseParseError(
                "too_many_malformed_events",
                f"SSE parser exceeded {self._max_malformed_events} malformed/oversized "
                "lines or events",
            )

    def _process_line(self, line_bytes: bytes) -> SseEvent | None:
        if len(line_bytes) > self._max_line_bytes:
            self._note_malformed()
            return None
        line = line_bytes.decode("utf-8", errors="replace")

        if len(line) == 0:
            return self._dispatch()
        if line.startswith(":"):
            return None  # comment line -- always ignored, even in the malformed budget

        colon_idx = line.find(":")
        if colon_idx == -1:
            field_name, value = line, ""
        else:
            field_name = line[:colon_idx]
            value = line[colon_idx + 1 :]
            if value.startswith(" "):
                value = value[1:]

        if field_name == "event":
            self._event_type = value
        elif field_name == "data":
            additional = len(value.encode("utf-8")) + (1 if self._data_lines else 0)
            if not self._poisoned and self._data_bytes_len + additional > self._max_event_bytes:
                self._poisoned = True
                self._note_malformed()
            if not self._poisoned:
                self._data_lines.append(value)
                self._data_bytes_len += additional
        elif field_name == "id":
            if "\x00" not in value:
                self._event_id = value
        elif field_name == "retry":
            if _DIGITS_RE.match(value):
                self._retry_ms = int(value)
        # else: unrecognized field name -- ignored per the SSE spec, not an error
        return None

    def _dispatch(self) -> SseEvent | None:
        had_data = len(self._data_lines) > 0
        event: SseEvent | None = None
        if had_data and not self._poisoned:
            event = SseEvent(
                event=self._event_type,
                data="\n".join(self._data_lines),
                id=self._event_id,
                retry=self._retry_ms,
            )
        self._event_type = None
        self._data_lines = []
        self._data_bytes_len = 0
        self._event_id = None
        self._retry_ms = None
        self._poisoned = False
        return event


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
