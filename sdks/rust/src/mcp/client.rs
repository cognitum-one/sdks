//! High-level MCP client backed by a [`Transport`].
//!
//! Mirrors the Node `McpClient` surface: one struct parameterised over a
//! transport, with ergonomic methods (`initialize`, `list_tools`,
//! `call_tool`) that the app author actually uses. The transport is owned
//! as a `Box<dyn Transport + Send + Sync>` so callers can swap HTTP for
//! stdio (or a custom transport) without touching the call sites.

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};

use super::transport::{JsonRpcMessage, McpError, Transport};

/// MCP client that speaks JSON-RPC 2.0 over an arbitrary [`Transport`].
pub struct McpClient {
    transport: Box<dyn Transport + Send + Sync>,
    next_id: AtomicU64,
}

impl McpClient {
    /// Construct a new client from any `Transport` implementation.
    pub fn new<T: Transport + Send + Sync + 'static>(transport: T) -> Self {
        Self {
            transport: Box::new(transport),
            next_id: AtomicU64::new(1),
        }
    }

    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Send a request and wait for the matching response. Correlation is
    /// done by `id`; any intervening notifications are returned via
    /// [`McpError::Other`] to surface protocol violations early rather
    /// than silently dropping server chatter.
    pub async fn request(&mut self, method: &str, params: Value) -> Result<Value, McpError> {
        let id = self.next_id();
        let msg = JsonRpcMessage::request(id, method, params);
        self.transport.send(msg).await?;

        let reply = self.transport.recv().await?;
        if !reply.is_response() {
            return Err(McpError::Other(format!(
                "expected response, got method={:?}",
                reply.method
            )));
        }
        if let Some(err) = reply.error {
            return Err(McpError::Rpc {
                code: err.code,
                message: err.message,
            });
        }
        Ok(reply.result.unwrap_or(Value::Null))
    }

    /// Fire a notification (no reply expected).
    pub async fn notify(&mut self, method: &str, params: Value) -> Result<(), McpError> {
        let msg = JsonRpcMessage::notification(method, params);
        self.transport.send(msg).await
    }

    /// MCP `initialize` handshake.
    pub async fn initialize(&mut self) -> Result<Value, McpError> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "cognitum-rs",
                    "version": env!("CARGO_PKG_VERSION"),
                },
            }),
        )
        .await
    }

    /// MCP `tools/list`.
    pub async fn list_tools(&mut self) -> Result<Value, McpError> {
        self.request("tools/list", json!({})).await
    }

    /// MCP `tools/call`.
    pub async fn call_tool(&mut self, name: &str, args: Value) -> Result<Value, McpError> {
        self.request(
            "tools/call",
            json!({
                "name": name,
                "arguments": args,
            }),
        )
        .await
    }

    /// Close the underlying transport.
    pub async fn close(&mut self) -> Result<(), McpError> {
        self.transport.close().await
    }
}
