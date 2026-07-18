//! Meta LLM serving client (ADR-0024a). Product module + feature per
//! ADR-0019 §D2: `cognitum_one::meta_llm`, Cargo feature `meta-llm`.
//!
//! Issue #58 / M2: `MetaLlmClient` construction, wire types, real
//! `health()` / `whoami()` / `models()` implementations, and — this pass —
//! real HTTP call logic for `chat_completions` and `messages_create`
//! (ADR-0024a §D6 error mapping, §D7 idempotency and retry). Streaming
//! (§D5), the other three protocol operations (`completions`,
//! `responses`, `embeddings`), and ADR-0024b routing controls are
//! deliberately out of scope — see follow-up issues.
//!
//! Per ADR-0019 §D4, this module depends on `crate::agentic` and MUST NOT
//! be imported by any other product module (`meta_proxy`, `metaharness`,
//! `harnessaas`).

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
pub use config::{
    MetaLlmClientConfig, MetaLlmRoutingControls, MetaLlmSafetyControl, MetaLlmTelemetryEvent,
    MetaLlmTelemetryHooks,
};
pub use discovery::{MetaLlmHealth, MetaLlmModelInfo, MetaLlmModelList, MetaLlmWhoAmI};
pub use envelope::{MetaLlmReceipt, MetaLlmResponseMeta, MetaLlmResult};
pub use stream::{
    decode_openai_sse_event, ChatCompletionsStream, ChatCompletionsStreamAccumulator,
    ChatCompletionsStreamSnapshot, DecodedOpenAiSseEvent, MetaLlmStreamEnvelope, OpenAiStreamErrorPayload,
    OpenAiStreamEvent, ToolCallAccumulation,
};
