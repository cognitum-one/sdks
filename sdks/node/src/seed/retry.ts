/**
 * Equal-jitter backoff loop — implements ADR-0005 exactly.
 *
 *   base = 500 ms, cap = 30 s, max elapsed = 60 s
 *   delay = min(cap, expo(attempt) + random(0, base))
 *   honour 429 Retry-After + retry_after_us hints
 *   POST only retries when `idempotent: true`
 */

import {
  AuthError,
  ConflictError,
  NetworkError,
  NotFoundError,
  NotImplementedError,
  ParseError,
  RateLimitError,
  ServiceUnavailableError,
  TimeoutError,
  ValidationError,
  CognitumError,
} from "../errors.js";

export const BASE_MS = 500;
export const CAP_MS = 30_000;
export const DEFAULT_MAX_ELAPSED_MS = 60_000;

export interface RetryConfig {
  /** Attempts beyond the first (0 means fire-and-fail). */
  retries: number;
  /** Total wall-clock ceiling across all attempts. */
  maxElapsedMs: number;
  /** Whether to retry 429 responses (default true). */
  rateLimitRetry: boolean;
  /** HTTP method — non-POST is always retryable on transient errors. */
  method: string;
  /**
   * Idempotency flag — POSTs with side effects must set this to `false`
   * so that read-timeouts don't silently double-execute. GETs default
   * to `true` in the resource bindings.
   */
  idempotent: boolean;
  /** Optional debug logger — receives `{attempt, next_delay_ms, reason}`. */
  logger?: { debug?: (rec: Record<string, unknown>) => void };
}

export interface RetryLog {
  attempt: number;
  next_delay_ms: number;
  reason: string;
  path: string;
}

/**
 * Run `op(attempt)` up to `cfg.retries + 1` times, backing off on
 * transient failures. Returns on first success; throws on the last
 * non-retryable or budget-exhausted error.
 *
 * Exported for test access. The seed client passes a path-only label
 * (no host, no query) for privacy-safe debug logs.
 */
export async function runWithRetry<T>(
  op: (attempt: number) => Promise<T>,
  cfg: RetryConfig,
  pathForLog: string,
): Promise<T> {
  const started = Date.now();
  let attempt = 0;

  for (;;) {
    try {
      return await op(attempt);
    } catch (err) {
      const elapsed = Date.now() - started;
      const { retriable, hintMs } = classify(err, cfg);
      const outOfBudget =
        attempt >= cfg.retries || elapsed >= cfg.maxElapsedMs;
      if (!retriable || outOfBudget) throw err;

      const expo = BASE_MS * 2 ** attempt;
      const jitter = Math.random() * BASE_MS; // equal-jitter
      const computed = Math.min(CAP_MS, expo + jitter);
      const delay = Math.max(computed, hintMs ?? 0);
      const remaining = cfg.maxElapsedMs - elapsed;

      cfg.logger?.debug?.({
        attempt,
        next_delay_ms: Math.min(delay, remaining),
        reason: (err as Error).name,
        path: pathForLog,
      } satisfies RetryLog);

      await sleep(Math.min(delay, Math.max(0, remaining)));
      attempt += 1;
    }
  }
}

/** Decide whether a thrown error is retryable per ADR-0005. */
export function classify(
  err: unknown,
  cfg: Pick<RetryConfig, "rateLimitRetry" | "method" | "idempotent">,
): { retriable: boolean; hintMs?: number } {
  if (err instanceof RateLimitError) {
    return { retriable: cfg.rateLimitRetry, hintMs: err.retryAfterMs };
  }
  if (err instanceof ServiceUnavailableError) {
    return { retriable: true, hintMs: err.retryAfterMs };
  }
  if (err instanceof NetworkError) {
    // Connect-fail / socket reset: retryable on any method (server never
    // saw the body, so non-idempotent POSTs are safe).
    return { retriable: true };
  }
  if (err instanceof TimeoutError) {
    if (err.phase === "connect") return { retriable: true };
    // Read/total timeouts on a POST: only retry if caller asserted idempotence.
    if (cfg.method.toUpperCase() === "POST" && !cfg.idempotent) {
      return { retriable: false };
    }
    return { retriable: true };
  }
  if (err instanceof CognitumError) {
    const sc = err.statusCode;
    // 5xx (excluding 501 Not Implemented, already mapped) are retryable.
    if (sc !== undefined && sc >= 500 && sc !== 501) {
      return { retriable: true };
    }
  }
  if (
    err instanceof AuthError ||
    err instanceof ValidationError ||
    err instanceof NotFoundError ||
    err instanceof ConflictError ||
    err instanceof NotImplementedError ||
    err instanceof ParseError
  ) {
    return { retriable: false };
  }
  return { retriable: false };
}

/**
 * Parse a standard HTTP `Retry-After` header into milliseconds.
 * Accepts integer-seconds, float-seconds, or an HTTP-date.
 */
export function parseRetryAfterHeader(h: string | null): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (!Number.isNaN(secs) && secs >= 0) return Math.round(secs * 1000);
  const date = Date.parse(h);
  if (!Number.isNaN(date)) return Math.max(date - Date.now(), 0);
  return undefined;
}

/**
 * Parse the seed-specific JSON body on a 429 per ADR-0005 §"429 handling".
 *   { "error": "rate limited — retry after 2s", "retry_after_us": 2000000 }
 *
 * Returns milliseconds, or `undefined` if the body doesn't match.
 */
export function parseSeedRetryAfter(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const rec = body as Record<string, unknown>;
  if (typeof rec.retry_after_us === "number") {
    return Math.round(rec.retry_after_us / 1000);
  }
  if (typeof rec.error === "string") {
    const m = /retry after (\d+)\s*s/i.exec(rec.error);
    if (m) return Number(m[1]) * 1000;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
