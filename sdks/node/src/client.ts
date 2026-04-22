import type { CognitumConfig } from "./types.js";
import {
  CognitumError,
  AuthError,
  RateLimitError,
  ValidationError,
  NotFoundError,
} from "./errors.js";

const DEFAULT_BASE_URL = "https://api.cognitum.one";
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;

// ADR-0005 retry constants (equal-jitter, 500 ms base, 30 s cap, 60 s budget).
const BASE_MS = 500;
const CAP_MS = 30_000;
const DEFAULT_MAX_ELAPSED_MS = 60_000;

const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Optional per-request options. */
export interface RequestOpts {
  /**
   * Whether retrying this request after a read / total timeout is safe.
   *
   * Defaults:
   * - GET / HEAD / OPTIONS / PUT / DELETE: `true`
   * - POST: `false` (POSTs MAY have side-effects; silently double-executing
   *   on a retry would violate ADR-0005 §"idempotency guard").
   *
   * Resource bindings that POST to a server-side-idempotent endpoint
   * (e.g. keyed inserts) may opt in explicitly with `{ idempotent: true }`.
   */
  idempotent?: boolean;
}

/** Internal HTTP client that handles authentication, retries, and error mapping. */
export class HttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly retries: number;
  private readonly rateLimitRetry: boolean;
  private readonly maxElapsedMs: number;

  constructor(config: CognitumConfig) {
    const resolved = resolveApiKey(config.apiKey);
    this.apiKey = resolved;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.retries = config.retries ?? DEFAULT_RETRIES;
    this.rateLimitRetry = config.rateLimitRetry ?? true;
    this.maxElapsedMs = config.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS;
  }

  /**
   * Perform an HTTP request against the Cognitum API.
   *
   * Automatically injects the API key header, serialises JSON bodies,
   * retries on transient errors with equal-jitter back-off per ADR-0005,
   * and maps HTTP error responses to typed SDK errors.
   */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: RequestOpts,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
      Accept: "application/json",
    };

    const init: RequestInit & { signal?: AbortSignal } = { method, headers };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const methodUpper = method.toUpperCase();
    const idempotent = opts?.idempotent ?? (methodUpper !== "POST");
    const started = Date.now();
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      init.signal = controller.signal;

      try {
        const response = await fetch(url, init);
        clearTimeout(timer);

        if (response.ok) {
          if (response.status === 204) {
            return undefined as T;
          }
          return (await response.json()) as T;
        }

        // Map status codes to typed errors. We read the body once as text so
        // we can parse both an error-message envelope AND, on 429, the
        // seed-style `retry_after_us` / "retry after Ns" hints.
        const errorBody = await response.text().catch(() => "");
        const errorMessage =
          tryParseErrorMessage(errorBody) ?? response.statusText;

        switch (response.status) {
          case 401:
          case 403:
            throw new AuthError(errorMessage);
          case 404:
            throw new NotFoundError(errorMessage);
          case 400:
          case 422:
            throw new ValidationError(errorMessage);
          case 429: {
            const retryAfterMs = resolveRetryAfter(response, errorBody);
            const err = new RateLimitError(retryAfterMs, errorMessage);
            if (
              !this.rateLimitRetry ||
              !canRetry(attempt, this.retries, started, this.maxElapsedMs)
            ) {
              throw err;
            }
            lastError = err;
            await sleep(
              clampToBudget(retryAfterMs, started, this.maxElapsedMs),
            );
            continue;
          }
          default:
            // Non-idempotent POSTs MUST NOT auto-retry on 5xx: the server
            // already received the body and may have committed — retrying
            // would silently double-execute (ADR-0005 §idempotency guard).
            if (
              RETRIABLE_STATUS.has(response.status) &&
              idempotent &&
              canRetry(attempt, this.retries, started, this.maxElapsedMs)
            ) {
              lastError = new CognitumError(
                errorMessage,
                "SERVER_ERROR",
                response.status,
              );
              await sleep(
                clampToBudget(
                  equalJitterBackoff(attempt),
                  started,
                  this.maxElapsedMs,
                ),
              );
              continue;
            }
            throw new CognitumError(
              errorMessage,
              "SERVER_ERROR",
              response.status,
            );
        }
      } catch (error) {
        clearTimeout(timer);

        // Don't retry typed client errors
        if (
          error instanceof AuthError ||
          error instanceof NotFoundError ||
          error instanceof ValidationError
        ) {
          throw error;
        }

        // Rethrow rate limit if we've exhausted retries
        if (error instanceof RateLimitError) {
          throw error;
        }

        // A `CognitumError` surfaced from the status-code switch (5xx that
        // fell through `RETRIABLE_STATUS` + `idempotent` gating) means the
        // retry decision was already made — don't second-guess it here.
        if (error instanceof CognitumError && error.code === "SERVER_ERROR") {
          throw error;
        }

        // Abort / timeout — ADR-0005 §"idempotency guard": a read / total
        // timeout on a non-idempotent POST must NOT retry, because the
        // server may have already processed the request and the retry
        // would silently double-execute.
        if (error instanceof DOMException && error.name === "AbortError") {
          lastError = new CognitumError("Request timed out", "TIMEOUT");
          if (
            idempotent &&
            canRetry(attempt, this.retries, started, this.maxElapsedMs)
          ) {
            await sleep(
              clampToBudget(
                equalJitterBackoff(attempt),
                started,
                this.maxElapsedMs,
              ),
            );
            continue;
          }
          throw lastError;
        }

        // Network errors — retry even on POST (server never saw the body).
        if (canRetry(attempt, this.retries, started, this.maxElapsedMs)) {
          lastError =
            error instanceof Error ? error : new Error(String(error));
          await sleep(
            clampToBudget(
              equalJitterBackoff(attempt),
              started,
              this.maxElapsedMs,
            ),
          );
          continue;
        }

        if (error instanceof CognitumError) {
          throw error;
        }
        throw new CognitumError(
          error instanceof Error ? error.message : String(error),
          "NETWORK_ERROR",
        );
      }
    }

    throw lastError ?? new CognitumError("Request failed", "UNKNOWN");
  }
}

