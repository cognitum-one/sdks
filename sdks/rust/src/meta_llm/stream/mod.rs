//! Streaming facades for Meta LLM (ADR-0024a §D5). Issue #58 / M2
//! continuation: `chat_completions` streaming (PR #88) and, this pass,
//! Anthropic Messages streaming (item 2 of the tracked "what's left"
//! list) -- both wired onto the same generic [`crate::sse`] parser.
//! Responses streaming remains a deferred follow-up.

mod anthropic_events;
mod chat_completions_stream;
mod envelope;
mod messages_stream;
mod openai_events;

pub use anthropic_events::{
    decode_anthropic_sse_event, AnthropicContentBlockDelta, AnthropicMessageDeltaPayload,
    AnthropicMessageDeltaUsage, AnthropicStreamContentBlockStart, AnthropicStreamErrorPayload,
    AnthropicStreamEvent, AnthropicStreamMessageStart, DecodedAnthropicSseEvent,
};
pub use chat_completions_stream::{chat_completions_stream, ChatCompletionsStream};
pub use envelope::{
    ChatCompletionsStreamAccumulator, ChatCompletionsStreamSnapshot, MetaLlmStreamEnvelope,
    ToolCallAccumulation,
};
pub use messages_stream::{messages_create_stream, MessagesStream};
pub use openai_events::{
    decode_openai_sse_event, DecodedOpenAiSseEvent, OpenAiStreamErrorPayload, OpenAiStreamEvent,
};
