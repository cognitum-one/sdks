/**
 * Shared per-call request context (ADR-0019 §D5) and budget policy
 * (ADR-0022 §D6). Type-only scaffolding — issue #52 / M1.
 */

import type { CredentialProvider } from "./credentials.js";
import type { CancellationToken, TimeBudget } from "./errors.js";

/** How the SDK should treat an operation whose cost estimate is unknown. */
export type OnUnknownEstimate = "reject" | "allow_server_enforcement";

/** Client-side spend guard, not an accounting authority (ADR-0022 §D6). */
export interface BudgetPolicy {
  maxEstimatedCost?: number;
  maxCommittedCost?: number;
  currency?: string;
  maxTier?: string;
  allowEscalation?: boolean;
  reservationTtlMs?: number;
  onUnknownEstimate: OnUnknownEstimate;
}

/** Resolved tenant binding for a request. Never a generic caller override (ADR-0022 §D4). */
export interface TenantContext {
  tenantId?: string;
  delegatedSubtenantId?: string;
}

/**
 * Per-call request context shared across every agentic product client
 * (ADR-0019 §D5): identity, correlation, idempotency, budget, timeouts, and
 * cancellation. Product-specific fields (routing plane, safety mode, solve
 * input, etc.) do NOT belong here.
 */
export interface RequestContext {
  requestId: string;
  correlationId?: string;
  idempotencyKey?: string;
  tenant?: TenantContext;
  normalizedOrigin: string;
  credentialProvider?: CredentialProvider;
  budgetPolicy?: BudgetPolicy;
  timeBudget?: TimeBudget;
  cancellation?: CancellationToken;
  /** Optional trace-context carrier (e.g. W3C `traceparent`/`tracestate`). */
  tracingCarrier?: Record<string, string>;
}
