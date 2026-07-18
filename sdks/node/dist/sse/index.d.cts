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
interface SseEvent {
    /** The `event:` field, if any. `undefined` means the default "message" type per spec. */
    event?: string;
    /** All `data:` lines for this event, joined with `\n` (SSE spec). */
    data: string;
    /** The `id:` field, if any and not containing a NUL byte. */
    id?: string;
    /** The `retry:` field in milliseconds, if any and all-ASCII-digit. */
    retry?: number;
}
interface SseParserOptions {
    /** Max bytes for a single physical line before it is dropped as malformed. Default 64 KiB. */
    maxLineBytes?: number;
    /** Max cumulative bytes for one event's joined `data:` payload. Default 256 KiB. */
    maxEventBytes?: number;
    /** Max unterminated buffered bytes before treating the stream as broken. Default 1 MiB. */
    maxBufferedBytes?: number;
    /** Max malformed/oversized lines or events tolerated before aborting. Default 50. */
    maxMalformedEvents?: number;
}
/** Fatal parser condition — the stream must be aborted (too much unparseable garbage). */
declare class SseParseError extends Error {
    readonly code: "line_too_long" | "buffer_overflow" | "too_many_malformed_events";
    constructor(code: SseParseError["code"], message: string);
}
/** Informational summary returned by {@link SseParser.finish}. */
interface SseParserFinishResult {
    /** `true` if bytes for an event were buffered but never dispatched (no trailing blank line). */
    hadUndispatchedData: boolean;
    /** Total malformed/oversized lines or events dropped over the parser's lifetime. */
    malformedEventCount: number;
}
/** Push-based SSE state machine: feed bytes in, get parsed events out. Not itself async. */
declare class SseParser {
    private readonly maxLineBytes;
    private readonly maxEventBytes;
    private readonly maxBufferedBytes;
    private readonly maxMalformedEvents;
    private buffer;
    private readonly lineDecoder;
    private readonly fieldEncoder;
    private eventType;
    private dataLines;
    private dataBytesLen;
    private eventId;
    private retryMs;
    private poisoned;
    private malformedCount;
    constructor(options?: SseParserOptions);
    /**
     * Feed the next chunk of raw bytes (any size, any split point — including
     * mid-UTF-8-codepoint). Returns zero or more fully-dispatched events, in
     * order. Throws {@link SseParseError} if a hard limit is exceeded.
     */
    feed(chunk: Uint8Array): SseEvent[];
    /**
     * Signal end of stream (no more bytes will arrive). Any undispatched
     * partial event/line is dropped, matching the SSE spec: dispatch only
     * happens on a blank line, and a stream that closes mid-event never
     * sends one. This does NOT throw — whether an incomplete stream is an
     * error is protocol-specific (e.g. "did we see `[DONE]`?"), which is the
     * caller's decision, not this generic parser's.
     */
    finish(): SseParserFinishResult;
    private appendToBuffer;
    /**
     * Removes and returns the next complete line's raw bytes (terminator
     * excluded), or `undefined` if no complete line is available yet.
     * Accepts LF, CRLF, and lone CR (SSE/HTML spec line-terminator rule) —
     * a trailing CR with no following byte yet is NOT treated as a
     * terminator until either a following LF/non-LF byte or `finish()`
     * disambiguates it, so a CRLF split exactly at the CR/LF boundary
     * across two `feed()` calls is handled correctly.
     */
    private takeLine;
    private noteMalformed;
    private processLine;
    private dispatch;
}

export { type SseEvent, SseParseError, SseParser, type SseParserFinishResult, type SseParserOptions };
