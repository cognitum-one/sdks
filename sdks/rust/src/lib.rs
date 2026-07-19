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
