//! # cognitum-rs
//!
//! Official Cognitum SDK for Rust.
//!
//! Provides async access to the Cognitum API including the product catalog,
//! order management, lead capture, contact forms, OTA device management,
//! MCP tool invocation, and the brain knowledge base.
//!
//! ## Quick start
//!
//! ```rust,no_run
//! use cognitum_one::{Client, Error};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Error> {
//!     let client = Client::new("my-api-key");
//!
//!     let catalog = client.catalog().browse().await?;
//!     println!("Products: {}", catalog.products.len());
//!
//!     Ok(())
//! }
//! ```

// `agentic::errors::AgenticError` is deliberately a flat, type-only struct
// shared across every product client (ADR-0023 §D1) rather than a boxed or
// per-product error type — see that struct's own doc comment, which
// explicitly rejects boxing `cause` so the three language SDKs (Node,
// Python, Rust) can expose one consistent field name apiece. That intentional
// shape puts it over clippy's default 128-byte Err threshold at every
// `Result<T, AgenticError>` call site (10, as of 2026-08-24). Boxing the
// return type instead would be a breaking public-API change to a released
// SDK crate for a lint, not a bug -- not something to do in passing. Allowed
// crate-wide rather than per-site so a future new endpoint doesn't silently
// need the same allow copied again.
#![allow(clippy::result_large_err)]

pub mod agentic;
pub mod brain;
pub mod catalog;
pub mod client;
pub mod contact;
pub mod devices;
pub mod error;
pub mod leads;
pub mod mcp;
pub mod orders;
pub(crate) mod retry_hint;
pub mod types;

pub use client::{Client, ClientConfig};
pub use error::Error;

#[cfg(feature = "seed")]
pub mod seed;

#[cfg(feature = "meta-llm")]
pub mod meta_llm;

/// Protocol-agnostic Server-Sent Events parsing (ADR-0024a §D5). Gated
/// behind `meta-llm` since it is the module's only current consumer, but
/// carries zero dependency on `meta_llm` itself and is reused as-is when
/// Anthropic Messages / Responses streaming lands.
#[cfg(feature = "meta-llm")]
pub mod sse;

/// Meta Proxy client (ADR-0019 §D2, ADR-0025a). Issue #61 / M3 start —
/// `MetaProxyClient` construction and `status()`/`capabilities()`. See
/// `meta_proxy`'s module doc comment for the full deferred-scope list.
#[cfg(feature = "meta-proxy")]
pub mod meta_proxy;

/// MetaHarness client (ADR-0019 §D2, ADR-0026a). Issue #64 / M4 start —
/// `MetaHarnessClient` construction (zero I/O) and the §D2 public method
/// surface as fail-closed stubs. See `metaharness`'s module doc comment for
/// the full ADR-0026a §D7 blocker list this pass is gated on.
#[cfg(feature = "metaharness")]
pub mod metaharness;

/// HarnessaaS client (ADR-0019 §D2, ADR-0027a). Issue #67/#68 / M5 start —
/// `HarnessaaSClient` construction and real `health()`/`solve()`/
/// `lineage()` against the REAL, deployed, synchronous upstream surface.
/// See `harnessaas`'s module doc comment for the full scope note (the
/// ADR-0027a proposed async job/poll/SSE/approval contract is NOT
/// implemented here).
#[cfg(feature = "harnessaas")]
pub mod harnessaas;
