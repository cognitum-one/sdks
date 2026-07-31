//! Anthropic-style wire types (ADR-0024a §D3): Messages and count-tokens.
//! Request/response shapes only — no HTTP call logic lands in this pass
//! (issue #58 / M2 scope).
//!
//! Image and document content blocks are modeled for forward compatibility,
//! but the audited server currently rejects them (ADR-0024a Context table)
//! — callers MUST NOT assume they are accepted yet.
//!
//! Field names are `snake_case`, matching both Rust convention and the
//! wire's own snake_case (`max_tokens`, `stop_sequences`, ...).
//!
//! `routing_controls` (ADR-0024b §D2, issue #59) is added to
//! `AnthropicMessageRequest` -- see `super::openai`'s module docs for the
//! full list of the four request shapes this field lands on.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::openai::ChatMessageContent;
use super::routing::MetaLlmRoutingControls;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AnthropicImageSource {
    #[serde(rename = "type")]
    pub kind: String,
    pub media_type: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AnthropicContentBlock {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolResult {
        tool_use_id: String,
        content: Option<ChatMessageContent>,
        is_error: Option<bool>,
    },
    /// Modeled for forward compatibility only — currently rejected server-side.
    Image {
        source: AnthropicImageSource,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AnthropicMessageParam {
    pub role: AnthropicRole,
    pub content: AnthropicMessageContent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnthropicRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AnthropicMessageContent {
    Text(String),
    Blocks(Vec<AnthropicContentBlock>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AnthropicToolDefinition {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: serde_json::Value,
}

/// `{"type": "auto"} | {"type": "any"} | {"type": "tool", "name": ...}`.
pub type AnthropicToolChoice = HashMap<String, serde_json::Value>;

/// `POST /v1/messages` request. `max_tokens` is required by the wire shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AnthropicMessageRequest {
    pub model: String,
    pub messages: Vec<AnthropicMessageParam>,
    pub max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_k: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_sequences: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<AnthropicToolDefinition>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<AnthropicToolChoice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, String>>,
    /// ADR-0024b §D2. Body controls win over any `X-Cognitum-*` header.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routing_controls: Option<MetaLlmRoutingControls>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AnthropicUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// `POST /v1/messages` response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AnthropicMessage {
    pub id: String,
    #[serde(rename = "type")]
    pub message_type: String,
    pub role: AnthropicRole,
    pub content: Vec<AnthropicContentBlock>,
    pub model: String,
    pub stop_reason: Option<String>,
    pub stop_sequence: Option<String>,
    pub usage: AnthropicUsage,
}

/// `POST /v1/messages/count_tokens` request. Mirrors the message-creation
/// shape minus generation parameters (ADR-0024a §D3 Context table).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CountTokensRequest {
    pub model: String,
    pub messages: Vec<AnthropicMessageParam>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<AnthropicToolDefinition>>,
}

/// `POST /v1/messages/count_tokens` response.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CountTokensResult {
    pub input_tokens: u64,
}
