//! Meta Proxy client (ADR-0025a). Product module + feature per ADR-0019
//! §D2: `cognitum_one::meta_proxy`, Cargo feature `meta-proxy`.
//!
//! Issue #61 / M3 start: `MetaProxyClient` construction (§D3) and real
//! `status()` / `capabilities()` implementations (§D4). Data-plane
//! forwarding (§D5-§D9) and loopback/browser security beyond loopback-origin
//! construction validation (§D10) are deliberately out of scope — see
//! `client`'s module doc comment for the full deferred list.
//!
//! Per ADR-0019 §D4, this module's CLIENT is product-private and MUST NOT be
//! imported by any other product module (`meta_llm`, `metaharness`,
//! `harnessaas`). It does, however, REUSE `meta_llm`'s OpenAI wire types for
//! the §D7 forwarding contract — permitted wire-primitive sharing per
//! ADR-0019 §D7 ("Meta LLM and Meta Proxy share OpenAI and Anthropic wire
//! primitives where their capability sets agree. They do not share a client
//! class."). Hence the `meta-proxy` Cargo feature depends on `meta-llm`.
//!
//! M3 continuation (issue #61, §D5-§D7): `RoutingIntent` + the decode-time
//! required-plane check (`routing`), the local-bearer credential provider and
//! the type-only `ProxyCredential` union (`auth`), and non-streaming
//! `chat_completions()` forwarding with the §D7 header allowlist (`forwarding`
//! + `client`/`http`). Still out of scope: §D8 streaming/errors/cancellation,
//! §D9 consent/sponsor budget, `WorkloadCapability` minting, and Messages.

pub mod auth;
pub mod client;
pub mod config;
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
