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
