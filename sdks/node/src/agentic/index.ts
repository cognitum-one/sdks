/**
 * Shared agentic-platform contract shapes (ADR-0019 §D5).
 *
 * This module is the SMALL shared surface used by the four bounded-context
 * clients (Meta LLM, Meta Proxy, MetaHarness, HarnessaaS). Per ADR-0019 D4,
 * those product modules depend on this module; this module MUST NOT import
 * any product module.
 *
 * Everything here is **type-only scaffolding** (issue #52 / M1). There is no
 * network I/O, no credential acquisition, no retry loop, and no product
 * routing/consent/scaffold logic — those remain product-specific per D5 and
 * land in follow-up issues (#53 credential-provider implementation, #54
 * secret-redaction implementation, #56 receipt/lineage verification).
 *
 * Sources:
 * - docs/adr/0019-agentic-platform-bounded-contexts.md (D2, D3, D5, D6)
 * - docs/adr/0022-agentic-auth-tenant-budget-secret-and-consent-isolation.md (D1, D6, D10)
 * - docs/adr/0023-agentic-errors-retries-idempotency-cancellation-and-time-budgets.md (D1, D3-D9)
 * - docs/adr/0028-agentic-telemetry-usage-receipts-lineage-and-redaction.md (D7-D9)
 * - docs/adr/0005-cross-cutting-retry-backoff.md (equal-jitter formula)
 */

export type { CapabilitySource, CapabilitySet } from "./capability.js";

export type {
  AgenticErrorKind,
  OperationRetryClass,
  RetryPolicy,
  IdempotencyBindingV1,
  CancellationReason,
  CancellationToken,
  TimeBudget,
} from "./errors.js";
export {
  AgenticError,
  UnsupportedCapabilityError,
  DEFAULT_RETRY_POLICY,
  equalJitterDelayMs,
} from "./errors.js";

export type {
  CredentialRequest,
  CredentialAuthority,
  Credential,
  CredentialProvider,
  SecretClassification,
  SecretRedactor,
} from "./credentials.js";
export { RedactedSecret } from "./credentials.js";

export type {
  OnUnknownEstimate,
  BudgetPolicy,
  TenantContext,
  RequestContext,
} from "./context.js";

export type {
  OperationState,
  OperationSnapshot,
  WaitOptions,
  EventStreamOptions,
  OperationEvent,
  OperationHandle,
  PageRequest,
  Page,
} from "./operations.js";

export type {
  VerificationLevel,
  VerificationResult,
  CostFinality,
  CostObservation,
  ExecutionReceipt,
  LineageReference,
} from "./receipts.js";
