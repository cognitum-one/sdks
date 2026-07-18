import { describe, expect, it } from "vitest";

import { SseParseError, SseParser } from "../src/sse/parser.js";

/**
 * Generic, protocol-agnostic SSE byte-level parser tests (ADR-0024a §D5).
 * This is the highest-value test surface for issue #58's streaming pass —
 * it covers every edge case called out by D5 before any Meta-LLM-specific
 * decoding layer is involved.
 */

const enc = new TextEncoder();

function feedAll(parser: SseParser, chunks: (string | Uint8Array)[]) {
  const events = [];
  for (const chunk of chunks) {
    const bytes = typeof chunk === "string" ? enc.encode(chunk) : chunk;
    events.push(...parser.feed(bytes));
  }
  return events;
}

describe("SseParser: single-chunk normal event", () => {
  it("parses a simple data-only event delivered in one chunk", () => {
    const parser = new SseParser();
    const events = feedAll(parser, ["data: hello world\n\n"]);
    expect(events).toEqual([{ event: undefined, data: "hello world", id: undefined, retry: undefined }]);
  });

  it("parses event/data/id/retry fields together", () => {
    const parser = new SseParser();
    const events = feedAll(parser, ["event: greeting\ndata: hi\nid: 42\nretry: 1500\n\n"]);
    expect(events).toEqual([{ event: "greeting", data: "hi", id: "42", retry: 1500 }]);
  });
});

describe("SseParser: arbitrary byte fragmentation", () => {
  it("reassembles an event split across many arbitrary byte boundaries", () => {
    const parser = new SseParser();
    const whole = "event: chunked\ndata: fragment-test\n\n";
    const bytes = enc.encode(whole);
    const events = [];
    // Feed one byte at a time — the most adversarial possible fragmentation.
    for (const byte of bytes) {
      events.push(...parser.feed(new Uint8Array([byte])));
    }
    expect(events).toEqual([{ event: "chunked", data: "fragment-test", id: undefined, retry: undefined }]);
  });

  it("reassembles a split mid-field-name (\"dat\" | \"a: value\")", () => {
    const parser = new SseParser();
    const events = feedAll(parser, ["dat", "a: value\n\n"]);
    expect(events).toEqual([{ event: undefined, data: "value", id: undefined, retry: undefined }]);
  });

  it("reassembles a data value whose UTF-8 multi-byte sequence is split across chunks", () => {
    const parser = new SseParser();
    // "café 🎉" — both a 2-byte codepoint (é) and a 4-byte codepoint (🎉).
    const payload = enc.encode("data: café 🎉\n\n");
    // Split in the middle of the 2-byte "é" sequence AND in the middle of
    // the 4-byte emoji sequence, across three feed() calls.
    const eIndex = payload.indexOf(0xc3); // first byte of "é"'s UTF-8 encoding
    const emojiStart = payload.lastIndexOf(0xf0); // first byte of the 4-byte emoji
    const chunk1 = payload.slice(0, eIndex + 1); // ends mid "é"
    const chunk2 = payload.slice(eIndex + 1, emojiStart + 2); // ends mid emoji
    const chunk3 = payload.slice(emojiStart + 2);
    const events = feedAll(parser, [chunk1, chunk2, chunk3]);
    expect(events).toEqual([{ event: undefined, data: "café 🎉", id: undefined, retry: undefined }]);
  });
});

describe("SseParser: line endings", () => {
  it("accepts LF-only line endings", () => {
    const parser = new SseParser();
    const events = feedAll(parser, ["data: lf-only\n\n"]);
    expect(events.map((e) => e.data)).toEqual(["lf-only"]);
  });

  it("accepts CRLF line endings", () => {
    const parser = new SseParser();
    const events = feedAll(parser, ["data: crlf\r\n\r\n"]);
    expect(events.map((e) => e.data)).toEqual(["crlf"]);
  });

  it("accepts a lone CR (not followed by LF) as a line terminator", () => {
    const parser = new SseParser();
    // The trailing CR is ambiguous until end-of-stream (it could still
    // turn out to be the first half of a CRLF pair) — feed() alone won't
    // flush it; finish() resolves the ambiguity since no more bytes will
    // ever arrive.
    const events = feedAll(parser, ["data: lone-cr\r\r"]);
    const finishResult = parser.finish();
    expect([...events, ...finishResult.events].map((e) => e.data)).toEqual(["lone-cr"]);
  });

  it("does not misparse a CRLF split exactly between the CR and LF bytes", () => {
    const parser = new SseParser();
    const events = feedAll(parser, ["data: split-crlf\r", "\n\r\n"]);
    expect(events.map((e) => e.data)).toEqual(["split-crlf"]);
  });
});

