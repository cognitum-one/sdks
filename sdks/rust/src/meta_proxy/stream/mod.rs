//! Streaming facade for `MetaProxyClient` (ADR-0025a §D8). Issue #61 / M3
//! continuation lands `chat_completions_stream` only this pass; Anthropic
//! Messages streaming is a deferred follow-up reusing the same `crate::sse`
//! parser and `crate::meta_llm::stream` decoder.

mod chat_completions_stream;
mod envelope;

pub use chat_completions_stream::{chat_completions_stream, MetaProxyChatCompletionsStream};
pub use envelope::{MetaProxyStreamEnvelope, MetaProxyStreamMeta};
