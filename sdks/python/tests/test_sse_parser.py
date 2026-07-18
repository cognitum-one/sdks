"""Generic, protocol-agnostic SSE byte-level parser tests (ADR-0024a §D5).

This is the highest-value test surface for issue #58's streaming pass --
it covers every edge case called out by D5 before any Meta-LLM-specific
decoding layer is involved.
"""

from __future__ import annotations

from cognitum.sse import SseParseError, SseParser


def _feed_all(parser: SseParser, chunks: list[bytes | str]) -> list:
    events = []
    for chunk in chunks:
        b = chunk.encode("utf-8") if isinstance(chunk, str) else chunk
        events.extend(parser.feed(b))
    return events


class TestSingleChunkNormalEvent:
    def test_parses_simple_data_only_event(self) -> None:
        parser = SseParser()
        events = _feed_all(parser, ["data: hello world\n\n"])
        assert len(events) == 1
        assert events[0].data == "hello world"
        assert events[0].event is None

    def test_parses_event_data_id_retry_together(self) -> None:
        parser = SseParser()
        events = _feed_all(parser, ["event: greeting\ndata: hi\nid: 42\nretry: 1500\n\n"])
        assert len(events) == 1
        e = events[0]
        assert (e.event, e.data, e.id, e.retry) == ("greeting", "hi", "42", 1500)


class TestArbitraryByteFragmentation:
    def test_reassembles_event_split_across_many_byte_boundaries(self) -> None:
        parser = SseParser()
        whole = b"event: chunked\ndata: fragment-test\n\n"
        events = []
        for i in range(len(whole)):
            events.extend(parser.feed(whole[i : i + 1]))
        assert len(events) == 1
        assert (events[0].event, events[0].data) == ("chunked", "fragment-test")

    def test_reassembles_split_mid_field_name(self) -> None:
        parser = SseParser()
        events = _feed_all(parser, ["dat", "a: value\n\n"])
        assert len(events) == 1
        assert events[0].data == "value"

    def test_reassembles_split_utf8_multibyte_sequence(self) -> None:
        parser = SseParser()
        # "café 🎉" -- a 2-byte codepoint (é) and a 4-byte codepoint (🎉).
        payload = "data: café 🎉\n\n".encode()
        e_index = payload.index(0xC3)  # first byte of "é"'s UTF-8 encoding
        emoji_start = payload.rindex(0xF0)  # first byte of the 4-byte emoji
        chunk1 = payload[: e_index + 1]  # ends mid "é"
        chunk2 = payload[e_index + 1 : emoji_start + 2]  # ends mid emoji
        chunk3 = payload[emoji_start + 2 :]
        events = _feed_all(parser, [chunk1, chunk2, chunk3])
        assert len(events) == 1
        assert events[0].data == "café 🎉"


class TestLineEndings:
    def test_accepts_lf_only(self) -> None:
        parser = SseParser()
        events = _feed_all(parser, ["data: lf-only\n\n"])
        assert [e.data for e in events] == ["lf-only"]

    def test_accepts_crlf(self) -> None:
        parser = SseParser()
        events = _feed_all(parser, ["data: crlf\r\n\r\n"])
        assert [e.data for e in events] == ["crlf"]

    def test_accepts_lone_cr_via_finish(self) -> None:
        parser = SseParser()
        # The trailing CR is ambiguous until end-of-stream (it could still
        # turn out to be the first half of a CRLF pair) -- feed() alone
        # won't flush it; finish() resolves the ambiguity.
        events = _feed_all(parser, ["data: lone-cr\r\r"])
        finish_result = parser.finish()
        all_events = events + finish_result.events
        assert [e.data for e in all_events] == ["lone-cr"]

    def test_does_not_misparse_crlf_split_at_boundary(self) -> None:
        parser = SseParser()
        events = _feed_all(parser, ["data: split-crlf\r", "\n\r\n"])
        assert [e.data for e in events] == ["split-crlf"]


class TestComments:
    def test_ignores_comment_line(self) -> None:
        parser = SseParser()
        events = _feed_all(
            parser, [": this is a keepalive comment\ndata: real payload\n: another comment\n\n"]
        )
        assert len(events) == 1
        assert events[0].data == "real payload"

    def test_stream_of_only_comments_produces_zero_events(self) -> None:
        parser = SseParser()
        events = _feed_all(parser, [":keepalive\n\n:keepalive\n\n"])
        assert events == []


class TestMultipleDataLines:
    def test_joins_multiple_data_lines_with_newline(self) -> None:
        parser = SseParser()
        events = _feed_all(parser, ["data: line one\ndata: line two\ndata: line three\n\n"])
        assert len(events) == 1
        assert events[0].data == "line one\nline two\nline three"


class TestBoundedMalformedHandling:
    def test_drops_oversized_line_without_crashing(self) -> None:
        parser = SseParser(max_line_bytes=16)
        events = _feed_all(parser, [f"data: {'x' * 100}\n", "data: short\n\n"])
        assert len(events) == 1
        assert events[0].data == "short"

    def test_tolerates_bounded_malformed_lines_then_raises(self) -> None:
        parser = SseParser(max_line_bytes=8, max_malformed_events=3)
        garbage_line = ("g" * 50 + "\n").encode("utf-8")
        for _ in range(3):
            parser.feed(garbage_line)  # should not raise
        try:
            parser.feed(garbage_line)
            raised = False
        except SseParseError:
            raised = True
        assert raised

    def test_raises_when_unterminated_bytes_exceed_buffer_bound(self) -> None:
        parser = SseParser(max_buffered_bytes=32)
        try:
            parser.feed(("x" * 100).encode("utf-8"))
            raised = False
        except SseParseError:
            raised = True
        assert raised

    def test_unrecognized_field_names_are_ignored_not_malformed(self) -> None:
        parser = SseParser()
        events = _feed_all(parser, ["totally-unknown-field: whatever\ndata: still works\n\n"])
        assert len(events) == 1
        assert events[0].data == "still works"


class TestStreamCloseWithoutTerminalEvent:
    def test_finish_reports_undispatched_data_mid_event(self) -> None:
        parser = SseParser()
        events = _feed_all(parser, ["data: never dispatched (no blank line follows)"])
        assert events == []
        result = parser.finish()
        assert result.had_undispatched_data is True
        assert result.events == []

    def test_finish_reports_no_undispatched_data_when_clean(self) -> None:
        parser = SseParser()
        _feed_all(parser, ["data: complete\n\n"])
        result = parser.finish()
        assert result.had_undispatched_data is False


class TestEmptyDataBufferOnDispatch:
    def test_does_not_dispatch_when_only_event_field_set(self) -> None:
        parser = SseParser()
        events = _feed_all(parser, ["event: ping\n\n"])
        assert events == []
