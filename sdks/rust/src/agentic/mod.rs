//! Shared agentic-platform contract shapes (ADR-0019 §D5).
//!
//! This module is the SMALL shared surface used by the four bounded-context
//! clients (Meta LLM, Meta Proxy, MetaHarness, HarnessaaS). Per ADR-0019
//! §D4, those product modules (`meta_llm`, `meta_proxy`, `metaharness`,
//! `harnessaas` — future feature-gated modules) depend on
//! `cognitum_one::agentic`; this module MUST NOT import any product module.
//!
//! Everything here is **type-only scaffolding** (issue #52 / M1). There is
//! no network I/O, no credential acquisition, no retry loop, and no product
//! routing/consent/scaffold logic — those remain product-specific per §D5
//! and land in follow-up issues (#53 credential-provider implementation,
//! #54 secret-redaction implementation, #56 receipt/lineage verification).
//!
//! Sources:
//! - `docs/adr/0019-agentic-platform-bounded-contexts.md` (D2, D3, D5, D6)
//! - `docs/adr/0022-agentic-auth-tenant-budget-secret-and-consent-isolation.md` (D1, D6, D10)
//! - `docs/adr/0023-agentic-errors-retries-idempotency-cancellation-and-time-budgets.md` (D1, D3-D9)
//! - `docs/adr/0028-agentic-telemetry-usage-receipts-lineage-and-redaction.md` (D1, D3, D7-D9)
//! - `docs/adr/0005-cross-cutting-retry-backoff.md` (equal-jitter formula)

pub mod capability;
pub mod context;
pub mod credentials;
pub mod diagnostics;
pub mod errors;
pub mod oauth_token_provider;
pub mod operations;
pub mod receipt_verification;
pub mod receipts;
pub mod scope_preflight;
pub mod static_api_key_provider;
pub mod sentinel;
pub mod telemetry;
pub mod telemetry_metrics;
pub mod trace_context;

pub use capability::{CapabilitySet, CapabilitySource};
pub use context::{BudgetPolicy, OnUnknownEstimate, RequestContext, TenantContext};
pub use credentials::{
    Credential, CredentialAuthority, CredentialProvider, CredentialRequest, RedactedSecret,
    SecretClassification, SecretRedactor,
};
pub use sentinel::{D12Category, SentinelSecretRedactor};
pub use diagnostics::{
    is_never_capturable, preview_diagnostic_manifest, DiagnosticBundle, DiagnosticManifest,
    DiagnosticPolicy, DiagnosticSink, RedactionReport, RetentionPolicy,
    D10_RELEVANT_CATEGORIES, NEVER_CAPTURABLE_CATEGORIES,
};
pub use errors::{
    equal_jitter_delay_ms, AgenticError, AgenticErrorKind, CancellationReason, CancellationToken,
    ConsentGrant, ConsentGrantKind, ConsentRequiredError, IdempotencyBindingV1,
    NoopCancellationToken, OperationRetryClass, PermissionDeniedError, RetryPolicy, TimeBudget,
    UnsupportedCapabilityError,
};
pub use oauth_token_provider::{
    OAuthTokenCredentialProvider, OAuthTokenCredentialProviderOptions, OAuthTokenSource,
    OAuthTokenSourceResult,
};
pub use scope_preflight::assert_scope_granted;
pub use operations::{
    EventStreamOptions, OperationEvent, OperationEventStream, OperationHandle, OperationSnapshot,
    OperationState, Page, PageRequest, WaitOptions,
};
pub use receipt_verification::{
    build_execution_receipt, canonical_json, shape_check_execution_receipt,
    shape_check_lineage_reference, sha256_hex, verify_execution_receipt, verify_lineage_chain,
    BuildExecutionReceiptInput, KeyResolver, LineageChainVerification, VerifyLineageChainOptions,
    VerifyReceiptOptions,
};
pub use receipts::{
    CostFinality, CostObservation, ExecutionReceipt, LineageReference, LineageSubject,
    ReceiptSubject, VerificationLevel, VerificationResult,
};
pub use static_api_key_provider::{
    StaticApiKeyCredentialProvider, StaticApiKeyCredentialProviderOptions, DEFAULT_API_KEY_ENV_VAR,
};
pub use telemetry::{
    NoopTelemetrySink, TelemetryEvent, TelemetrySeverity, TelemetrySink, TraceContext,
    ATTR_CACHE_RESULT, ATTR_CONTRACT_VERSION, ATTR_ERROR_KIND, ATTR_MODEL_ALIAS,
    ATTR_OPERATION, ATTR_OPERATION_STATE, ATTR_PRODUCT, ATTR_PROTOCOL, ATTR_REQUEST_ID,
    ATTR_RETRY_COUNT, ATTR_ROUTING_PLANE, ATTR_ROUTING_REASON, ATTR_TENANT_HASH, ATTR_TIER,
    EVENT_ARTIFACT_VERIFIED, EVENT_BUDGET_COMMITTED, EVENT_BUDGET_RELEASED,
    EVENT_BUDGET_RESERVED, EVENT_CAPABILITIES_LOADED, EVENT_CONSENT_REQUIRED,
    EVENT_EVIDENCE_VERIFIED, EVENT_OPERATION_STATE_CHANGED, EVENT_OPERATION_WAIT_ENDED,
    EVENT_PROCESS_ENDED, EVENT_PROCESS_STARTED, EVENT_REQUEST_END, EVENT_REQUEST_RETRY_SCHEDULED,
    EVENT_REQUEST_START, EVENT_STREAM_END, EVENT_STREAM_FIRST_EVENT, EVENT_TELEMETRY_DROPPED,
};
pub use telemetry_metrics::{MeasurementKind, MetricInstrumentKind};
pub use trace_context::{
    format_trace_state, generate_trace_parent, harnessaas_span_name, join_or_generate_trace_context,
    meta_llm_span_name, meta_proxy_span_name, metaharness_span_name, parse_trace_parent,
    parse_trace_state, TraceStateMember, DEFAULT_TRACE_FLAGS, MAX_TRACESTATE_MEMBERS,
    TRACE_VERSION,
};
