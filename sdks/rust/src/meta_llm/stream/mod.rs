//! Streaming facades for Meta LLM (ADR-0024a §D5). Issue #58 / M2
//! continuation lands `chat_completions` streaming only this pass;
//! Anthropic Messages and Responses streaming are deferred follow-ups
//! reusing [`crate::sse`].

mod chat_completions_stream;
mod envelope;
mod openai_events;

pub use chat_completions_stream::{chat_completions_stream, ChatCompletionsStream};
pub use envelope::{
    ChatCompletionsStreamAccumulator, ChatCompletionsStreamSnapshot, MetaLlmStreamEnvelope,
    ToolCallAccumulation,
};
pub use openai_events::{
    decode_openai_sse_event, DecodedOpenAiSseEvent, OpenAiStreamErrorPayload, OpenAiStreamEvent,
};
