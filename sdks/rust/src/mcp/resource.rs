//! Cloud-side MCP HTTP proxy (pre-existing).
//!
//! This is the original `McpResource` surface that talks to the Cognitum
//! cloud API (`/apiMcpTools`, `/mcpSse`, `/docsSearch`). It is kept exactly
//! as it was before the OQ-4 stdio work so downstream `client.mcp()` usage
//! is byte-compatible.

use serde::Serialize;
use serde_json::Value;

use crate::client::Client;
use crate::error::Error;
use crate::types::{DocsSearchResult, McpTool, McpToolResult};

/// Operations on the MCP (Model Context Protocol) tools API.
pub struct McpResource<'a> {
    pub(crate) client: &'a Client,
}

/// JSON-RPC 2.0 request envelope used by the MCP SSE endpoint.
#[derive(Serialize)]
struct JsonRpcRequest {
    jsonrpc: &'static str,
    method: String,
    params: Value,
    id: u64,
}

/// JSON-RPC 2.0 response envelope.
#[derive(serde::Deserialize)]
struct JsonRpcResponse {
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<JsonRpcError>,
}

#[derive(serde::Deserialize)]
struct JsonRpcError {
    #[serde(default)]
    code: i64,
    message: String,
}

/// Response from the initialize handshake.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResponse {
    #[serde(default)]
    pub protocol_version: Option<String>,
    #[serde(default)]
    pub capabilities: Option<Value>,
    #[serde(default)]
    pub server_info: Option<Value>,
}

impl<'a> McpResource<'a> {
    /// List all available MCP tools.
    pub async fn list_tools(&self) -> Result<Vec<McpTool>, Error> {
        self.client.get("/apiMcpTools").await
    }

    /// Invoke an MCP tool by name with the given arguments.
    pub async fn call_tool(&self, name: &str, args: Value) -> Result<McpToolResult, Error> {
        let rpc = JsonRpcRequest {
            jsonrpc: "2.0",
            method: "tools/call".to_owned(),
            params: serde_json::json!({
                "name": name,
                "arguments": args,
            }),
            id: 1,
        };
        let resp: JsonRpcResponse = self.client.post("/mcpSse", &rpc).await?;
        if let Some(err) = resp.error {
            return Err(Error::Api {
                code: err.code as u16,
                message: err.message,
            });
        }
        let result = resp.result.unwrap_or(Value::Null);
        let tool_result: McpToolResult = serde_json::from_value(result)?;
        Ok(tool_result)
    }

    /// Search the documentation index.
    pub async fn search_docs(
        &self,
        query: &str,
        limit: Option<u32>,
    ) -> Result<Vec<DocsSearchResult>, Error> {
        let body = serde_json::json!({
            "query": query,
            "limit": limit.unwrap_or(10),
        });
        self.client.post("/docsSearch", &body).await
    }

    /// Perform the MCP initialize handshake.
    pub async fn initialize(&self) -> Result<InitializeResponse, Error> {
        let rpc = JsonRpcRequest {
            jsonrpc: "2.0",
            method: "initialize".to_owned(),
            params: serde_json::json!({}),
            id: 0,
        };
        let resp: JsonRpcResponse = self.client.post("/mcpSse", &rpc).await?;
        if let Some(err) = resp.error {
            return Err(Error::Api {
                code: err.code as u16,
                message: err.message,
            });
        }
        let result = resp.result.unwrap_or(Value::Null);
        let init: InitializeResponse = serde_json::from_value(result)?;
        Ok(init)
    }
}
