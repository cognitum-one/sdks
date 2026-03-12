import type { CognitumConfig } from "./types.js";
import {
  CognitumError,
  AuthError,
  RateLimitError,
  ValidationError,
  NotFoundError,
} from "./errors.js";

const DEFAULT_BASE_URL =
  "https://us-central1-cognitum-20260110.cloudfunctions.net";
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;

/** Internal HTTP client that handles authentication, retries, and error mapping. */
export class HttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly retries: number;
  private readonly rateLimitRetry: boolean;

  constructor(config: CognitumConfig) {
    if (!config.apiKey) {
      throw new AuthError("API key is required");
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.retries = config.retries ?? DEFAULT_RETRIES;
    this.rateLimitRetry = config.rateLimitRetry ?? true;
  }

  /**
   * Perform an HTTP request against the Cognitum API.
   *
   * Automatically injects the API key header, serialises JSON bodies,
   * retries on transient errors with exponential back-off, and maps
   * HTTP error responses to typed SDK errors.
   */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
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

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      init.signal = controller.signal;

      try {
        const response = await fetch(url, init);
        clearTimeout(timer);

        if (response.ok) {
          // Handle 204 No Content
          if (response.status === 204) {
            return undefined as T;
          }
          return (await response.json()) as T;
        }

        // Map status codes to typed errors
        const errorBody = await response.text().catch(() => "");
        const errorMessage = tryParseErrorMessage(errorBody) ?? response.statusText;

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
            const retryAfterMs = parseRetryAfter(response);
            const err = new RateLimitError(retryAfterMs, errorMessage);
            if (!this.rateLimitRetry || attempt === this.retries) {
              throw err;
            }
            lastError = err;
            await sleep(retryAfterMs);
            continue;
          }
          default:
            // Retry on 500/502/503/504
            if (response.status >= 500 && attempt < this.retries) {
              lastError = new CognitumError(
                errorMessage,
                "SERVER_ERROR",
                response.status,
              );
              await sleep(backoff(attempt));
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

        // Abort / timeout
        if (error instanceof DOMException && error.name === "AbortError") {
          lastError = new CognitumError(
            "Request timed out",
            "TIMEOUT",
          );
          if (attempt < this.retries) {
            await sleep(backoff(attempt));
            continue;
          }
          throw lastError;
        }

        // Network errors — retry
        if (attempt < this.retries) {
          lastError = error instanceof Error ? error : new Error(String(error));
          await sleep(backoff(attempt));
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

    // Should not be reached, but satisfies TypeScript
    throw lastError ?? new CognitumError("Request failed", "UNKNOWN");
  }
}

/** Exponential back-off: 1s, 2s, 4s, ... */
function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 16_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse Retry-After header (seconds or date) into milliseconds. */
function parseRetryAfter(response: Response): number {
  const header = response.headers.get("Retry-After");
  if (!header) return 1000;

  const seconds = Number(header);
  if (!Number.isNaN(seconds)) {
    return seconds * 1000;
  }

  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.max(date - Date.now(), 0);
  }

  return 1000;
}

/** Attempt to extract an error message from a JSON response body. */
function tryParseErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Not JSON — ignore
  }
  return undefined;
}
