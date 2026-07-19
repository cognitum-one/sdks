/**
 * Shared agentic-platform contract shapes (ADR-0019 §D5).
 *
 * This module is the SMALL shared surface used by the four bounded-context
 * clients (Meta LLM, Meta Proxy, MetaHarness, HarnessaaS). Per ADR-0019 D4,
 * those product modules depend on this module; this module MUST NOT import
 * any product module.
 *
 * Most of this module is **type-only scaffolding** (issue #52 / M1): there is
 * still no network I/O, retry loop, or product routing/consent/scaffold
 * logic — those remain product-specific per D5. `StaticApiKeyCredentialProvider`
 * (issue #53) is the first concrete implementation landing on top of this
 * contract; secret-redaction (#54) and receipt/lineage verification (#56)
 * remain follow-up issues.
 *
 * Sources:
 * - docs/adr/0019-agentic-platform-bounded-contexts.md (D2, D3, D5, D6)
 * - docs/adr/0022-agentic-auth-tenant-budget-secret-and-consent-isolation.md (D1, D6, D10)
 * - docs/adr/0023-agentic-errors-retries-idempotency-cancellation-and-time-budgets.md (D1, D3-D9)
 * - docs/adr/0028-agentic-telemetry-usage-receipts-lineage-and-redaction.md (D1, D3, D7-D9)
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
  ConsentGrantKind,
  ConsentGrant,
} from "./errors.js";
export {
  AgenticError,
  UnsupportedCapabilityError,
  ConsentRequiredError,
  UnsupportedRuntimeError,
  PermissionDeniedError,
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

export type { StaticApiKeyCredentialProviderOptions } from "./static-api-key-provider.js";
export {
  StaticApiKeyCredentialProvider,
  DEFAULT_API_KEY_ENV_VAR,
} from "./static-api-key-provider.js";

export type {
  OAuthTokenCredentialProviderOptions,
  OAuthTokenSource,
  OAuthTokenSourceResult,
} from "./oauth-token-provider.js";
export { OAuthTokenCredentialProvider } from "./oauth-token-provider.js";

export { assertScopeGranted } from "./scope-preflight.js";

export type { D12Category } from "./sentinel.js";
export { SentinelSecretRedactor } from "./sentinel.js";

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

export type {
  TelemetrySeverity,
  TraceContext,
  TelemetryEvent,
  TelemetrySink,
} from "./telemetry.js";
export {
  NoopTelemetrySink,
  ATTR_PRODUCT,
  ATTR_OPERATION,
  ATTR_PROTOCOL,
  ATTR_CONTRACT_VERSION,
  ATTR_REQUEST_ID,
  ATTR_TENANT_HASH,
  ATTR_MODEL_ALIAS,
  ATTR_TIER,
  ATTR_ROUTING_PLANE,
  ATTR_ROUTING_REASON,
  ATTR_CACHE_RESULT,
  ATTR_OPERATION_STATE,
  ATTR_ERROR_KIND,
  ATTR_RETRY_COUNT,
} from "./telemetry.js";

export type {
  BuildExecutionReceiptInput,
  VerifyReceiptOptions,
  VerifyLineageChainOptions,
  LineageChainVerification,
} from "./receipt-verification.js";
export {
  buildExecutionReceipt,
  verifyExecutionReceipt,
  verifyLineageChain,
  shapeCheckExecutionReceipt,
  shapeCheckLineageReference,
  canonicalJson,
  sha256Hex,
} from "./receipt-verification.js";
