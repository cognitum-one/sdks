/**
 * Shared agentic error taxonomy and retry classification (ADR-0023 §D1, §D3).
 * Type-only scaffolding — issue #52 / M1. No retry loop implementation ships
 * here; concrete HTTP mapping lands with each product client.
 */

/** Agentic extension of the ADR-0004 base error kind enumeration (ADR-0023 §D1). */
export type AgenticErrorKind =
  | "configuration"
  | "authentication"
  | "permission_denied"
  | "not_found"
  | "validation"
  | "conflict"
  | "rate_limited"
  | "budget_exceeded"
  | "safety_blocked"
  | "consent_required"
  | "unsupported_capability"
  | "protocol"
  | "integrity"
  | "isolation_unavailable"
  | "transport"
  | "deadline_exceeded"
  | "cancelled"
  | "process_failed"
  | "operation_failed"
  | "unknown";

/** Operation retry classification (ADR-0023 §D3). A status code alone is never sufficient. */
export type OperationRetryClass =
  | "safe_read"
  | "idempotent_mutation"
  | "idempotent_with_key"
  | "non_idempotent"
  | "streaming"
  | "local_process";

/**
 * Common failure shape shared by every agentic product (ADR-0023 §D1).
 *
 * `message`, `details`, and `cause` MUST be redacted by the caller before
 * this type is constructed for exposure — this base class does not perform
 * redaction itself (see `SecretRedactor` in `./credentials.js` for that
 * contract).
 */
export class AgenticError extends Error {
  readonly kind: AgenticErrorKind;
  readonly product?: string;
  readonly operation?: string;
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly protocolVersion?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly attemptCount?: number;
  readonly details?: unknown;
  /**
   * Underlying cause of this error, wired through to the native ES2022
   * `Error.cause` (this repo requires Node >=18, which supports it).
   * Mirrors Python's `cause: BaseException | None` (wired to
   * `self.__cause__`) and Rust's `cause: Option<String>` (FIX 2 of the M1
   * cross-language consistency review — Node previously had no equivalent
   * field).
   */
  declare readonly cause?: unknown;

  constructor(
    kind: AgenticErrorKind,
    message: string,
    fields?: Partial<
      Omit<AgenticError, "kind" | "message" | "name" | "retryable"> & {
        retryable: boolean;
      }
    >,
  ) {
    super(message, { cause: fields?.cause });
    this.name = "AgenticError";
    this.kind = kind;
    this.product = fields?.product;
    this.operation = fields?.operation;
    this.status = fields?.status;
    this.code = fields?.code;
    this.requestId = fields?.requestId;
    this.correlationId = fields?.correlationId;
    this.protocolVersion = fields?.protocolVersion;
    this.retryable = fields?.retryable ?? false;
    this.retryAfterMs = fields?.retryAfterMs;
    this.attemptCount = fields?.attemptCount;
    this.details = fields?.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Fail-closed error raised when a required capability is absent or unknown
 * (ADR-0019 §D6). MUST be raised before any spend, mutation, consent, or
 * code-execution side effect.
 */
export class UnsupportedCapabilityError extends AgenticError {
  readonly capability: string;

  constructor(
    product: string,
    operation: string,
    capability: string,
    message?: string,
  ) {
    super(
      "unsupported_capability",
      message ??
        `capability "${capability}" is unsupported or unknown for ${product}/${operation}`,
      { product, operation, retryable: false },
    );
    this.name = "UnsupportedCapabilityError";
    this.capability = capability;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Retry-policy shape (ADR-0023 §D4). Values MUST match ADR-0005's
 * equal-jitter formula verbatim; agentic modules MUST NOT diverge from it.
 */
export interface RetryPolicy {
  baseMs: number;
  capMs: number;
  maxAttempts: number;
  retrySleepBudgetMs: number;
}

/** Canonical defaults: 500 ms base, 30 s cap, 4 total attempts, 60 s sleep budget. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseMs: 500,
  capMs: 30_000,
  maxAttempts: 4,
  retrySleepBudgetMs: 60_000,
};

/**
 * Pure equal-jitter backoff calculation, ADR-0005/ADR-0023 verbatim:
 *
 * ```text
 * delay_ms(attempt) = min(cap_ms, max(server_hint_ms, base_ms * 2**attempt + jitter))
 * ```
 *
 * `jitterMs` is caller-injected (rather than internally randomized) so
 * cross-language conformance fixtures can assert exact values with a fixed
 * seed, per ADR-0023's compliance note on injected clocks/randomness.
 */
export function equalJitterDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  serverHintMs = 0,
  jitterMs = 0,
): number {
  const expo = policy.baseMs * 2 ** attempt;
  const clampedJitter = Math.min(Math.max(jitterMs, 0), policy.baseMs);
  const computed = expo + clampedJitter;
  const floor = Math.max(serverHintMs, computed);
  return Math.min(policy.capMs, floor);
}

/** Idempotency-key binding contract (ADR-0023 §D5). */
export interface IdempotencyBindingV1 {
  authenticatedPrincipal: string;
  tenantContext?: string;
  delegatedSubtenantContext?: string;
  httpMethod: string;
  normalizedRouteIdentity: string;
  canonicalRequestSha256: string;
  idempotencyKey: string;
  contractMajor: number;
}

/** Why a {@link CancellationToken} was cancelled (ADR-0023 §D7). */
export type CancellationReason = "caller" | "deadline" | "shutdown";

/**
 * Transport-neutral cancellation contract. Distinct from "cancel remote
 * operation" and "terminate local process" — see `OperationHandle` in
 * `./operations.js`.
 */
export interface CancellationToken {
  readonly isCancelled: boolean;
  readonly reason?: CancellationReason;
}

/** Time-budget model (ADR-0023 §D8). Timeouts are separate values, never one shared 30s default. */
export interface TimeBudget {
  connectTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  idleTimeoutMs?: number;
  requestDeadlineMs?: number;
  waitDeadlineMs?: number;
  cancelGraceMs?: number;
  retrySleepBudgetMs?: number;
}