describe("SseParser: comments", () => {
  it("ignores a comment line entirely, including between data lines", () => {
    const parser = new SseParser();
    const events = feedAll(parser, [": this is a keepalive comment\ndata: real payload\n: another comment\n\n"]);
    expect(events).toEqual([{ event: undefined, data: "real payload", id: undefined, retry: undefined }]);
  });

  it("a stream of only comments (keepalives) produces zero events", () => {
    const parser = new SseParser();
    const events = feedAll(parser, [":keepalive\n\n:keepalive\n\n"]);
    expect(events).toEqual([]);
  });
});

describe("SseParser: multiple data: lines", () => {
  it("joins multiple data: lines with \\n per the SSE spec", () => {
    const parser = new SseParser();
    const events = feedAll(parser, ["data: line one\ndata: line two\ndata: line three\n\n"]);
    expect(events).toEqual([
      { event: undefined, data: "line one\nline two\nline three", id: undefined, retry: undefined },
    ]);
  });
});

describe("SseParser: bounded malformed/garbage handling", () => {
  it("drops a single oversized line without crashing and without emitting it", () => {
    const parser = new SseParser({ maxLineBytes: 16 });
    const events = feedAll(parser, [`data: ${"x".repeat(100)}\n`, "data: short\n\n"]);
    expect(events).toEqual([{ event: undefined, data: "short", id: undefined, retry: undefined }]);
  });

  it("tolerates a bounded number of malformed lines, then throws once the budget is exceeded", () => {
    const parser = new SseParser({ maxLineBytes: 8, maxMalformedEvents: 3 });
    const garbageLine = `${"g".repeat(50)}\n`;
    expect(() => {
      for (let i = 0; i < 3; i += 1) parser.feed(enc.encode(garbageLine));
    }).not.toThrow();
    expect(() => parser.feed(enc.encode(garbageLine))).toThrow(SseParseError);
  });

  it("throws SseParseError when unterminated bytes exceed the buffer bound", () => {
    const parser = new SseParser({ maxBufferedBytes: 32 });
    expect(() => parser.feed(enc.encode("x".repeat(100)))).toThrow(SseParseError);
  });

  it("unrecognized field names are ignored, not treated as malformed", () => {
    const parser = new SseParser();
    const events = feedAll(parser, ["totally-unknown-field: whatever\ndata: still works\n\n"]);
    expect(events).toEqual([{ event: undefined, data: "still works", id: undefined, retry: undefined }]);
  });
});

describe("SseParser: stream close without a terminal event", () => {
  it("finish() reports undispatched data when the stream ends mid-event (no trailing blank line)", () => {
    const parser = new SseParser();
    const events = feedAll(parser, ["data: never dispatched (no blank line follows)"]);
    expect(events).toEqual([]);
    const result = parser.finish();
    expect(result.hadUndispatchedData).toBe(true);
  });

  it("finish() reports no undispatched data when the stream ends cleanly between events", () => {
    const parser = new SseParser();
    feedAll(parser, ["data: complete\n\n"]);
    const result = parser.finish();
    expect(result.hadUndispatchedData).toBe(false);
  });
});

describe("SseParser: empty data buffer on dispatch", () => {
  it("does not dispatch an event when only event: was set with no data", () => {
    const parser = new SseParser();
    const events = feedAll(parser, ["event: ping\n\n"]);
    expect(events).toEqual([]);
  });
});
