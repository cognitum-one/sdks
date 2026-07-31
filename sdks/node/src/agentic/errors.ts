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
  /**
   * The caller's plan does not include what they asked for — a *scope*
   * shortfall, not a spend one (ADR-0023 §D1, added 2026-07-31).
   *
   * Distinct from `budget_exceeded` because the remedy is different and a
   * caller cannot act on the wrong one: `budget_exceeded` means "you have
   * spent what you allocated", and sends a user to look at usage;
   * `upgrade_required` means "you never bought this tier", and sends them
   * to their plan. Both arrive as HTTP 402, so status alone cannot separate
   * them — the server's `code` field does. See `upgrade` on `AgenticError`
   * for the affordance describing what to buy.
   */
  | "upgrade_required"
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

/**
 * What the server says would make the rejected call succeed, carried on a
 * `upgrade_required` error (ADR-0023 §D1).
 *
 * Every field is optional on purpose: this is a server-supplied affordance,
 * and a caller that hard-requires any one of them would break the moment the
 * gateway omits it. Render what is present; never infer what is not.
 */
export interface UpgradeAffordance {
  /** Tier that would satisfy the request, e.g. `"mid"`. */
  readonly requiredTier?: string;
  /** Tier the credential currently holds, e.g. `"low"`. */
  readonly heldTier?: string;
  /** Scope that was missing, e.g. `"completions:mid"`. */
  readonly requiredScope?: string;
  /** Where a human goes to change their plan. */
  readonly upgradeUrl?: string;
  /**
   * Present only when the server can offer an in-scope retry (auto mode with
   * `fail_fast`); an explicitly over-scope model alias omits it. Absence
   * means "there is no way to retry this as asked" — it is not an error.
   *
   * This SDK never acts on it automatically. `upgrade_required` is
   * non-retryable, and silently downgrading someone's request to a cheaper
   * tier is a decision only the caller can make.
   */
  readonly retryWith?: UpgradeRetryHint;
}

/**
 * Server hint describing a retry that would be in scope.
 *
 * Deliberately narrow. An earlier draft preserved every unrecognised
 * `retry_with` key verbatim for forward compatibility, which put unbounded,
 * server-controlled JSON onto an error object that callers routinely log.
 * ADR-0028 §D10 forbids capturing credentials, cookies and pre-signed URLs at
 * all, and nothing downstream redacts this field. A key no version of this
 * SDK understands is also a key no caller can act on, so the trade bought
 * nothing and cost a leak path. Add fields here as the server ships them.
 */
export interface UpgradeRetryHint {
  /** e.g. `"best_effort"`. */
  readonly fallbackPolicy?: string;
}

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
 * `message`, `details`, `cause`, and `upgrade` MUST be redacted by the caller
 * before this type is constructed for exposure — this base class does not perform
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
  /**
   * Server-supplied upgrade affordance. Set only for `upgrade_required`.
   *
   * Kept on the base shape rather than a subclass so the three SDKs expose
   * one field name apiece — Rust has no subclassing, and a caller reading
   * `error.upgrade` in Node, Python and Rust alike is the point.
   *
   * SUBJECT TO THE SAME REDACTION OBLIGATION as `message`/`details`/`cause`:
   * every value here is server-supplied. `upgradeUrl` in particular may carry
   * a tenant-scoped or pre-signed link, which ADR-0028 §D10 classes as never
   * capturable. Redact before logging or forwarding.
   */
  readonly upgrade?: UpgradeAffordance;
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
    this.upgrade = fields?.upgrade;
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
 * Fail-closed error raised when a scope preflight (ADR-0022 §D5) finds a
 * credential with KNOWN granted scopes that do not include the scope an
 * operation requires. "Before a billable or mutating call, a provider with
 * known granted scopes is checked locally. Missing scope returns
 * `PermissionDeniedError` before I/O." Never raised when `grantedScopes` is
 * absent/unknown — "the SDK never guesses that a broader-looking string
 * implies permission," and equally it never guesses the opposite: an
 * unknown scope set is sent once and left to the server (§D5).
 */
export class PermissionDeniedError extends AgenticError {
  readonly requiredScope: string;
  readonly grantedScopes: string[];

