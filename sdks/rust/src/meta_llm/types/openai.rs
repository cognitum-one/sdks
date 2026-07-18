//! OpenAI-style wire types (ADR-0024a §D3): chat completions, legacy
//! completions, Responses, and embeddings. Request/response shapes only —
//! no HTTP call logic lands in this pass (issue #58 / M2 scope).
//!
//! The SDK does not invent a universal prompt object (ADR-0024a §D3):
//! content blocks, tools, tool choices, finish reasons, and usage stay in
//! this native OpenAI-compatible namespace rather than a cross-protocol
//! shared shape.
//!
//! Field names are `snake_case`, matching both Rust convention and the
//! wire's own snake_case (`max_tokens`, `top_p`, ...) — `#[serde(rename_all
//! = "snake_case")]` is added explicitly for clarity even where it is a
//! no-op, and per-field renames cover the few reserved-word collisions
//! (`type` -> `r#type`).
//!
//! `routing_controls` (ADR-0024b §D2, issue #59) is added to
//! `ChatCompletionRequest`, `LegacyCompletionRequest`, and
//! `ResponsesRequest` — the same three protocol request shapes ADR-0024b's
//! issue names, alongside `AnthropicMessageRequest` in `super::anthropic`.
//! `EmbeddingRequest` deliberately does NOT get this field: it is out of
//! ADR-0024b D11 step 1's scope.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::routing::MetaLlmRoutingControls;

/// A single chat message. Content may be plain text or a multi-part array.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: Option<ChatMessageContent>,
    pub name: Option<String>,
    pub tool_call_id: Option<String>,
    pub tool_calls: Option<Vec<ChatToolCall>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatRole {
    System,
    User,
    Assistant,
    Tool,
    Developer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ChatMessageContent {
    Text(String),
    Parts(Vec<ChatContentPart>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatContentPart {
    Text { text: String },
    ImageUrl { image_url: ChatImageUrl },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ChatImageUrl {
    pub url: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ChatToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: ChatToolCallFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatToolCallFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ChatToolDefinition {
    #[serde(rename = "type")]
    pub kind: String,
    pub function: ChatToolFunctionDef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatToolFunctionDef {
    pub name: String,
    pub description: Option<String>,
    pub parameters: Option<serde_json::Value>,
}

/// `"none" | "auto" | "required" | {"type": "function", "function": {"name": ...}}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ChatToolChoice {
    Mode(String),
    Function {
        #[serde(rename = "type")]
        kind: String,
        function: ChatToolChoiceFunction,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatToolChoiceFunction {
    pub name: String,
}

/// `POST /v1/chat/completions` request. Server currently caps `n = 1`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ChatCompletionRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    /// Server-enforced maximum of 1 (ADR-0024a §D3).
    pub n: Option<u32>,
    pub stream: Option<bool>,
    pub stop: Option<StringOrStrings>,
    pub presence_penalty: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub logit_bias: Option<HashMap<String, f64>>,
    pub user: Option<String>,
    pub tools: Option<Vec<ChatToolDefinition>>,
    pub tool_choice: Option<ChatToolChoice>,
    pub response_format: Option<HashMap<String, String>>,
    pub seed: Option<i64>,
    /// ADR-0024b §D2. Body controls win over any `X-Cognitum-*` header.
    pub routing_controls: Option<MetaLlmRoutingControls>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum StringOrStrings {
    One(String),
    Many(Vec<String>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ChatCompletionUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ChatCompletionChoice {
    pub index: u32,
    pub message: ChatMessage,
    pub finish_reason: Option<String>,
    pub logprobs: Option<serde_json::Value>,
}

/// `POST /v1/chat/completions` response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ChatCompletion {
    pub id: String,
    #[serde(rename = "object")]
    pub object_type: String,
    pub created: i64,
    pub model: String,
    pub choices: Vec<ChatCompletionChoice>,
    pub usage: Option<ChatCompletionUsage>,
    pub system_fingerprint: Option<String>,
}

/// `POST /v1/completions` (legacy) request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct LegacyCompletionRequest {
    pub model: String,
    pub prompt: StringOrStrings,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub n: Option<u32>,
    pub stream: Option<bool>,
    pub logprobs: Option<u32>,
    pub echo: Option<bool>,
    pub stop: Option<StringOrStrings>,
    pub presence_penalty: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub best_of: Option<u32>,
    pub logit_bias: Option<HashMap<String, f64>>,
    pub user: Option<String>,
    /// ADR-0024b §D2. Body controls win over any `X-Cognitum-*` header.
    pub routing_controls: Option<MetaLlmRoutingControls>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct LegacyCompletionChoice {
    pub text: String,
    pub index: u32,
    pub logprobs: Option<serde_json::Value>,
    pub finish_reason: Option<String>,
}

/// `POST /v1/completions` (legacy) response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct LegacyCompletion {
    pub id: String,
    #[serde(rename = "object")]
    pub object_type: String,
    pub created: i64,
    pub model: String,
    pub choices: Vec<LegacyCompletionChoice>,
    pub usage: Option<ChatCompletionUsage>,
}

/// Discriminated Responses output item. Kept intentionally partial pending GA.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResponsesOutputItem {
    Message {
        id: String,
        role: String,
        content: Vec<ChatContentPart>,
    },
    Reasoning {
        id: String,
        summary: Option<Vec<String>>,
    },
    ToolCall {
        id: String,
        name: String,
        arguments: String,
    },
}

/// `POST /v1/responses` request. Current server is stateless: callers
/// resend conversation input. `previous_response_id` is preview and MUST
/// NOT be described as recovery (ADR-0024a §D3).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ResponsesRequest {
    pub model: String,
    pub input: ChatMessageContent,
    pub instructions: Option<String>,
    /// Preview-only; server does not restore conversation state (ADR-0024a §D3).
    pub previous_response_id: Option<String>,
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub stream: Option<bool>,
    pub tools: Option<Vec<ChatToolDefinition>>,
    pub tool_choice: Option<ChatToolChoice>,
    pub metadata: Option<HashMap<String, String>>,
    /// ADR-0024b §D2. Body controls win over any `X-Cognitum-*` header.
    pub routing_controls: Option<MetaLlmRoutingControls>,
}

/// `POST /v1/responses` response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ResponsesResponse {
    pub id: String,
    #[serde(rename = "object")]
    pub object_type: String,
    pub created_at: i64,
    pub model: String,
    pub status: String,
    pub output: Vec<ResponsesOutputItem>,
    pub usage: Option<ChatCompletionUsage>,
    pub previous_response_id: Option<String>,
    pub incomplete_details: Option<HashMap<String, String>>,
}

/// `POST /v1/embeddings` request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct EmbeddingRequest {
    pub model: String,
    pub input: StringOrStrings,
    pub encoding_format: Option<String>,
    pub dimensions: Option<u32>,
    pub user: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct EmbeddingDatum {
    #[serde(rename = "object")]
    pub object_type: String,
    pub embedding: Vec<f64>,
    pub index: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct EmbeddingUsage {
    pub prompt_tokens: u64,
    pub total_tokens: u64,
}

/// `POST /v1/embeddings` response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct EmbeddingResponse {
    #[serde(rename = "object")]
    pub object_type: String,
    pub data: Vec<EmbeddingDatum>,
    pub model: String,
    pub usage: EmbeddingUsage,
}
