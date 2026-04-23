//! HTTP-backed [`Transport`] implementation.
//!
//! Thin JSON-RPC-over-HTTP wrapper that posts every request to a single
//! URL and reads the response body synchronously. This is the default
//! cloud path (`POST /mcpSse`) and keeps parity with Node's `httpTransport`.
//!
//! The transport is **request/response**, not streaming — each `send()` +
//! `recv()` pair rides one HTTP round-trip. That matches the MCP cloud
//! endpoint's current behaviour; callers that need server-pushed events
//! should layer SSE on top (OQ-3, separate ADR).

use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use reqwest::Client as HttpClient;
use std::collections::VecDeque;

use super::transport::{JsonRpcMessage, McpError, Transport};

/// Cloud-style HTTP transport.
pub struct HttpTransport {
    http: HttpClient,
    url: String,
    headers: HeaderMap,
    inbox: VecDeque<JsonRpcMessage>,
    closed: bool,
}

impl HttpTransport {
    /// Build a new transport pointing at `url`.
    ///
    /// `api_key` is sent as `X-API-Key` (ADR-0003). Callers that need
    /// different auth (pairing token, etc.) should use
    /// [`HttpTransport::with_headers`] or pass an empty string and set
    /// headers manually.
    pub fn new(url: impl Into<String>, api_key: &str) -> Result<Self, McpError> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if !api_key.is_empty() {
            let value = HeaderValue::from_str(api_key)
                .map_err(|e| McpError::Other(format!("invalid api key header: {e}")))?;
            headers.insert("X-API-Key", value);
        }
        Self::with_headers(url, headers)
    }

    /// Build a transport with a custom header set.
    pub fn with_headers(url: impl Into<String>, headers: HeaderMap) -> Result<Self, McpError> {
        let http = HttpClient::builder()
            .build()
            .map_err(|e| McpError::Other(format!("reqwest build: {e}")))?;
        Ok(Self {
            http,
            url: url.into(),
            headers,
            inbox: VecDeque::new(),
            closed: false,
        })
    }
}

#[async_trait]
impl Transport for HttpTransport {
    async fn send(&mut self, msg: JsonRpcMessage) -> Result<(), McpError> {
        if self.closed {
            return Err(McpError::Closed);
        }
        let body = serde_json::to_vec(&msg)?;
        let resp = self
            .http
            .post(&self.url)
            .headers(self.headers.clone())
            .body(body)
            .send()
            .await
            .map_err(|e| McpError::Other(format!("http send: {e}")))?;
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| McpError::Other(format!("http read: {e}")))?;
        // An empty body is legal for notifications; swallow it.
        if bytes.is_empty() {
            return Ok(());
        }
        let reply: JsonRpcMessage = serde_json::from_slice(&bytes)?;
        self.inbox.push_back(reply);
        Ok(())
    }

    async fn recv(&mut self) -> Result<JsonRpcMessage, McpError> {
        if let Some(msg) = self.inbox.pop_front() {
            return Ok(msg);
        }
        if self.closed {
            return Err(McpError::Closed);
        }
        // The HTTP transport is request/response: recv() only yields
        // messages that arrived as the body of the most recent send().
        // If the caller calls recv() without a pending reply, that's a
        // programming error — surface it as Closed to avoid a silent hang.
        Err(McpError::Closed)
    }

    async fn close(&mut self) -> Result<(), McpError> {
        self.closed = true;
        self.inbox.clear();
        Ok(())
    }
}