  constructor(
    product: string,
    operation: string,
    requiredScope: string,
    grantedScopes: string[],
    message?: string,
  ) {
    super(
      "permission_denied",
      message ??
        `operation "${operation}" on ${product} requires scope "${requiredScope}", but the ` +
          `credential's known granted scopes (${grantedScopes.length > 0 ? grantedScopes.join(", ") : "none"}) ` +
          "do not include it (ADR-0022 §D5 scope preflight)",
      { product, operation, retryable: false },
    );
    this.name = "PermissionDeniedError";
    this.requiredScope = requiredScope;
    this.grantedScopes = grantedScopes;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * ADR-0022 §D7 consent grant kinds. A locally recorded `ConsentGrant` names
 * exactly one of these — never a generic boolean — so consent for one kind
 * never implies another ("Consent for sponsored inference does not imply
 * cloud fallback or training contribution").
 */
export type ConsentGrantKind =
  | "sponsored_inference"
  | "power_saver_routing"
  | "cloud_fallback"
  | "source_upload"
  | "artifact_retention"
  | "training_data_contribution"
  | "external_webhook_delivery";

/**
 * A narrow, locally-recorded (or signed) consent grant (ADR-0022 §D7). The
 * grant must match product, origin, subject, and action before it satisfies
 * a gated call — the SDK never infers consent from credential presence, a
 * prior operation on another origin, environment variables, or a retry
 * policy.
 *
 * Type-only scaffolding: this module does not verify signatures or attest
 * server-persisted grants (§D7's "consequential kind" re-check requirement)
 * — it only defines the shape and the presence/expiry check that product
 * clients (starting with `MetaProxyClient`, ADR-0025a §D9) apply before a
 * gated call.
 */
export interface ConsentGrant {
  kind: ConsentGrantKind;
  product: string;
  origin: string;
  subject: string;
  scope: string;
  issuedAt: string;
  /** Absent means the grant does not expire. */
  expiresAt?: string;
  /**
   * Present when the grant is signed or attested by the issuing service.
   * §D7: consequential kinds (`sponsored_inference`, `training_data_contribution`,
   * `source_upload`, `artifact_retention`, `external_webhook_delivery`)
   * require this; the low-stakes kinds (`power_saver_routing`, `cloud_fallback`)
   * may be an unsigned local record without one.
   */
  evidenceId?: string;
}

/**
 * Fail-closed error raised when a gated operation requires an ADR-0022 §D7
 * consent grant that is absent, expired, or does not match the call
 * (product/origin/subject/action). Credential presence is never a
 * substitute for consent (§D7/ADR-0025a §D9): "Headless clients return
 * `ConsentRequiredError` rather than prompt." Carries a machine-readable
 * `requiredKind` per §D7 ("Headless SDKs return `ConsentRequiredError` with
 * a machine-readable required kind").
 */
export class ConsentRequiredError extends AgenticError {
  readonly requiredKind: ConsentGrantKind;

  constructor(
    product: string,
    operation: string,
    requiredKind: ConsentGrantKind,
    message?: string,
  ) {
    super(
      "consent_required",
      message ??
        `operation "${operation}" on ${product} requires an unexpired ADR-0022 consent ` +
          `grant of kind "${requiredKind}" — credential presence alone is not consent`,
      { product, operation, retryable: false },
    );
    this.name = "ConsentRequiredError";
    this.requiredKind = requiredKind;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Fail-closed error raised when a product client that excludes browser use
 * (ADR-0029 §D2 — Meta Proxy is excluded because "its loopback token, local
 * consent, process ownership, and CORS behavior are not a browser contract")
 * is constructed in a browser-like runtime. §D2: "construction MUST throw
 * `UnsupportedRuntimeError` before reading a credential, opening a socket,
 * importing an installer, or executing a process."
 */
export class UnsupportedRuntimeError extends AgenticError {
  readonly runtime: string;

  constructor(product: string, operation: string, runtime: string, message?: string) {
    super(
      "configuration",
      message ??
        `${product} does not support the "${runtime}" runtime (ADR-0029 §D2) — ` +
          `construction refused before reading a credential or opening a socket`,
      { product, operation, retryable: false },
    );
    this.name = "UnsupportedRuntimeError";
    this.runtime = runtime;
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
