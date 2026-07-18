//! Meta LLM protocol-specific wire types (ADR-0024a §D3).
//!
//! Split by wire family: [`openai`] (chat completions, legacy completions,
//! Responses, embeddings) and [`anthropic`] (Messages, count-tokens).

pub mod anthropic;
pub mod openai;

pub use anthropic::{
    AnthropicContentBlock, AnthropicImageSource, AnthropicMessage, AnthropicMessageContent,
    AnthropicMessageParam, AnthropicMessageRequest, AnthropicRole, AnthropicToolChoice,
    AnthropicToolDefinition, AnthropicUsage, CountTokensRequest, CountTokensResult,
};
pub use openai::{
    ChatCompletion, ChatCompletionChoice, ChatCompletionRequest, ChatCompletionUsage,
    ChatContentPart, ChatImageUrl, ChatMessage, ChatMessageContent, ChatRole, ChatToolCall,
    ChatToolCallFunction, ChatToolChoice, ChatToolChoiceFunction, ChatToolDefinition,
    ChatToolFunctionDef, EmbeddingDatum, EmbeddingRequest, EmbeddingResponse, EmbeddingUsage,
    LegacyCompletion, LegacyCompletionChoice, LegacyCompletionRequest, ResponsesOutputItem,
    ResponsesRequest, ResponsesResponse, StringOrStrings,
};
