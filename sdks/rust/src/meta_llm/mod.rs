//! Meta LLM serving client (ADR-0024a). Product module + feature per
//! ADR-0019 §D2: `cognitum_one::meta_llm`, Cargo feature `meta-llm`.
//!
//! Issue #58 / M2: `MetaLlmClient` construction, wire types, real
//! `health()` / `whoami()` / `models()` implementations, real HTTP call
//! logic for every direct nonstream/stream protocol operation (ADR-0024a
//! §D6 error mapping, §D7 idempotency and retry), and — ADR-0024b D11
//! migration step 1 (issue #59) — routing controls, receipt decoding, and
//! read-only usage. Still deliberately out of scope: batches, pods,
//! bench, webhooks, guidance, collaboration, evolution, MicroLoRA,
//! flywheel, genome, brain, vectors, and conditional hosts (§D5-§D8) —
//! separate future issues.
//!
//! Per ADR-0019 §D4, this module's CLIENT is product-private and MUST NOT be
//! imported for its behavior by any other product module (`metaharness`,
//! `harnessaas`). Its OpenAI/Anthropic WIRE TYPES (`types::openai`,
//! `types::anthropic`) are, however, shared with `meta_proxy` for the
//! ADR-0025a §D7 forwarding contract — permitted wire-primitive sharing per
//! ADR-0019 §D7 ("Meta LLM and Meta Proxy share OpenAI and Anthropic wire
//! primitives where their capability sets agree. They do not share a client
//! class.").

pub mod client;
pub mod config;
pub mod discovery;
pub mod envelope;
mod http;
mod idempotency;
mod nonstream;
pub mod stream;
pub mod types;

/// Product identity used in requests, credential scoping, and error fields.
pub(crate) const PRODUCT: &str = "meta-llm";
/// Fallback `product_version` for the intersection-safe default capability
/// set returned when no `capabilities_snapshot` is configured.
pub(crate) const DEFAULT_CAPABILITY_VERSION: &str = "0.0.0";

pub use client::MetaLlmClient;
pub use config::{MetaLlmClientConfig, MetaLlmSafetyControl, MetaLlmTelemetryEvent, MetaLlmTelemetryHooks};
pub use discovery::{MetaLlmHealth, MetaLlmModelInfo, MetaLlmModelList, MetaLlmWhoAmI};
pub use envelope::{MetaLlmReceipt, MetaLlmResponseMeta, MetaLlmResult};
pub use stream::{
    decode_openai_sse_event, ChatCompletionsStream, ChatCompletionsStreamAccumulator,
    ChatCompletionsStreamSnapshot, DecodedOpenAiSseEvent, MetaLlmStreamEnvelope, OpenAiStreamErrorPayload,
    OpenAiStreamEvent, ToolCallAccumulation,
};
// ADR-0024b D11 migration step 1 (issue #59): routing controls, money,
// receipt, and usage/budget types.
pub use types::{
    assert_sendable_routing_controls, assert_valid_usage_query, parse_meta_llm_receipt,
    parse_money, parse_usage_summary, BudgetView, CacheMode, CacheStats, EscalationStrategy,
    FallbackPolicy, InvalidUsageQueryError, MetaLlmRoutingControls, ModelSelector, ModelTier,
    Money, ReceiptCacheResult, ReceiptModelTier, SafetyMode, SafetySummary, SubTenantAttribution,
    UnsendableRoutingControlsError, UsageBreakdownEntry, UsageGroupBy, UsagePeriodEntry,
    UsageQuery, UsageSummary, UsageTotals,
};
