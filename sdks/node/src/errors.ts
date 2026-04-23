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

/**
 * Thrown when a caller requests a feature the seed does not (yet) implement.
 *
 * Today this surfaces when a per-call {@link CallOptions.consistency}
 * of `"strong"` is requested — ADR-0016a §D4 reserves the name for a
 * future Raft/Paxos write-quorum mode that seed firmware does not have.
 * The error is NOT retryable; no peer cycling, no backoff.
 */
export class UnsupportedError extends CognitumError {
  /** Feature identifier (e.g. `"consistency=strong"`). */
  readonly feature: string;

  constructor(feature: string, message?: string) {
    super(
      message ?? `unsupported: ${feature}`,
      "UNSUPPORTED",
    );
    this.name = "UnsupportedError";
    this.feature = feature;
  }
}

/**
 * Thrown when a peer's TLS certificate fails fingerprint pinning.
 *
 * The Node SDK parses `fp=sha256:<hex>` from the seed's mDNS TXT record
 * (per `seed/src/cognitum-agent/src/discovery.rs:155-162`, FINDING-28)
 * and pins the TLS handshake to that certificate. If the peer presents a
 * cert whose SHA-256 does not match the advertised fingerprint (the
 * classic mDNS-spoofing signal), the handshake aborts with this error.
 *
 * This error is NOT retryable and does NOT fall back to `tls.insecure`
 * — a fingerprint mismatch is a hard trust failure. The failover state
 * machine surfaces it verbatim so callers see the spoofing signal.
 */
export class TlsPinError extends CognitumError {
  /** Canonical peer URL that failed pinning. */
  readonly peerKey: string;
  /** Fingerprint the peer advertised (hex, lowercase, no colons). */
  readonly expectedFingerprint: string;
  /** SHA-256 of the cert the peer actually presented (hex, lowercase). */
  readonly actualFingerprint: string | undefined;

  constructor(
    peerKey: string,
    expectedFingerprint: string,
    actualFingerprint: string | undefined,
    message?: string,
  ) {
    super(
      message ??
        `TLS fingerprint mismatch for ${peerKey}: expected ${expectedFingerprint}, got ${actualFingerprint ?? "<unknown>"}`,
      "TLS_PIN_ERROR",
    );
    this.name = "TlsPinError";
    this.peerKey = peerKey;
    this.expectedFingerprint = expectedFingerprint;
    this.actualFingerprint = actualFingerprint;
  }
}

/**
 * Thrown when the SDK aborts a request to protect the seed's trust-score
 * state (ADR-0007 §Trust-score protection, resolves OQ-9).
 *
 * The seed locks a client out after 3 consecutive failed auth attempts.
 * To prevent the caller from burning that budget (and triggering seed
 * lockdown), the SDK short-circuits on the third consecutive `AuthError`
 * against the same peer, raising this error instead of making the 4th
 * request that would tip the seed into lockdown.
 *
 * This error is NOT retryable — the failover state machine must NOT
 * cycle to another peer on it. The counter resets on a 2xx success
 * from the same peer, or via `SeedClient.resetTrustScore(peerKey?)`.
 */
export class TrustScoreBlockedError extends CognitumError {
  /** Canonical URL key of the peer whose trust-score budget was exhausted. */
  readonly peerKey: string;
  /** Number of consecutive auth failures observed against `peerKey` (always 3). */
  readonly consecutiveFailures: 3;
  /**
   * `null` marker — intentionally not retryable. Exposed so tooling
   * that inspects `retryableAfter` on transient errors sees a definite
   * "do not retry" signal rather than `undefined` (which could be
   * mistaken for "retry immediately").
   */
  readonly retryableAfter: null;

  constructor(peerKey: string, message?: string) {
    super(
      message ??
        `trust-score blocked: aborting before 4th consecutive auth failure would trigger seed lockdown (peer=${peerKey})`,
      "TRUST_SCORE_BLOCKED",
    );
    this.name = "TrustScoreBlockedError";
    this.peerKey = peerKey;
    this.consecutiveFailures = 3;
    this.retryableAfter = null;
  }
}
