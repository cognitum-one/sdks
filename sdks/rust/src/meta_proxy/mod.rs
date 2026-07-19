//! Meta Proxy client (ADR-0025a). Product module + feature per ADR-0019
//! §D2: `cognitum_one::meta_proxy`, Cargo feature `meta-proxy`.
//!
//! Issue #61 / M3: `MetaProxyClient` construction (§D3), `status()` /
//! `capabilities()` (§D4), routing intent + `chat_completions()` forwarding
//! (§D5-§D7), streaming (§D8), and the tractable consent-gating slice of §D9
//! (`consent` — the `cognitum_cloud` plane is gated on a `CloudFallback`
//! grant; sponsor budget/usage remain BLOCKED on ADR-0025b). §D10's
//! browser-runtime rejection is N/A for this crate: Rust has no wasm32/
//! browser target for `meta-proxy` (see `Cargo.toml`'s `[features]` —
//! no such target exists), so there is nothing to guard. Loopback-origin
//! construction validation (§D10's other half) is implemented in `config`.
//!
//! Per ADR-0019 §D4, this module's CLIENT is product-private and MUST NOT be
//! imported by any other product module (`meta_llm`, `metaharness`,
//! `harnessaas`). It does, however, REUSE `meta_llm`'s OpenAI wire types for
//! the §D7 forwarding contract — permitted wire-primitive sharing per
//! ADR-0019 §D7 ("Meta LLM and Meta Proxy share OpenAI and Anthropic wire
//! primitives where their capability sets agree. They do not share a client
//! class."). Hence the `meta-proxy` Cargo feature depends on `meta-llm`.
//!
//! Still out of scope: sponsor budget/usage (`WorkloadCapability` minting
//! included — both blocked on ADR-0025b's lifecycle/state fixes), and
//! Messages.

pub mod auth;
pub mod client;
pub mod config;
pub mod consent;
pub mod envelope;
pub mod forwarding;
mod http;
pub mod routing;
pub mod status;
pub mod stream;
pub mod time_budget;

/// Product identity used in requests, credential scoping, and error fields.
pub(crate) const PRODUCT: &str = "meta-proxy";
/// Fallback `product_version` for the intersection-safe default capability
/// set returned when the Proxy's `/status` omits one.
pub(crate) const DEFAULT_CAPABILITY_VERSION: &str = "0.0.0";

pub use auth::{
    LocalBearerTokenCredentialProvider, LocalBearerTokenCredentialProviderOptions, ProxyCredential,
    WorkloadCapabilityClaims, DEFAULT_META_PROXY_TOKEN_ENV_VAR,
};
pub use client::{CapabilitiesResult, MetaProxyClient};
pub use config::{
    MetaProxyClientConfig, MetaProxyTelemetryEvent, MetaProxyTelemetryHooks,
    DEFAULT_META_PROXY_ORIGIN,
};
pub use consent::{
    assert_consent_for_routing_intent, has_valid_consent_grant, intent_touches_plane,
    is_consent_grant_valid, CLOUD_ROUTING_CONSENT_KIND,
};
pub use envelope::{MetaProxyResponseMeta, MetaProxyResult, MetaProxyUpstreamReceipt};
pub use forwarding::MetaProxyChatCallOptions;
pub use routing::RoutingIntent;
pub use status::{MetaProxyRoutingReceipt, MetaProxyStatus, RoutingPlane, WorkloadPolicy};
pub use stream::{
    chat_completions_stream, MetaProxyChatCompletionsStream, MetaProxyStreamEnvelope,
    MetaProxyStreamMeta,
};
pub use time_budget::{
    resolve_proxy_time_budget, ProxyTimeBudget, ResolvedProxyTimeBudget,
    DEFAULT_PROXY_CONNECT_TIMEOUT_MS,
};
