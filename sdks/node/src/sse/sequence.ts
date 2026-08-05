import type { SseEvent } from "./parser.js";

/** Error raised when a numeric SSE sequence skips an event. */
export class SseSequenceError extends Error {
  readonly expected: number;
  readonly received: number;

  constructor(expected: number, received: number) {
    super(`SSE event gap: expected id ${expected}, received ${received}`);
    this.name = "SseSequenceError";
    this.expected = expected;
    this.received = received;
  }
}

export interface SseSequenceOptions {
  /** Last id already delivered before reconnecting; it is sent as Last-Event-ID. */
  lastEventId?: string;
  /** Reject numeric ids that are not contiguous (default false). */
  requireContiguous?: boolean;
}

/**
 * Small, protocol-neutral state machine for resumable SSE consumers.
 * Duplicate ids are ignored, while accepted events advance `lastEventId`.
 * Numeric ids can optionally be checked for gaps; opaque ids remain valid.
 */
export class SseEventSequence {
  private readonly requireContiguous: boolean;
  private readonly seen = new Set<string>();
  private current?: string;
  private numeric?: number;

  constructor(options: SseSequenceOptions = {}) {
    this.requireContiguous = options.requireContiguous ?? false;
    this.current = options.lastEventId;
    if (options.lastEventId !== undefined) {
      this.seen.add(options.lastEventId);
      if (/^\d+$/.test(options.lastEventId)) this.numeric = Number(options.lastEventId);
    }
  }

  /** Header value for a reconnect request, or undefined before any event. */
  get lastEventId(): string | undefined {
    return this.current;
  }

  accept(event: SseEvent): boolean {
    if (event.id === undefined) return true;
    if (this.seen.has(event.id)) return false;

    const next = /^\d+$/.test(event.id) ? Number(event.id) : undefined;
    if (this.requireContiguous && this.numeric !== undefined && next !== undefined) {
      const expected = this.numeric + 1;
      if (next !== expected) throw new SseSequenceError(expected, next);
    }
    this.seen.add(event.id);
    this.current = event.id;
    this.numeric = next;
    return true;
  }

  /** Filter a batch while preserving order and dropping duplicate ids. */
  filter(events: readonly SseEvent[]): SseEvent[] {
    return events.filter((event) => this.accept(event));
  }
}
