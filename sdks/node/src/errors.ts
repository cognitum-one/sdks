/** Base error class for all Cognitum SDK errors. */
export class CognitumError extends Error {
  /** Machine-readable error code. */
  readonly code: string;
  /** HTTP status code, if applicable. */
  readonly statusCode?: number;

  constructor(message: string, code: string, statusCode?: number) {
    super(message);
    this.name = "CognitumError";
    this.code = code;
    this.statusCode = statusCode;
    // Maintain proper prototype chain for instanceof checks.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when the API key is missing or invalid (HTTP 401 / 403). */
export class AuthError extends CognitumError {
  constructor(message = "Authentication failed") {
    super(message, "AUTH_ERROR", 401);
    this.name = "AuthError";
  }
}

/** Thrown when the client is rate-limited (HTTP 429). */
export class RateLimitError extends CognitumError {
  /** Milliseconds to wait before retrying, parsed from Retry-After header. */
  readonly retryAfterMs: number;

  constructor(retryAfterMs = 1000, message = "Rate limit exceeded") {
    super(message, "RATE_LIMIT", 429);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Thrown when a request fails validation (HTTP 400 / 422). */
export class ValidationError extends CognitumError {
  constructor(message = "Validation failed") {
    super(message, "VALIDATION_ERROR", 400);
    this.name = "ValidationError";
  }
}

/** Thrown when the requested resource does not exist (HTTP 404). */
export class NotFoundError extends CognitumError {
  constructor(message = "Resource not found") {
    super(message, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Extended taxonomy — added 2026-04-22 per ADR-0004 for seed client surface.
// Kept additive; pre-existing classes above are unchanged for cloud paths.
// ---------------------------------------------------------------------------

/** Thrown when a state conflict blocks the request (HTTP 409). */
export class ConflictError extends CognitumError {
  constructor(message = "Conflict") {
    super(message, "CONFLICT", 409);
    this.name = "ConflictError";
  }
}

/** Thrown when an endpoint or feature isn't implemented by the server (HTTP 501). */
export class NotImplementedError extends CognitumError {
  /** Path or feature that is not implemented. */
  readonly endpoint?: string;

  constructor(endpoint?: string, message?: string) {
    super(message ?? `Not implemented${endpoint ? `: ${endpoint}` : ""}`, "NOT_IMPLEMENTED", 501);
    this.name = "NotImplementedError";
    this.endpoint = endpoint;
  }
}

/** Thrown when the server is temporarily unavailable (HTTP 503). */
export class ServiceUnavailableError extends CognitumError {
  /** Milliseconds to wait before retrying, if the server hinted. */
  readonly retryAfterMs?: number;

  constructor(retryAfterMs?: number, message = "Service unavailable") {
    super(message, "UNAVAILABLE", 503);
    this.name = "ServiceUnavailableError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Thrown when a low-level connect / socket / DNS failure prevents the request. */
export class NetworkError extends CognitumError {
  constructor(message = "Network error", cause?: unknown) {
    super(message, "NETWORK_ERROR");
    this.name = "NetworkError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/** Thrown when a request exceeds its timeout budget. */
export class TimeoutError extends CognitumError {
  /** Which phase of the request timed out. */
  readonly phase: "connect" | "read" | "total";

  constructor(phase: "connect" | "read" | "total" = "total", message?: string) {
    super(message ?? `Request timed out (phase=${phase})`, "TIMEOUT");
    this.name = "TimeoutError";
    this.phase = phase;
  }
}

/** Thrown when the SDK cannot parse a response body. */
export class ParseError extends CognitumError {
  readonly expected?: string;

  constructor(expected?: string, message?: string) {
    super(message ?? `Failed to parse response${expected ? ` (expected ${expected})` : ""}`, "PARSE_ERROR");
    this.name = "ParseError";
    this.expected = expected;
  }
}

/** Thrown when the SDK is handed an invalid configuration. */
export class ConfigError extends CognitumError {
  constructor(message = "Invalid configuration") {
    super(message, "CONFIG_ERROR");
    this.name = "ConfigError";
  }
}
