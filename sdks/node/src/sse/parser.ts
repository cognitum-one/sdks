/**
 * Protocol-agnostic Server-Sent Events (SSE) byte-level parser
 * (ADR-0024a §D5, ADR-0023 §D8 for the caller-facing time budgets that
 * wrap this parser — this file itself has no timing logic).
 *
 * Pure state machine with NO Meta-LLM (or any other product) knowledge —
 * this module is reused as-is for Anthropic Messages streaming and
 * Responses streaming when those land in follow-up work (issue #58
 * tracks only `chat.completions` streaming this pass). Consumes raw
 * bytes via {@link SseParser.feed} (arbitrary fragmentation: chunks may
 * split mid-line, mid-field, or mid-UTF-8 codepoint — bytes are buffered
 * and only decoded once a complete line's bytes are known, so a split
 * multi-byte codepoint at a chunk boundary is always safe) and yields
 * fully-parsed {@link SseEvent}s. Multiple `data:` lines are joined with
 * `\n` per the SSE spec; comment lines (leading `:`) are dropped; CRLF,
 * lone CR, and LF line endings are all accepted.
 *
 * Bounded-garbage handling (ADR-0024a §D5 "bounded unknown events"):
 * a single physical line over `maxLineBytes`, one event's joined `data:`
 * payload over `maxEventBytes`, or unterminated buffered bytes over
 * `maxBufferedBytes` are all dropped as malformed rather than growing
 * memory without bound; `maxMalformedEvents` caps how many such drops are
 * tolerated before {@link SseParser.feed} throws {@link SseParseError} and
 * the caller must abort the stream.
 *
 * Deliberate simplification vs. the full WHATWG EventSource processing
 * model: the `id`/`retry` fields reset with every dispatched event rather
 * than persisting as a `last-event-id` across events (SSE reconnection
 * semantics) — none of the three target protocols (OpenAI, Anthropic,
 * Responses) rely on client-driven SSE reconnection this pass.
 */

/** One fully-parsed, dispatched SSE event (generic — no protocol knowledge). */
export interface SseEvent {
  /** The `event:` field, if any. `undefined` means the default "message" type per spec. */
  event?: string;
  /** All `data:` lines for this event, joined with `\n` (SSE spec). */
  data: string;
  /** The `id:` field, if any and not containing a NUL byte. */
  id?: string;
  /** The `retry:` field in milliseconds, if any and all-ASCII-digit. */
  retry?: number;
}

export interface SseParserOptions {
  /** Max bytes for a single physical line before it is dropped as malformed. Default 64 KiB. */
  maxLineBytes?: number;
  /** Max cumulative bytes for one event's joined `data:` payload. Default 256 KiB. */
  maxEventBytes?: number;
  /** Max unterminated buffered bytes before treating the stream as broken. Default 1 MiB. */
  maxBufferedBytes?: number;
  /** Max malformed/oversized lines or events tolerated before aborting. Default 50. */
  maxMalformedEvents?: number;
}

/**
 * Sane defaults (ADR-0024a §D5 defers exact numbers to "the contract
 * bundle", which does not exist yet — these are a documented starting
 * point, not a frozen contract value): generous enough for real chat
 * completions (a single `data:` line rarely exceeds a few KiB; a full
 * accumulated event practically never approaches 256 KiB), while still
 * bounding a hostile or buggy server's memory impact.
 */
const DEFAULT_MAX_LINE_BYTES = 64 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
const DEFAULT_MAX_MALFORMED_EVENTS = 50;

/** Fatal parser condition — the stream must be aborted (too much unparseable garbage). */
export class SseParseError extends Error {
  readonly code: "line_too_long" | "buffer_overflow" | "too_many_malformed_events";

