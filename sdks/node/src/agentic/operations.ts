/**
 * OperationHandle / OperationState and transport-neutral pagination /
 * event-stream primitives (ADR-0019 §D5, ADR-0023 §D9), plus a shared
 * `waitForOperation` polling-loop helper (ADR-0023 §D8/§D9, issue #55).
 *
 * The event-stream resumption behavior described in ADR-0023 §D6
 * (boundary-event dedup, gap/regression detection, `Last-Event-ID` replay)
 * deliberately does NOT ship here — every durable-operation client that
 * would consume it (HarnessaaS async jobs, Meta-LLM batches, Meta-Proxy
 * sponsor ops) is still blocked on its own upstream contract landing
 * (issues #59, #62, #68). Designing that resumption logic without a real
 * consumer to validate it against risks freezing the wrong contract —
 * see the M1 cross-language consistency review's fail-closed philosophy.
 */

import { AgenticError, DEFAULT_RETRY_POLICY, equalJitterDelayMs, type RetryPolicy } from "./errors.js";

/** Native lifecycle states for a durable remote operation (ADR-0023 §D9). */
export type OperationState =
  | "pending"
  | "running"
  | "approval_required"
  | "completed"
  | "failed"
  | "cancelled"
  | "cancellation_requested";

/** A point-in-time view of a durable operation, including terminal failures. */
export interface OperationSnapshot<TResult = unknown> {
  id: string;
  state: OperationState;
  result?: TResult;
  error?: AgenticError;
  updatedAt: string;
}

/** Options controlling {@link OperationHandle.wait}. */
export interface WaitOptions {
  waitDeadlineMs?: number;
  pollIntervalMs?: number;
}

/** Options controlling {@link OperationHandle.events}. */
export interface EventStreamOptions {
  lastEventId?: string;
  idleTimeoutMs?: number;
}

/** A single durable-operation event (ADR-0023 §D6). */
export interface OperationEvent<TPayload = unknown> {
  id: string;
  type: string;
  sequence?: number;
  occurredAt: string;
  payload: TPayload;
}

/**
 * Common handle contract for remote batches, pods, and HarnessaaS jobs
 * (ADR-0023 §D9). `events` is only present when the product capability set
 * declares event-stream support — see ADR-0019 §D6.
 *
 * `cancel` is always present but MUST fail closed — implementations that
 * don't support cancellation MUST reject with `UnsupportedCapabilityError`
 * (see `./errors.js`) rather than omitting the method or silently no-oping
 * (FIX 4 of the M1 cross-language consistency review, per ADR-0019 §D6's
 * fail-closed philosophy; Rust's default `OperationHandle::cancel` already
 * does this and is the reference behavior).
 */
export interface OperationHandle<TResult = unknown> {
  readonly id: string;
  readonly product: string;
  readonly originBinding: string;
  readonly tenantBinding?: string;
  readonly createdAt: string;

  get(): Promise<OperationSnapshot<TResult>>;
  wait(options?: WaitOptions): Promise<OperationSnapshot<TResult>>;
  events?(options?: EventStreamOptions): AsyncIterable<OperationEvent>;
  cancel(): Promise<OperationSnapshot<TResult>>;
  result(): Promise<TResult>;
}

/** Cursor-based page request, independent of transport (HTTP query, RPC field, etc.). */
export interface PageRequest {
  cursor?: string;
  limit?: number;
}

/** A single page of results. */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
}

/**
 * Snapshot states that end a {@link waitForOperation} poll loop
 * (ADR-0023 §D9). `approval_required` is included per D9's "Approval-
 * required is a state, not an exception" — polling further can't resolve
 * it without out-of-band human action, so it's returned like any other
 * terminal snapshot rather than awaited through.
 */
const WAIT_TERMINAL_STATES: ReadonlySet<OperationState> = new Set([
  "completed",
  "failed",
  "cancelled",
  "approval_required",
]);

