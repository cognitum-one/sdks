//! Meta Proxy client (ADR-0025a). Product module + feature per ADR-0019
//! §D2: `cognitum_one::meta_proxy`, Cargo feature `meta-proxy`.
//!
//! Issue #61 / M3 start: `MetaProxyClient` construction (§D3) and real
//! `status()` / `capabilities()` implementations (§D4). Data-plane
//! forwarding (§D5-§D9) and loopback/browser security beyond loopback-origin
//! construction validation (§D10) are deliberately out of scope — see
//! `client`'s module doc comment for the full deferred list.
//!
//! Per ADR-0019 §D4, this module depends on `crate::agentic` and MUST NOT
//! be imported by any other product module (`meta_llm`, `metaharness`,
//! `harnessaas`).

pub mod client;
pub mod config;
pub mod envelope;
mod http;
pub mod status;

/// Product identity used in requests, credential scoping, and error fields.
pub(crate) const PRODUCT: &str = "meta-proxy";
/// Fallback `product_version` for the intersection-safe default capability
/// set returned when the Proxy's `/status` omits one.
pub(crate) const DEFAULT_CAPABILITY_VERSION: &str = "0.0.0";

pub use client::{CapabilitiesResult, MetaProxyClient};
pub use config::{
    MetaProxyClientConfig, MetaProxyTelemetryEvent, MetaProxyTelemetryHooks,
    DEFAULT_META_PROXY_ORIGIN,
};
pub use envelope::{MetaProxyResponseMeta, MetaProxyResult, MetaProxyUpstreamReceipt};
pub use status::{MetaProxyRoutingReceipt, MetaProxyStatus, RoutingPlane, WorkloadPolicy};
