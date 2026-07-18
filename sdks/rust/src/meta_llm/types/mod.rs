//! Meta LLM protocol-specific wire types (ADR-0024a §D3).
//!
//! Split by wire family: [`openai`] (chat completions, legacy completions,
//! Responses, embeddings) and [`anthropic`] (Messages, count-tokens).
//!
//! ADR-0024b D11 migration step 1 (issue #59) adds [`routing`] (routing
//! controls), [`money`] (the decimal `Money` type), [`receipt`] (the
//! concrete `MetaLlmReceipt`), and [`usage`] (usage/budget types + the
//! bounded query `MetaLlmClient::usage` accepts).

pub mod anthropic;
pub mod money;
pub mod openai;
pub mod receipt;
pub mod routing;
pub mod usage;

pub use anthropic::{
    AnthropicContentBlock, AnthropicImageSource, AnthropicMessage, AnthropicMessageContent,
    AnthropicMessageParam, AnthropicMessageRequest, AnthropicRole, AnthropicToolChoice,
    AnthropicToolDefinition, AnthropicUsage, CountTokensRequest, CountTokensResult,
};
pub use money::{parse_money, Money};
pub use openai::{
    ChatCompletion, ChatCompletionChoice, ChatCompletionRequest, ChatCompletionUsage,
    ChatContentPart, ChatImageUrl, ChatMessage, ChatMessageContent, ChatRole, ChatToolCall,
    ChatToolCallFunction, ChatToolChoice, ChatToolChoiceFunction, ChatToolDefinition,
    ChatToolFunctionDef, EmbeddingDatum, EmbeddingRequest, EmbeddingResponse, EmbeddingUsage,
    LegacyCompletion, LegacyCompletionChoice, LegacyCompletionRequest, ResponsesOutputItem,
    ResponsesRequest, ResponsesResponse, StringOrStrings,
};
pub use receipt::{parse_meta_llm_receipt, MetaLlmReceipt, ReceiptCacheResult, ReceiptModelTier, SafetySummary};
pub use routing::{
    assert_sendable_routing_controls, CacheMode, EscalationStrategy, FallbackPolicy,
    MetaLlmRoutingControls, ModelSelector, ModelTier, SafetyMode, SubTenantAttribution,
    UnsendableRoutingControlsError,
};
pub use usage::{
    assert_valid_usage_query, parse_usage_summary, BudgetView, CacheStats, InvalidUsageQueryError,
    UsageBreakdownEntry, UsageGroupBy, UsagePeriodEntry, UsageQuery, UsageSummary, UsageTotals,
};
