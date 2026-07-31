#![cfg(feature = "meta-llm")]
//! Generic, protocol-agnostic SSE byte-level parser tests (ADR-0024a §D5).
//!
//! This is the highest-value test surface for issue #58's streaming pass --
//! it covers every edge case called out by D5 before any Meta-LLM-specific
//! decoding layer is involved.

use cognitum_one::sse::{SseParseError, SseParser, SseParserOptions};

fn feed_all(parser: &mut SseParser, chunks: &[&[u8]]) -> Vec<cognitum_one::sse::SseEvent> {
    let mut events = Vec::new();
    for chunk in chunks {
        events.extend(
            parser
                .feed(chunk)
                .expect("feed should not error in this helper"),
        );
    }
    events
}

// ---------------------------------------------------------------------------
// Single-chunk normal event
// ---------------------------------------------------------------------------

#[test]
fn parses_simple_data_only_event() {
    let mut parser = SseParser::new();
    let events = feed_all(&mut parser, &[b"data: hello world\n\n"]);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].data, "hello world");
    assert_eq!(events[0].event, None);
}

#[test]
fn parses_event_data_id_retry_together() {
    let mut parser = SseParser::new();
    let events = feed_all(
        &mut parser,
        &[b"event: greeting\ndata: hi\nid: 42\nretry: 1500\n\n"],
    );
    assert_eq!(events.len(), 1);
    let e = &events[0];
    assert_eq!(e.event.as_deref(), Some("greeting"));
    assert_eq!(e.data, "hi");
    assert_eq!(e.id.as_deref(), Some("42"));
    assert_eq!(e.retry, Some(1500));
}

// ---------------------------------------------------------------------------
// Arbitrary byte fragmentation
// ---------------------------------------------------------------------------

#[test]
fn reassembles_event_split_across_many_byte_boundaries() {
    let mut parser = SseParser::new();
    let whole = b"event: chunked\ndata: fragment-test\n\n";
    let mut events = Vec::new();
    for byte in whole {
        events.extend(parser.feed(&[*byte]).unwrap());
    }
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event.as_deref(), Some("chunked"));
    assert_eq!(events[0].data, "fragment-test");
}

#[test]
fn reassembles_split_mid_field_name() {
    let mut parser = SseParser::new();
    let events = feed_all(&mut parser, &[b"dat", b"a: value\n\n"]);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].data, "value");
}

#[test]
fn reassembles_split_utf8_multibyte_sequence() {
    let mut parser = SseParser::new();
    // "café 🎉" -- a 2-byte codepoint (é) and a 4-byte codepoint (🎉).
    let payload = "data: café 🎉\n\n".as_bytes().to_vec();
    let e_index = payload.iter().position(|&b| b == 0xC3).unwrap(); // first byte of "é"
    let emoji_start = payload.iter().rposition(|&b| b == 0xF0).unwrap(); // first byte of the emoji
    let chunk1 = &payload[..e_index + 1]; // ends mid "é"
    let chunk2 = &payload[e_index + 1..emoji_start + 2]; // ends mid emoji
    let chunk3 = &payload[emoji_start + 2..];
    let events = feed_all(&mut parser, &[chunk1, chunk2, chunk3]);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].data, "café 🎉");
}

// ---------------------------------------------------------------------------
// Line endings
// ---------------------------------------------------------------------------

#[test]
fn accepts_lf_only() {
    let mut parser = SseParser::new();
    let events = feed_all(&mut parser, &[b"data: lf-only\n\n"]);
    assert_eq!(
        events.iter().map(|e| e.data.as_str()).collect::<Vec<_>>(),
        vec!["lf-only"]
    );
}

#[test]
fn accepts_crlf() {
    let mut parser = SseParser::new();
    let events = feed_all(&mut parser, &[b"data: crlf\r\n\r\n"]);
    assert_eq!(
        events.iter().map(|e| e.data.as_str()).collect::<Vec<_>>(),
        vec!["crlf"]
    );
}

#[test]
fn accepts_lone_cr_via_finish() {
    let mut parser = SseParser::new();
    // The trailing CR is ambiguous until end-of-stream (it could still turn
    // out to be the first half of a CRLF pair) -- feed() alone won't flush
    // it; finish() resolves the ambiguity since no more bytes will arrive.
    let mut events = feed_all(&mut parser, &[b"data: lone-cr\r\r"]);
    let finish_result = parser.finish().unwrap();
    events.extend(finish_result.events);
    assert_eq!(
        events.iter().map(|e| e.data.as_str()).collect::<Vec<_>>(),
        vec!["lone-cr"]
    );
}

