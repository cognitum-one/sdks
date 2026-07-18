// src/sse/parser.ts
var DEFAULT_MAX_LINE_BYTES = 64 * 1024;
var DEFAULT_MAX_EVENT_BYTES = 256 * 1024;
var DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
var DEFAULT_MAX_MALFORMED_EVENTS = 50;
var SseParseError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "SseParseError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
var LF = 10;
var CR = 13;
var SseParser = class {
  maxLineBytes;
  maxEventBytes;
  maxBufferedBytes;
  maxMalformedEvents;
  buffer = new Uint8Array(0);
  lineDecoder = new TextDecoder("utf-8", { fatal: false });
  fieldEncoder = new TextEncoder();
  eventType;
  dataLines = [];
  dataBytesLen = 0;
  eventId;
  retryMs;
  poisoned = false;
  malformedCount = 0;
  constructor(options) {
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
  feed(chunk) {
    this.appendToBuffer(chunk);
    const events = [];
    for (; ; ) {
      const line = this.takeLine();
      if (line === void 0) break;
      const event = this.processLine(line);
      if (event) events.push(event);
    }
    return events;
  }
  /**
   * Signal end of stream (no more bytes will arrive). Any undispatched
   * partial event/line is dropped, matching the SSE spec: dispatch only
   * happens on a blank line, and a stream that closes mid-event never
   * sends one. This does NOT throw — whether an incomplete stream is an
   * error is protocol-specific (e.g. "did we see `[DONE]`?"), which is the
   * caller's decision, not this generic parser's.
   */
  finish() {
    return {
      hadUndispatchedData: this.dataLines.length > 0 || this.buffer.length > 0,
      malformedEventCount: this.malformedCount
    };
  }
  appendToBuffer(chunk) {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    if (this.buffer.length > this.maxBufferedBytes) {
      throw new SseParseError(
        "buffer_overflow",
        `SSE parser buffered ${this.buffer.length} bytes without a line terminator (limit ${this.maxBufferedBytes})`
      );
    }
  }
  /**
   * Removes and returns the next complete line's raw bytes (terminator
   * excluded), or `undefined` if no complete line is available yet.
   * Accepts LF, CRLF, and lone CR (SSE/HTML spec line-terminator rule) —
   * a trailing CR with no following byte yet is NOT treated as a
   * terminator until either a following LF/non-LF byte or `finish()`
   * disambiguates it, so a CRLF split exactly at the CR/LF boundary
   * across two `feed()` calls is handled correctly.
   */
  takeLine() {
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
        return void 0;
      }
    }
    return void 0;
  }
  noteMalformed() {
    this.malformedCount += 1;
    if (this.malformedCount > this.maxMalformedEvents) {
      throw new SseParseError(
        "too_many_malformed_events",
        `SSE parser exceeded ${this.maxMalformedEvents} malformed/oversized lines or events`
      );
    }
  }
  processLine(lineBytes) {
    if (lineBytes.length > this.maxLineBytes) {
      this.noteMalformed();
      return void 0;
    }
    const line = this.lineDecoder.decode(lineBytes);
    if (line.length === 0) {
      return this.dispatch();
    }
    if (line.startsWith(":")) {
      return void 0;
    }
    const colonIdx = line.indexOf(":");
    let field;
    let value;
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
        if (!value.includes("\0")) this.eventId = value;
        break;
      case "retry":
        if (/^[0-9]+$/.test(value)) this.retryMs = Number(value);
        break;
      default:
        break;
    }
    return void 0;
  }
  dispatch() {
    const hadData = this.dataLines.length > 0;
    const event = hadData && !this.poisoned ? { event: this.eventType, data: this.dataLines.join("\n"), id: this.eventId, retry: this.retryMs } : void 0;
    this.eventType = void 0;
    this.dataLines = [];
    this.dataBytesLen = 0;
    this.eventId = void 0;
    this.retryMs = void 0;
    this.poisoned = false;
    return event;
  }
};
export {
  SseParseError,
  SseParser
};
//# sourceMappingURL=index.js.map