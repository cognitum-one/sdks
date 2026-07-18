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
//! - `docs/adr/0028-agentic-telemetry-usage-receipts-lineage-and-redaction.md` (D7-D9)
//! - `docs/adr/0005-cross-cutting-retry-backoff.md` (equal-jitter formula)

pub mod capability;
pub mod context;
pub mod credentials;
pub mod errors;
pub mod operations;
pub mod receipts;
pub mod static_api_key_provider;
pub mod sentinel;

pub use capability::{CapabilitySet, CapabilitySource};
pub use context::{BudgetPolicy, OnUnknownEstimate, RequestContext, TenantContext};
pub use credentials::{
    Credential, CredentialAuthority, CredentialProvider, CredentialRequest, RedactedSecret,
    SecretClassification, SecretRedactor,
};
pub use sentinel::{D12Category, SentinelSecretRedactor};
pub use errors::{
    equal_jitter_delay_ms, AgenticError, AgenticErrorKind, CancellationReason, CancellationToken,
    IdempotencyBindingV1, NoopCancellationToken, OperationRetryClass, RetryPolicy, TimeBudget,
    UnsupportedCapabilityError,
};
pub use operations::{
    EventStreamOptions, OperationEvent, OperationEventStream, OperationHandle, OperationSnapshot,
    OperationState, Page, PageRequest, WaitOptions,
};
pub use receipts::{
    CostFinality, CostObservation, ExecutionReceipt, LineageReference, LineageSubject,
    ReceiptSubject, VerificationLevel, VerificationResult,
};
pub use static_api_key_provider::{
    StaticApiKeyCredentialProvider, StaticApiKeyCredentialProviderOptions, DEFAULT_API_KEY_ENV_VAR,
};