/**
 * Resolve the cloud API key.
 *
 * Order (ADR-0015b §7):
 *   1. explicit `config.apiKey`
 *   2. `process.env.COGNITUM_API_KEY`
 *   3. throw `AuthError` with a message that mentions BOTH sources.
 *
 * The resolved key is NEVER logged.
 */
function resolveApiKey(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  const fromEnv = typeof process !== "undefined"
    ? process.env?.COGNITUM_API_KEY
    : undefined;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  throw new AuthError(
    "apiKey is required — pass config.apiKey or set COGNITUM_API_KEY",
  );
}

/**
 * Equal-jitter back-off per ADR-0005:
 *     delay = min(cap, base * 2^attempt + random(0, base))
 */
export function equalJitterBackoff(attempt: number): number {
  const expo = BASE_MS * 2 ** attempt;
  const jitter = Math.random() * BASE_MS;
  return Math.min(CAP_MS, expo + jitter);
}

/** Break the retry loop if elapsed since first attempt ≥ budget. */
function canRetry(
  attempt: number,
  retries: number,
  startedAt: number,
  maxElapsedMs: number,
): boolean {
  if (attempt >= retries) return false;
  return Date.now() - startedAt < maxElapsedMs;
}

/** Clamp a sleep so we never overshoot the wall-clock budget. */
function clampToBudget(
  delayMs: number,
  startedAt: number,
  maxElapsedMs: number,
): number {
  const remaining = maxElapsedMs - (Date.now() - startedAt);
  if (remaining <= 0) return 0;
  return Math.max(0, Math.min(delayMs, remaining));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the 429 wait hint.
 *
 * ADR-0005 §"429 handling (seed specific)" — the seed sometimes emits the
 * hint ONLY in the JSON body (`retry_after_us` or "retry after Ns"), and
 * some proxies strip `Retry-After`. Therefore body signals WIN over the
 * header when both are present. Falls back to 1 s if neither source gives
 * a usable hint.
 */
export function resolveRetryAfter(response: Response, body: string): number {
  const fromBody = parseRetryAfterBody(body);
  if (fromBody !== undefined) return fromBody;
  const fromHeader = parseRetryAfterHeader(
    response.headers.get("Retry-After"),
  );
  if (fromHeader !== undefined) return fromHeader;
  return 1000;
}

/** Parse standard HTTP `Retry-After` (seconds or HTTP-date). */
export function parseRetryAfterHeader(h: string | null): number | undefined {
  if (!h) return undefined;
  const seconds = Number(h);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(h);
  if (!Number.isNaN(date)) {
    return Math.max(date - Date.now(), 0);
  }
  return undefined;
}

/**
 * Parse the seed-specific 429 body (ADR-0005 §"429 handling (seed specific)"):
 *   { "retry_after_us": 2500000 }
 *   { "error": "rate limited — retry after 3s" }
 * or plain text containing "retry after Ns".
 *
 * Returns milliseconds, or `undefined` if nothing matched.
 */
export function parseRetryAfterBody(body: string): number | undefined {
  if (!body) return undefined;
  // JSON path first.
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.retry_after_us === "number") {
        return Math.round(parsed.retry_after_us / 1000);
      }
      const hints: unknown[] = [parsed.error, parsed.message];
      for (const h of hints) {
        if (typeof h === "string") {
          const n = extractRetryAfterSeconds(h);
          if (n !== undefined) return n;
        }
      }
    }
  } catch {
    // fall through to plain-text scan
  }
  return extractRetryAfterSeconds(body);
}

function extractRetryAfterSeconds(text: string): number | undefined {
  const m = /retry after (\d+(?:\.\d+)?)\s*s/i.exec(text);
  if (!m) return undefined;
  const seconds = Number(m[1]);
  if (Number.isNaN(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

/** Attempt to extract an error message from a JSON response body. */
function tryParseErrorMessage(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Not JSON — ignore
  }
  return undefined;
}