#[test]
fn does_not_misparse_crlf_split_at_boundary() {
    let mut parser = SseParser::new();
    let events = feed_all(&mut parser, &[b"data: split-crlf\r", b"\n\r\n"]);
    assert_eq!(
        events.iter().map(|e| e.data.as_str()).collect::<Vec<_>>(),
        vec!["split-crlf"]
    );
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

#[test]
fn ignores_comment_line() {
    let mut parser = SseParser::new();
    let events = feed_all(
        &mut parser,
        &[b": this is a keepalive comment\ndata: real payload\n: another comment\n\n"],
    );
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].data, "real payload");
}

#[test]
fn stream_of_only_comments_produces_zero_events() {
    let mut parser = SseParser::new();
    let events = feed_all(&mut parser, &[b":keepalive\n\n:keepalive\n\n"]);
    assert!(events.is_empty());
}

// ---------------------------------------------------------------------------
// Multiple data: lines
// ---------------------------------------------------------------------------

#[test]
fn joins_multiple_data_lines_with_newline() {
    let mut parser = SseParser::new();
    let events = feed_all(
        &mut parser,
        &[b"data: line one\ndata: line two\ndata: line three\n\n"],
    );
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].data, "line one\nline two\nline three");
}

// ---------------------------------------------------------------------------
// Bounded malformed/garbage handling
// ---------------------------------------------------------------------------

#[test]
fn drops_oversized_line_without_crashing() {
    let mut parser = SseParser::with_options(SseParserOptions {
        max_line_bytes: 16,
        ..SseParserOptions::default()
    });
    let long_line = format!("data: {}\n", "x".repeat(100));
    let events = feed_all(&mut parser, &[long_line.as_bytes(), b"data: short\n\n"]);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].data, "short");
}

#[test]
fn tolerates_bounded_malformed_lines_then_errors() {
    let mut parser = SseParser::with_options(SseParserOptions {
        max_line_bytes: 8,
        max_malformed_events: 3,
        ..SseParserOptions::default()
    });
    let garbage_line = format!("{}\n", "g".repeat(50));
    for _ in 0..3 {
        assert!(parser.feed(garbage_line.as_bytes()).is_ok());
    }
    assert!(matches!(
        parser.feed(garbage_line.as_bytes()),
        Err(SseParseError::TooManyMalformedEvents { .. })
    ));
}

#[test]
fn errors_when_unterminated_bytes_exceed_buffer_bound() {
    let mut parser = SseParser::with_options(SseParserOptions {
        max_buffered_bytes: 32,
        ..SseParserOptions::default()
    });
    let garbage = "x".repeat(100);
    assert!(matches!(
        parser.feed(garbage.as_bytes()),
        Err(SseParseError::BufferOverflow { .. })
    ));
}

#[test]
fn unrecognized_field_names_are_ignored_not_malformed() {
    let mut parser = SseParser::new();
    let events = feed_all(
        &mut parser,
        &[b"totally-unknown-field: whatever\ndata: still works\n\n"],
    );
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].data, "still works");
}

// ---------------------------------------------------------------------------
// Stream close without a terminal event
// ---------------------------------------------------------------------------

#[test]
fn finish_reports_undispatched_data_mid_event() {
    let mut parser = SseParser::new();
    let events = feed_all(
        &mut parser,
        &[b"data: never dispatched (no blank line follows)"],
    );
    assert!(events.is_empty());
    let result = parser.finish().unwrap();
    assert!(result.had_undispatched_data);
    assert!(result.events.is_empty());
}

#[test]
fn finish_reports_no_undispatched_data_when_clean() {
    let mut parser = SseParser::new();
    feed_all(&mut parser, &[b"data: complete\n\n"]);
    let result = parser.finish().unwrap();
    assert!(!result.had_undispatched_data);
}

// ---------------------------------------------------------------------------
// Empty data buffer on dispatch
// ---------------------------------------------------------------------------

#[test]
fn does_not_dispatch_when_only_event_field_set() {
    let mut parser = SseParser::new();
    let events = feed_all(&mut parser, &[b"event: ping\n\n"]);
    assert!(events.is_empty());
}

// ---------------------------------------------------------------------------
// id: field validation (cross-language parity with Python/Node)
// ---------------------------------------------------------------------------

#[test]
fn id_field_accepts_a_value_containing_a_space() {
    // Only a NUL byte disqualifies an `id:` value -- a space is ordinary,
    // valid SSE and must pass through untouched, matching the Python and
    // Node parsers.
    let mut parser = SseParser::new();
    let events = feed_all(&mut parser, &[b"data: x\nid: has space\n\n"]);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].id.as_deref(), Some("has space"));
}

#[test]
fn id_field_rejects_a_value_containing_a_nul_byte() {
    let mut parser = SseParser::new();
    let events = feed_all(&mut parser, &[b"data: x\nid: has\x00nul\n\n"]);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].id, None);
}
