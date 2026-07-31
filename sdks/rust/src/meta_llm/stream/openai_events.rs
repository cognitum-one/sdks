//! OpenAI `chat.completions` streaming event types (ADR-0024a §D5): role,
//! content delta, tool-call fragments, finish reason, trailing usage, the
//! Cognitum receipt, a terminal wire-level error event, and the `[DONE]`
//! sentinel. Any recognized-but-not-decoded shape falls back to
//! [`OpenAiStreamEvent::Unknown`] rather than panicking.
//!
//! `receipt` is now the concrete ADR-0024b §D3 [`MetaLlmReceipt`] struct
//! (issue #59, D11 migration step 1) rather than the earlier
//! `serde_json::Value` alias -- this is the "receipt field ... already
//! anticipated" slot the streaming pass (PR #88) reserved for it.
//! [`crate::meta_llm::types::parse_meta_llm_receipt`] never fails the
//! whole event on a malformed/incomplete receipt field (a missing
//! `request_id` defaults to `""` rather than rejecting the receipt --
//! see that function's docs), preserving "Unknown valid events become
//! `UnknownStreamEvent`" / "missing metadata remains missing" -- the same
//! guarantee the earlier `Value`-typed design existed to provide.
//!
//! One raw SSE `data:` payload can decode into *multiple* facets (e.g. one
//! chunk carrying both a content delta and, on the last chunk, a finish
//! reason) -- [`decode_openai_sse_event`] returns all of them, each
//! becoming its own [`super::envelope::MetaLlmStreamEnvelope`] with its own
//! sequence number, preserving per-facet granularity rather than
//! flattening a chunk into one opaque event.

use serde_json::Value;

use crate::meta_llm::types::{parse_meta_llm_receipt, ChatCompletionUsage, MetaLlmReceipt};
use crate::sse::SseEvent;

#[derive(Debug, Clone, PartialEq)]
pub struct OpenAiStreamErrorPayload {
    pub message: String,
    pub r#type: Option<String>,
    pub code: Option<String>,
    pub param: Option<String>,
}

/// A single decoded facet of one OpenAI `chat.completions` streaming chunk
/// (ADR-0024a §D5). `Unknown` is the typed catch-all for a syntactically
/// valid SSE event whose payload this decoder does not recognize.
// `MetaLlmReceipt` (issue #59, D11 migration step 1) is a genuinely large,
// detailed struct now that it carries the concrete ADR-0024b §D3 shape
// instead of an opaque `serde_json::Value` -- at most one `Receipt` event
// occurs per stream, so the size cost of the enum is accepted rather than
// boxing (which would push `.clone()`/pattern-match friction onto every
// other variant's much smaller, much more frequent call sites).
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq)]
pub enum OpenAiStreamEvent {
    Role {
        index: u32,
        role: String,
    },
    ContentDelta {
        index: u32,
        delta: String,
    },
    ToolCallDelta {
        index: u32,
        tool_call_index: u32,
        id: Option<String>,
        function_name: Option<String>,
        arguments_delta: Option<String>,
    },
    FinishReason {
        index: u32,
        finish_reason: String,
    },
    Usage {
        usage: ChatCompletionUsage,
    },
    /// A wire-level terminal error event embedded in the SSE stream itself (`data: {"error": {...}}`).
    Error {
        error: OpenAiStreamErrorPayload,
    },
    Receipt {
        receipt: MetaLlmReceipt,
    },
    /// The literal `data: [DONE]` sentinel that closes a successful stream.
    Done,
    /// A syntactically valid SSE event whose payload this decoder does not recognize. Never a panic.
    Unknown {
        raw: Value,
    },
}

/// Top-level JSON keys this decoder understands; everything else is preserved as `unknown_fields`.
const KNOWN_TOP_LEVEL_KEYS: &[&str] = &[
    "id",
    "object",
    "created",
    "model",
    "choices",
    "usage",
    "cognitum_receipt",
    "system_fingerprint",
    "error",
];

#[derive(Debug, Clone, Default)]
pub struct DecodedOpenAiSseEvent {
    pub events: Vec<OpenAiStreamEvent>,
    pub unknown_fields: Option<serde_json::Map<String, Value>>,
}

fn str_field(obj: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key).and_then(|v| v.as_str()).map(str::to_owned)
}

