import { describe, expect, it } from "vitest";
import { SseEventSequence, SseSequenceError } from "../src/sse/index.js";

describe("SseEventSequence", () => {
  it("drops duplicate ids and exposes the reconnect cursor", () => {
    const sequence = new SseEventSequence();
    expect(sequence.filter([{ id: "a", data: "1" }, { id: "a", data: "retry" }, { id: "b", data: "2" }])).toEqual([
      { id: "a", data: "1" },
      { id: "b", data: "2" },
    ]);
    expect(sequence.lastEventId).toBe("b");
  });

  it("rejects a numeric gap when contiguous delivery is required", () => {
    const sequence = new SseEventSequence({ lastEventId: "4", requireContiguous: true });
    expect(() => sequence.accept({ id: "6", data: "gap" })).toThrow(SseSequenceError);
    expect(sequence.lastEventId).toBe("4");
  });

  it("supports opaque cursors and starts after a reconnect cursor", () => {
    const sequence = new SseEventSequence({ lastEventId: "cursor-9" });
    expect(sequence.accept({ id: "cursor-9", data: "replayed" })).toBe(false);
    expect(sequence.accept({ id: "cursor-10", data: "next" })).toBe(true);
    expect(sequence.lastEventId).toBe("cursor-10");
  });
});