/** Options controlling {@link waitForOperation}, beyond the {@link WaitOptions} passed to it. */
export interface WaitForOperationOptions extends WaitOptions {
  /** Retry/backoff shape for the poll cadence (ADR-0023 §D4). Defaults to {@link DEFAULT_RETRY_POLICY}. */
  retryPolicy?: RetryPolicy;
  /** Local-only cancellation (ADR-0023 §D7) — never sends a remote cancel. */
  cancellation?: { readonly isCancelled: boolean };
  /**
   * Injectable clock, milliseconds. Defaults to the monotonic
   * `performance.now()` (available in Node, browsers, Deno, and Bun via
   * the standard Performance API) rather than `Date.now()`, since a wall
   * clock can jump backward or forward (NTP step, VM suspend/resume)
   * mid-wait and corrupt the elapsed-time comparison against
   * `waitDeadlineMs`.
   */
  now?: () => number;
  /** Injectable sleep, for deterministic tests. Defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter per attempt (ADR-0023 §D4's caller-injected jitter for fixed-seed conformance fixtures). Defaults to 0. */
  jitterMs?: (attempt: number) => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Product-agnostic polling loop implementing {@link OperationHandle.wait}'s
 * shared semantics (ADR-0023 §D8/§D9): bounded equal-jitter backoff (the
 * exact algorithm ADR-0005/ADR-0023 already freeze — see
 * `equalJitterDelayMs`), a `waitDeadlineMs` ceiling that raises
 * `deadline_exceeded` with the latest snapshot attached (never marks the
 * remote operation itself failed or cancelled), and early return on any
 * terminal state (including `approval_required`, per D9). Poll iterations
 * are bounded only by the wait deadline, not `retryPolicy.maxAttempts` —
 * that field governs a single HTTP request's retry budget, a distinct
 * concern from "keep checking a long-running job" (D9: "not counted as
 * retrying the operation itself").
 *
 * A concrete `OperationHandle` implementation's own `wait()` method is
 * expected to delegate to this helper rather than re-implementing backoff
 * by hand — this is the "same bounded jitter policy" D9 requires every
 * product client to share.
 *
 * Not implemented here: D9's "state regression, identity change, or a
 * second different terminal state is a ProtocolError" — detecting that
 * requires a real durable-operation client to observe actual regression
 * behavior against, same rationale as this module's D6 deferral above.
 */
export async function waitForOperation<TResult>(
  handle: Pick<OperationHandle<TResult>, "get">,
  options?: WaitForOperationOptions,
): Promise<OperationSnapshot<TResult>> {
  const policy = options?.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const now = options?.now ?? defaultNow;
  const sleep = options?.sleep ?? defaultSleep;
  const jitterMs = options?.jitterMs ?? (() => 0);
  const waitDeadlineMs = options?.waitDeadlineMs;
  const pollIntervalPolicy: RetryPolicy =
    options?.pollIntervalMs !== undefined ? { ...policy, baseMs: options.pollIntervalMs } : policy;

  const startedAt = now();
  let attempt = 0;
  let lastSnapshot: OperationSnapshot<TResult> | undefined;

  for (;;) {
    if (options?.cancellation?.isCancelled) {
      throw new AgenticError("cancelled", "waitForOperation cancelled locally", {
        retryable: false,
        details: lastSnapshot ? { snapshot: lastSnapshot } : undefined,
      });
    }

    let snapshot: OperationSnapshot<TResult>;
    try {
      snapshot = await handle.get();
    } catch (cause) {
      // Poll transient failures consume the wait budget, not the request's
      // own HTTP retry budget (D9) — a non-retryable failure propagates
      // immediately; a retryable one falls through to the same backoff
      // loop bounded by waitDeadlineMs below.
      if (!(cause instanceof AgenticError) || !cause.retryable) throw cause;
      snapshot = lastSnapshot ?? { id: "", state: "pending", updatedAt: new Date(now()).toISOString() };
    }
    lastSnapshot = snapshot;

    if (WAIT_TERMINAL_STATES.has(snapshot.state)) return snapshot;

    if (waitDeadlineMs !== undefined && now() - startedAt >= waitDeadlineMs) {
      throw new AgenticError(
        "deadline_exceeded",
        `waitForOperation exceeded waitDeadlineMs=${waitDeadlineMs} without reaching a terminal state`,
        { retryable: false, details: { snapshot: lastSnapshot } },
      );
    }

    const delayMs = equalJitterDelayMs(attempt, pollIntervalPolicy, 0, jitterMs(attempt));
    await sleep(delayMs);
    attempt += 1;
  }
}