  constructor(code: SseParseError["code"], message: string) {
    super(message);
    this.name = "SseParseError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Result of {@link SseParser.finish}. */
export interface SseParserFinishResult {
  /** Any final event resolvable only at true end-of-stream (see {@link SseParser.finish}). */
  events: SseEvent[];
  /** `true` if bytes for an event were buffered but never dispatched (no trailing blank line). */
  hadUndispatchedData: boolean;
  /** Total malformed/oversized lines or events dropped over the parser's lifetime. */
  malformedEventCount: number;
}

const LF = 0x0a;
const CR = 0x0d;

/** Push-based SSE state machine: feed bytes in, get parsed events out. Not itself async. */
export class SseParser {
  private readonly maxLineBytes: number;
  private readonly maxEventBytes: number;
  private readonly maxBufferedBytes: number;
  private readonly maxMalformedEvents: number;

  private buffer: Uint8Array = new Uint8Array(0);
  private readonly lineDecoder = new TextDecoder("utf-8", { fatal: false });
  private readonly fieldEncoder = new TextEncoder();

  private eventType: string | undefined;
  private dataLines: string[] = [];
  private dataBytesLen = 0;
  private eventId: string | undefined;
  private retryMs: number | undefined;
  private poisoned = false;

  private malformedCount = 0;

  constructor(options?: SseParserOptions) {
    this.maxLineBytes = options?.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.maxEventBytes = options?.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    this.maxBufferedBytes = options?.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.maxMalformedEvents = options?.maxMalformedEvents ?? DEFAULT_MAX_MALFORMED_EVENTS;
  }

  /**
   * Feed the next chunk of raw bytes (any size, any split point — including
   * mid-UTF-8-codepoint). Returns zero or more fully-dispatched events, in
   * order. Throws {@link SseParseError} if a hard limit is exceeded.
   */
  feed(chunk: Uint8Array): SseEvent[] {
    this.appendToBuffer(chunk);
    const events: SseEvent[] = [];
    for (;;) {
      const line = this.takeLine(false);
      if (line === undefined) break;
      const event = this.processLine(line);
      if (event) events.push(event);
    }
    return events;
  }

  /**
   * Signal end of stream (no more bytes will ever arrive). Resolves the one
   * ambiguity `feed()` cannot: a trailing lone CR with nothing after it is
   * held back by `feed()` because a following LF (making it CRLF) might
   * still arrive — at true EOF that ambiguity is resolved (no more bytes
   * are coming, so a trailing CR IS a terminator), and this may therefore
   * flush one final event. Any OTHER undispatched partial event/line
   * (i.e. real data with no terminator at all) is dropped, matching the
   * SSE spec: dispatch only happens on a blank line, and a stream that
   * closes mid-event never sends one. This does NOT throw — whether an
   * incomplete stream is an error is protocol-specific (e.g. "did we see
   * `[DONE]`?"), which is the caller's decision, not this generic parser's.
   */
  finish(): SseParserFinishResult {
    const events: SseEvent[] = [];
    for (;;) {
      const line = this.takeLine(true);
      if (line === undefined) break;
      const event = this.processLine(line);
      if (event) events.push(event);
    }
    return {
      events,
      hadUndispatchedData: this.dataLines.length > 0 || this.buffer.length > 0,
      malformedEventCount: this.malformedCount,
    };
  }

  private appendToBuffer(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    if (this.buffer.length > this.maxBufferedBytes) {
      throw new SseParseError(
        "buffer_overflow",
        `SSE parser buffered ${this.buffer.length} bytes without a line terminator ` +
          `(limit ${this.maxBufferedBytes})`,
      );
    }
  }

  /**
   * Removes and returns the next complete line's raw bytes (terminator
   * excluded), or `undefined` if no complete line is available yet.
   * Accepts LF, CRLF, and lone CR (SSE/HTML spec line-terminator rule).
   *
   * A trailing CR with no following byte yet is ambiguous — it might be
   * the first half of a CRLF pair whose LF just hasn't arrived, or it
   * might be a lone-CR terminator. `feed()` calls this with `atEof=false`
   * and withholds judgement until a following byte (or true end of
   * stream) disambiguates it, so a CRLF pair split exactly at the CR/LF
   * boundary across two `feed()` calls is handled correctly. `finish()`
   * calls this with `atEof=true`, resolving that same trailing CR as a
   * valid terminator since no more bytes will ever arrive.
   */
  private takeLine(atEof: boolean): Uint8Array | undefined {
    for (let i = 0; i < this.buffer.length; i += 1) {
      const byte = this.buffer[i];
      if (byte === LF) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        return line;
      }
      if (byte === CR) {
        if (i + 1 < this.buffer.length) {
          const consumed = this.buffer[i + 1] === LF ? i + 2 : i + 1;
          const line = this.buffer.slice(0, i);
          this.buffer = this.buffer.slice(consumed);
          return line;
        }
        if (atEof) {
          const line = this.buffer.slice(0, i);
          this.buffer = this.buffer.slice(i + 1);
          return line;
        }
        return undefined; // need more bytes to know if this is CRLF or a lone CR
      }
    }
    return undefined;
  }

  private noteMalformed(): void {
    this.malformedCount += 1;
    if (this.malformedCount > this.maxMalformedEvents) {
      throw new SseParseError(
        "too_many_malformed_events",
        `SSE parser exceeded ${this.maxMalformedEvents} malformed/oversized lines or events`,
      );
    }
  }

  private processLine(lineBytes: Uint8Array): SseEvent | undefined {
    if (lineBytes.length > this.maxLineBytes) {
      this.noteMalformed();
      return undefined;
    }
    const line = this.lineDecoder.decode(lineBytes);

    if (line.length === 0) {
      return this.dispatch();
    }
    if (line.startsWith(":")) {
      return undefined; // comment line — always ignored, even in the malformed budget
    }

    const colonIdx = line.indexOf(":");
    let field: string;
    let value: string;
    if (colonIdx === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colonIdx);
      value = line.slice(colonIdx + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }

    switch (field) {
      case "event":
        this.eventType = value;
        break;
      case "data": {
        const additional = this.fieldEncoder.encode(value).length + (this.dataLines.length > 0 ? 1 : 0);
        if (!this.poisoned && this.dataBytesLen + additional > this.maxEventBytes) {
          this.poisoned = true;
          this.noteMalformed();
        }
        if (!this.poisoned) {
          this.dataLines.push(value);
          this.dataBytesLen += additional;
        }
        break;
      }
      case "id":
        // Reject only on a NUL byte, matching the doc comment on
        // `SseEvent.id` above and the Python/Rust parsers — a space in an
        // `id:` value is valid SSE and must be accepted. (Previously this
        // NUL check was written as a raw, invisible NUL byte inside the
        // string literal rather than the `\0` escape — functionally
        // identical, but indistinguishable from a stray space in most
        // editors/diff viewers, which is almost certainly why this was
        // mis-flagged as space-rejecting logic. Written explicitly now to
        // remove that landmine.)
        if (!value.includes("\0")) this.eventId = value;
        break;
      case "retry":
        if (/^[0-9]+$/.test(value)) this.retryMs = Number(value);
        break;
      default:
        break; // unrecognized field name — ignored per the SSE spec, not an error
    }
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    const hadData = this.dataLines.length > 0;
    const event: SseEvent | undefined =
      hadData && !this.poisoned
        ? { event: this.eventType, data: this.dataLines.join("\n"), id: this.eventId, retry: this.retryMs }
        : undefined;
    this.eventType = undefined;
    this.dataLines = [];
    this.dataBytesLen = 0;
    this.eventId = undefined;
    this.retryMs = undefined;
    this.poisoned = false;
    return event;
  }
}
