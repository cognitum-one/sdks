//! Meta LLM serving client (ADR-0024a). Product module + feature per
//! ADR-0019 §D2: `cognitum_one::meta_llm`, Cargo feature `meta-llm`.
//!
//! Issue #58 / M2 start: `MetaLlmClient` construction, wire types, and real
//! `health()` / `whoami()` / `models()` implementations. Streaming (§D5),
//! the five protocol operations' HTTP logic, and ADR-0024b routing
//! controls are deliberately out of scope — see follow-up issues.
//!
//! Per ADR-0019 §D4, this module depends on `crate::agentic` and MUST NOT
//! be imported by any other product module (`meta_proxy`, `metaharness`,
//! `harnessaas`).

pub mod client;
pub mod config;
pub mod discovery;
pub mod envelope;
mod http;
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
