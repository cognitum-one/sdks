import { describe, expect, it } from "vitest";

import { AgenticError } from "../src/agentic/errors.js";
import type { OperationSnapshot } from "../src/agentic/operations.js";
import { waitForOperation } from "../src/agentic/operations.js";

function snapshot(state: OperationSnapshot["state"], overrides: Partial<OperationSnapshot> = {}): OperationSnapshot {
  return { id: "op-1", state, updatedAt: "2026-01-01T00:00:00.000Z", ...overrides };
}

describe("waitForOperation (ADR-0023 §D8/§D9)", () => {
  it("returns immediately when the first snapshot is already terminal", async () => {
    const result = await waitForOperation(
      { get: () => Promise.resolve(snapshot("completed", { result: "done" })) },
      { sleep: () => Promise.reject(new Error("must not sleep")) },
    );
    expect(result.state).toBe("completed");
    expect(result.result).toBe("done");
  });

  it("polls through pending/running and returns on completed", async () => {
    const states: OperationSnapshot["state"][] = ["pending", "running", "running", "completed"];
    let call = 0;
    const sleeps: number[] = [];
    const result = await waitForOperation(
      { get: () => Promise.resolve(snapshot(states[call++])) },
      { sleep: (ms) => (sleeps.push(ms), Promise.resolve()) },
    );
    expect(result.state).toBe("completed");
    expect(call).toBe(4);
    expect(sleeps).toHaveLength(3);
  });

  it("returns on approval_required without throwing (a state, not an exception — D9)", async () => {
    const result = await waitForOperation(
      { get: () => Promise.resolve(snapshot("approval_required")) },
      { sleep: () => Promise.reject(new Error("must not sleep")) },
    );
    expect(result.state).toBe("approval_required");
  });

  it("keeps polling through cancellation_requested until a real terminal state lands (D7 race)", async () => {
    const states: OperationSnapshot["state"][] = ["cancellation_requested", "completed"];
    let call = 0;
    const result = await waitForOperation(
      { get: () => Promise.resolve(snapshot(states[call++])) },
      { sleep: () => Promise.resolve() },
    );
    expect(result.state).toBe("completed");
  });

  it("throws deadline_exceeded with the latest snapshot attached, never marking the op failed/cancelled", async () => {
    let now = 0;
    const err = await waitForOperation(
      { get: () => Promise.resolve(snapshot("running", { result: undefined })) },
      {
        waitDeadlineMs: 1000,
        now: () => now,
        sleep: (ms) => {
          now += ms;
          return Promise.resolve();
        },
      },
    ).catch((e: unknown) => e as AgenticError);

    expect(err).toBeInstanceOf(AgenticError);
    expect((err as AgenticError).kind).toBe("deadline_exceeded");
    const details = (err as AgenticError).details as { snapshot: OperationSnapshot };
    expect(details.snapshot.state).toBe("running");
  });

  it("uses the caller-injected jitter and pollIntervalMs (fixed-seed conformance per D4)", async () => {
    const states: OperationSnapshot["state"][] = ["running", "completed"];
    let call = 0;
    const sleeps: number[] = [];
    await waitForOperation(
      { get: () => Promise.resolve(snapshot(states[call++])) },
      {
        pollIntervalMs: 100,
        jitterMs: () => 7,
        sleep: (ms) => (sleeps.push(ms), Promise.resolve()),
      },
    );
    // attempt 0: base 100 * 2**0 + jitter 7 = 107, floor(server_hint=0) => 107, cap 30000 => 107
    expect(sleeps).toEqual([107]);
  });

  it("retries a retryable AgenticError thrown by get(), but propagates a non-retryable one immediately", async () => {
    let call = 0;
    const flaky = () => {
      call += 1;
      if (call === 1) {
        return Promise.reject(new AgenticError("transport", "transient blip", { retryable: true }));
      }
      return Promise.resolve(snapshot("completed"));
    };
    const result = await waitForOperation({ get: flaky }, { sleep: () => Promise.resolve() });
    expect(result.state).toBe("completed");
    expect(call).toBe(2);

    await expect(
      waitForOperation(
        { get: () => Promise.reject(new AgenticError("permission_denied", "nope", { retryable: false })) },
        { sleep: () => Promise.reject(new Error("must not sleep")) },
      ),
    ).rejects.toMatchObject({ kind: "permission_denied" });
  });

  it("throws cancelled without ever calling a remote cancel operation (D7: local wait cancel only)", async () => {
    const cancellation = { isCancelled: true };
    await expect(
      waitForOperation(
        { get: () => Promise.resolve(snapshot("running")) },
        { cancellation, sleep: () => Promise.reject(new Error("must not sleep")) },
      ),
    ).rejects.toMatchObject({ kind: "cancelled" });
  });
});
