/**
 * `ProxyTimeBudget` (ADR-0025a §D8):
 *
 * ```text
 * ProxyTimeBudget {
 *   connect_timeout,
 *   first_byte_timeout,
 *   idle_stream_timeout,
 *   overall_deadline
 * }
 * ```
 *
 * §D8: "The process currently uses a 10-second connect timeout and no
 * overall timeout. The SDK supplies cancellation and an optional overall
 * deadline. Timing out one request never kills the Proxy." — so
 * `connectTimeoutMs` has a documented 10s default (matching the deployed
 * Proxy's own connect-timeout behavior) while `overallDeadlineMs` has NO
 * default: it is caller-supplied only, and its absence means "no overall
 * timeout" exactly as today.
 *
 * This is a Proxy-specific type distinct from ADR-0023's generic
 * `TimeBudget` (`../agentic/index.js`) — ADR-0025a names exactly these four
 * fields, no more — even though the streaming implementation in
 * `./stream/chat-completions-stream.js` internally applies the identical
 * "race the blocking read against the smallest remaining budget" pattern
 * PR #88 proved correct for direct `MetaLlmClient` streaming.
 */

/** Caller-supplied time budget for one Proxy chat/Messages call (ADR-0025a §D8). */
export interface ProxyTimeBudget {
  /**
   * Bounds each HTTP attempt (initial POST, and the at-most-one 401-refresh
   * retry) from send until a response begins arriving. Defaults to
   * {@link DEFAULT_PROXY_CONNECT_TIMEOUT_MS} when omitted, matching the
   * Proxy's own documented 10-second connect timeout (§D8).
   */
  connectTimeoutMs?: number;
  /** Bounds the wait for the first SSE body byte after a response begins. No default. */
  firstByteTimeoutMs?: number;
  /** Bounds the wait between subsequent SSE body bytes once streaming has started. No default. */
  idleStreamTimeoutMs?: number;
  /**
   * Bounds the ENTIRE call (pre-byte connect/retry phase plus the full
   * streaming read) from the moment the caller invokes the method. No
   * default — §D8: "The SDK supplies cancellation and an optional overall
   * deadline," i.e. omission means no overall timeout, exactly matching
   * today's undocumented-but-real Proxy behavior.
   */
  overallDeadlineMs?: number;
}

/** Matches the Proxy's own documented connect-timeout behavior (ADR-0025a §D8, Context). */
export const DEFAULT_PROXY_CONNECT_TIMEOUT_MS = 10_000;

/** {@link ProxyTimeBudget} after defaulting — `connectTimeoutMs` is always present. */
export interface ResolvedProxyTimeBudget {
  connectTimeoutMs: number;
  firstByteTimeoutMs?: number;
  idleStreamTimeoutMs?: number;
  overallDeadlineMs?: number;
}

/** Apply {@link DEFAULT_PROXY_CONNECT_TIMEOUT_MS}; every other field passes through unchanged. */
export function resolveProxyTimeBudget(budget?: ProxyTimeBudget): ResolvedProxyTimeBudget {
  return {
    connectTimeoutMs: budget?.connectTimeoutMs ?? DEFAULT_PROXY_CONNECT_TIMEOUT_MS,
    firstByteTimeoutMs: budget?.firstByteTimeoutMs,
    idleStreamTimeoutMs: budget?.idleStreamTimeoutMs,
    overallDeadlineMs: budget?.overallDeadlineMs,
  };
}
