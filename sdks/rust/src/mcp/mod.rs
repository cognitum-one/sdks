//! Model Context Protocol (MCP) surface.
//!
//! Two worlds live here:
//!
//! 1. **Cloud `McpResource`** (existing) — a thin proxy onto the Cognitum
//!    cloud's `/apiMcpTools`, `/mcpSse`, and `/docsSearch` endpoints.
//!    Hangs off [`crate::Client::mcp()`] and is unchanged from 0.1.x.
//!
//! 2. **Transport-parameterised `McpClient`** (OQ-4, 2026-04-23) — a
//!    protocol-level client that speaks JSON-RPC 2.0 over any
//!    [`Transport`], with concrete [`HttpTransport`] and
//!    [`StdioTransport`] implementations. Closes the Rust portion of
//!    OQ-4 (MCP stdio parity with Node's `createStdioTransport`).
//!
//! Both worlds coexist: no caller of `McpResource` is affected.

mod client;
mod http;
mod resource;
mod stdio;
mod transport;

pub use client::McpClient;
pub use http::HttpTransport;
pub use resource::{InitializeResponse, McpResource};
pub use stdio::{StdioTransport, StdioTransportBuilder};
pub use transport::{JsonRpcError, JsonRpcMessage, McpError, Transport};
