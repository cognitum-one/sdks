//! MCP client transport abstraction.
//!
//! The [`Transport`] trait lets [`McpClient`](crate::mcp::McpClient) talk to
//! an MCP server over any framing — HTTP (cloud, existing behaviour), stdio
//! (local subprocess), or a custom transport written by a caller.
//!
//! Closes OQ-4 (Rust portion): Node already ships both flavours; Python +
//! Rust shipped HTTP-only through 0.2.x. This trait is the minimum surface
//! the Rust SDK needs to have parity with Node's
//! `createStdioTransport(cmd, args)`.

use std::fmt;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Transport-layer error surface.
///
/// Intentionally **not** `crate::Error`: the transport layer runs below
/// cloud/seed error semantics, and wrapping `std::io::Error` or
/// `serde_json::Error` into `Error::Validation` would hide the real cause.
/// Callers that care translate via `From`.
#[derive(Debug, thiserror::Error)]
pub enum McpError {
    /// Underlying I/O failure (broken pipe, EOF, subprocess exit, etc.).
    #[error("mcp transport io: {0}")]
    Io(#[from] std::io::Error),
    /// Payload framing / JSON decode failure.
    #[error("mcp transport json: {0}")]
    Json(#[from] serde_json::Error),
    /// Transport was closed before the operation could complete.
    #[error("mcp transport closed")]
    Closed,
    /// Server returned a JSON-RPC error object.
    #[error("mcp rpc error {code}: {message}")]
    Rpc {
        /// JSON-RPC error code.
        code: i64,
        /// Human-readable error message.
        message: String,
    },
    /// Timed out waiting for a reply.
    #[error("mcp transport timeout")]
    Timeout,
    /// Any other transport-specific failure (e.g. spawn(), network).
    #[error("mcp transport: {0}")]
    Other(String),
}

impl From<McpError> for crate::Error {
    fn from(err: McpError) -> crate::Error {
        match err {
            McpError::Rpc { code, message } => crate::Error::Api {
                // clamp into u16; JSON-RPC codes are signed i32 but HTTP-land
                // callers only read u16.
                code: code.unsigned_abs().min(u16::MAX as u64) as u16,
                message,
            },
            McpError::Json(e) => crate::Error::Json(e),
            other => crate::Error::Validation(other.to_string()),
        }
    }
}

/// JSON-RPC 2.0 message envelope shared by every transport.
///
/// A single type covers requests, responses, and notifications; field
/// presence + absence is what differentiates the three (see the JSON-RPC
/// 2.0 spec, §4 and §5). Unknown fields are preserved in `extras` so
/// future protocol additions don't break the SDK (mirrors the
/// `#[serde(flatten)] extras` pattern used in `src/seed/models/mesh.rs`).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct JsonRpcMessage {
    /// Protocol version — always `"2.0"` for JSON-RPC 2.0.
    pub jsonrpc: String,
    /// Correlation id. `None` on notifications and one-off events.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    /// Method name — set on requests and notifications, absent on responses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    /// Method params. Either an object or an array per JSON-RPC 2.0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    /// Response result (success path).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// Response error (failure path).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

/// JSON-RPC 2.0 error object (see §5.1 of the spec).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    /// Error code. Negative integers are reserved by the spec.
    pub code: i64,
    /// Short error description.
    pub message: String,
    /// Optional structured error payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl fmt::Display for JsonRpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "rpc {}: {}", self.code, self.message)
    }
}

impl JsonRpcMessage {
    /// Construct a request.
    pub fn request(id: impl Into<Value>, method: impl Into<String>, params: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id: Some(id.into()),
            method: Some(method.into()),
            params: Some(params),
            ..Default::default()
        }
    }

    /// Construct a notification (fire-and-forget, no `id`).
    pub fn notification(method: impl Into<String>, params: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            method: Some(method.into()),
            params: Some(params),
            ..Default::default()
        }
    }

    /// Is this a response envelope (has `id`, no `method`)?
    pub fn is_response(&self) -> bool {
        self.id.is_some() && self.method.is_none()
    }
}

/// Bidirectional MCP transport.
///
/// Implementations frame JSON-RPC 2.0 messages in whatever way their
/// underlying channel demands (HTTP POST body, newline-delimited stdio,
/// WebSocket frames, etc.). The trait is object-safe via `async_trait` so
/// [`McpClient`](crate::mcp::McpClient) can hold a `Box<dyn Transport>`.
#[async_trait]
pub trait Transport: Send + Sync {
    /// Send one message. May block until the underlying channel accepts
    /// the payload (e.g. `stdin.write_all`).
    async fn send(&mut self, msg: JsonRpcMessage) -> Result<(), McpError>;

    /// Receive the next message. Returns
    /// [`McpError::Closed`] when the peer closed the channel.
    async fn recv(&mut self) -> Result<JsonRpcMessage, McpError>;

    /// Close the transport gracefully. Idempotent — calling it more than
    /// once must not panic.
    async fn close(&mut self) -> Result<(), McpError>;
}
