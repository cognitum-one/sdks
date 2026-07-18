//! Protocol-agnostic Server-Sent Events parsing (ADR-0024a §D5). No
//! Meta-LLM (or any other product) knowledge lives here -- reused as-is by
//! every streaming protocol facade. Gated behind the `meta-llm` feature
//! for now since it is the module's only current consumer; the module
//! itself has zero dependency on `crate::meta_llm`.

mod parser;

pub use parser::{
    SseEvent, SseParseError, SseParser, SseParserFinishResult, SseParserOptions,
    DEFAULT_MAX_BUFFERED_BYTES, DEFAULT_MAX_EVENT_BYTES, DEFAULT_MAX_LINE_BYTES,
    DEFAULT_MAX_MALFORMED_EVENTS,
};