/// Decode one generic [`SseEvent`] into zero or more [`OpenAiStreamEvent`]s.
/// Never panics -- malformed JSON or an unrecognized shape becomes
/// [`OpenAiStreamEvent::Unknown`] (ADR-0024a §D5: "Unknown valid events
/// become `UnknownStreamEvent`").
pub fn decode_openai_sse_event(raw: &SseEvent) -> DecodedOpenAiSseEvent {
    let trimmed = raw.data.trim();
    if trimmed == "[DONE]" {
        return DecodedOpenAiSseEvent {
            events: vec![OpenAiStreamEvent::Done],
            unknown_fields: None,
        };
    }

    let parsed: Value = match serde_json::from_str(&raw.data) {
        Ok(v) => v,
        Err(_) => {
            return DecodedOpenAiSseEvent {
                events: vec![OpenAiStreamEvent::Unknown {
                    raw: Value::String(raw.data.clone()),
                }],
                unknown_fields: None,
            };
        }
    };

    let Some(obj) = parsed.as_object() else {
        return DecodedOpenAiSseEvent {
            events: vec![OpenAiStreamEvent::Unknown { raw: parsed }],
            unknown_fields: None,
        };
    };

    let mut events = Vec::new();

    if let Some(error) = obj.get("error").and_then(|v| v.as_object()) {
        events.push(OpenAiStreamEvent::Error {
            error: OpenAiStreamErrorPayload {
                message: str_field(error, "message").unwrap_or_else(|| "unknown error".to_owned()),
                r#type: str_field(error, "type"),
                code: str_field(error, "code"),
                param: str_field(error, "param"),
            },
        });
    }

    if let Some(choices) = obj.get("choices").and_then(|v| v.as_array()) {
        for choice_value in choices {
            let Some(choice) = choice_value.as_object() else {
                continue;
            };
            let index = choice.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let empty_delta = serde_json::Map::new();
            let delta = choice
                .get("delta")
                .and_then(|v| v.as_object())
                .unwrap_or(&empty_delta);

            if let Some(role) = str_field(delta, "role") {
                events.push(OpenAiStreamEvent::Role { index, role });
            }
            if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
                if !content.is_empty() {
                    events.push(OpenAiStreamEvent::ContentDelta {
                        index,
                        delta: content.to_owned(),
                    });
                }
            }
            if let Some(tool_calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                for tool_call_value in tool_calls {
                    let Some(tool_call) = tool_call_value.as_object() else {
                        continue;
                    };
                    let empty_fn = serde_json::Map::new();
                    let function = tool_call
                        .get("function")
                        .and_then(|v| v.as_object())
                        .unwrap_or(&empty_fn);
                    events.push(OpenAiStreamEvent::ToolCallDelta {
                        index,
                        tool_call_index: tool_call
                            .get("index")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as u32,
                        id: str_field(tool_call, "id"),
                        function_name: str_field(function, "name"),
                        arguments_delta: str_field(function, "arguments"),
                    });
                }
            }
            if let Some(finish_reason) = str_field(choice, "finish_reason") {
                events.push(OpenAiStreamEvent::FinishReason {
                    index,
                    finish_reason,
                });
            }
        }
    }

    if let Some(usage) = obj.get("usage").and_then(|v| v.as_object()) {
        events.push(OpenAiStreamEvent::Usage {
            usage: ChatCompletionUsage {
                prompt_tokens: usage
                    .get("prompt_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                completion_tokens: usage
                    .get("completion_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                total_tokens: usage
                    .get("total_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
            },
        });
    }

    if let Some(receipt_raw) = obj.get("cognitum_receipt") {
        if let Some(receipt) = parse_meta_llm_receipt(receipt_raw) {
            events.push(OpenAiStreamEvent::Receipt { receipt });
        }
    }

    if events.is_empty() {
        events.push(OpenAiStreamEvent::Unknown {
            raw: parsed.clone(),
        });
    }

    let unknown_fields: serde_json::Map<String, Value> = obj
        .iter()
        .filter(|(key, _)| !KNOWN_TOP_LEVEL_KEYS.contains(&key.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    DecodedOpenAiSseEvent {
        events,
        unknown_fields: if unknown_fields.is_empty() {
            None
        } else {
            Some(unknown_fields)
        },
    }
}
