import { describe, expect, it } from "vitest";

import { AgenticError } from "../src/agentic/errors.js";
import { waitForOperation } from "../src/agentic/operations.js";

describe("waitForOperation security boundaries", () => {
  it("does not retry a permission denial", async () => {
    let calls = 0;
    await expect(
      waitForOperation(
        {
          get: () => {
            calls += 1;
            return Promise.reject(new AgenticError("permission_denied", "denied", { retryable: false }));
          },
        },
        { sleep: () => Promise.reject(new Error("must not sleep")) },
      ),
    ).rejects.toMatchObject({ kind: "permission_denied" });
    expect(calls).toBe(1);
  });

  it("bounds an attacker-controlled retryable polling loop", async () => {
    let now = 0;
    await expect(
      waitForOperation(
        { get: () => Promise.reject(new AgenticError("transport", "retry", { retryable: true })) },
        {
          waitDeadlineMs: 10,
          pollIntervalMs: 5,
          jitterMs: () => 0,
          now: () => now,
          sleep: (ms) => {
            now += ms;
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toMatchObject({ kind: "deadline_exceeded" });
  });
});
