//! Anthropic `messages` streaming event types (ADR-0024a §D5, issue #58 M2
//! continuation -- item 2 of the tracked "what's left" list). Mirrors
//! `super::openai_events`'s decode discipline exactly, but for the
//! Anthropic Messages wire protocol: `message_start`, `content_block_start`,
//! `content_block_delta`, `content_block_stop`, `message_delta`,
//! `message_stop`, `ping`, and a wire-level `error` event. Any recognized
//! SSE frame whose payload shape this decoder does not understand falls
//! back to [`AnthropicStreamEvent::Unknown`] rather than panicking -- same
//! contract as the OpenAI decoder.
//!
//! Unlike OpenAI chat-completions chunks (which carry no `event:` field and
//! pack multiple facets into one JSON object), Anthropic's wire sets a real
//! SSE `event:` name that duplicates the JSON payload's own `"type"` field
//! (ADR-0024a §D5 ground truth). This decoder switches on the JSON
//! payload's `"type"` (falling back to `raw.event` only if the JSON itself
//! has none) so a well-formed payload is never hidden by a
//! mismatched/missing `event:` field -- the JSON body is authoritative,
//! exactly as it is for the OpenAI decoder's `choices[].delta` shape.
//!
//! `ping` is modeled as its own recognized variant
//! ([`AnthropicStreamEvent::Ping`]), NOT `Unknown` -- it carries no payload
//! but is a real, expected keepalive frame, not a decode failure.
//!
//! The Cognitum receipt facet (`cognitum_receipt`) is decoded from whichever
//! event payload carries it, same top-level-key check as
//! `decode_openai_sse_event` -- ADR-0024a treats the receipt facet as
//! protocol-uniform, not chat-completions-specific.

use serde_json::Value;

use crate::meta_llm::types::{parse_meta_llm_receipt, AnthropicContentBlock, AnthropicUsage, MetaLlmReceipt};
use crate::sse::SseEvent;

/// The `message` object embedded in a `message_start` event -- a message
/// whose content/usage are still being filled in.
///
/// No `PartialEq` derive: `content: Vec<AnthropicContentBlock>` embeds
/// `super::super::types::AnthropicContentBlock`, which itself does not
/// derive `PartialEq` (it is a shared wire type with `meta_proxy`, out of
/// scope to change here) -- tests use pattern matching / field access
/// instead of whole-struct equality, same as `OpenAiStreamEvent`'s
/// existing test suite does for its own facets.
#[derive(Debug, Clone)]
pub struct AnthropicStreamMessageStart {
    pub id: String,
    pub role: String,
    pub content: Vec<AnthropicContentBlock>,
    pub model: String,
    pub stop_reason: Option<String>,
    pub stop_sequence: Option<String>,
    pub usage: AnthropicUsage,
}

/// The content block a `content_block_start` event opens at `index` --
/// fields fill in via subsequent `content_block_delta`s.
#[derive(Debug, Clone, PartialEq)]
pub enum AnthropicStreamContentBlockStart {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum AnthropicContentBlockDelta {
    TextDelta { text: String },
    InputJsonDelta { partial_json: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct AnthropicMessageDeltaPayload {
    pub stop_reason: Option<String>,
    pub stop_sequence: Option<String>,
}

/// `message_delta`'s trailing `usage` only ever carries `output_tokens`
/// (ADR-0024a §D5 ground truth).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AnthropicMessageDeltaUsage {
    pub output_tokens: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AnthropicStreamErrorPayload {
    pub r#type: String,
    pub message: String,
}

/// A single decoded facet of one Anthropic `messages` streaming SSE event
/// (ADR-0024a §D5). `Unknown` is the typed catch-all for a syntactically
/// valid SSE event whose payload this decoder does not recognize.
// `MetaLlmReceipt` (issue #59, D11 migration step 1) is a genuinely large,
// detailed struct -- at most one `Receipt` event occurs per stream, so the
// size cost of the enum is accepted rather than boxing, same rationale as
// `OpenAiStreamEvent`.
// No `PartialEq` derive here: the `MessageStart` variant embeds
// `AnthropicStreamMessageStart`, which itself cannot derive `PartialEq`
// (see that struct's doc comment).
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone)]
pub enum AnthropicStreamEvent {
    MessageStart {
        message: AnthropicStreamMessageStart,
    },
    ContentBlockStart {
        index: u32,
        content_block: AnthropicStreamContentBlockStart,
    },
    ContentBlockDelta {
        index: u32,
        delta: AnthropicContentBlockDelta,
    },
    ContentBlockStop {
        index: u32,
    },
    MessageDelta {
        delta: AnthropicMessageDeltaPayload,
        usage: Option<AnthropicMessageDeltaUsage>,
    },
    /// The wire terminal condition for a successful Anthropic Messages
    /// stream -- there is no `[DONE]` sentinel.
    MessageStop,
    /// Keepalive heartbeat. Carries no payload; recognized deliberately
    /// rather than falling back to `Unknown`.
    Ping,
    /// A wire-level terminal error event embedded in the SSE stream itself
    /// (`data: {"type":"error","error":{...}}`).
    Error {
        error: AnthropicStreamErrorPayload,
    },
    Receipt {
        receipt: MetaLlmReceipt,
    },
    /// A syntactically valid SSE event whose payload this decoder does not recognize. Never a panic.
    Unknown {
        raw: Value,
    },
}

/// Top-level JSON keys this decoder understands; everything else is preserved as `unknown_fields`.
const KNOWN_TOP_LEVEL_KEYS: &[&str] = &[
    "type",
    "message",
    "index",
    "content_block",
    "delta",
    "usage",
    "error",
    "cognitum_receipt",
];

#[derive(Debug, Clone, Default)]
pub struct DecodedAnthropicSseEvent {
    pub events: Vec<AnthropicStreamEvent>,
    pub unknown_fields: Option<serde_json::Map<String, Value>>,
}

fn str_field(obj: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key).and_then(|v| v.as_str()).map(str::to_owned)
}

fn decode_content_block(raw: &Value) -> Option<AnthropicStreamContentBlockStart> {
    let obj = raw.as_object()?;
    match obj.get("type").and_then(|v| v.as_str())? {
        "text" => Some(AnthropicStreamContentBlockStart::Text {
            text: str_field(obj, "text").unwrap_or_default(),
        }),
        "tool_use" => Some(AnthropicStreamContentBlockStart::ToolUse {
            id: str_field(obj, "id").unwrap_or_default(),
            name: str_field(obj, "name").unwrap_or_default(),
            input: obj.get("input").cloned().unwrap_or(Value::Object(serde_json::Map::new())),
        }),
        _ => None,
    }
}

/// A `message_start.message.content` entry decodes with the same shapes
/// [`decode_content_block`] recognizes, mapped into the shared
/// [`AnthropicContentBlock`] wire type; unrecognized entries are dropped
/// rather than failing the whole event.
fn decode_message_content_block(raw: &Value) -> Option<AnthropicContentBlock> {
    let obj = raw.as_object()?;
    match obj.get("type").and_then(|v| v.as_str())? {
        "text" => Some(AnthropicContentBlock::Text {
            text: str_field(obj, "text").unwrap_or_default(),
        }),
        "tool_use" => Some(AnthropicContentBlock::ToolUse {
            id: str_field(obj, "id").unwrap_or_default(),
            name: str_field(obj, "name").unwrap_or_default(),
            input: obj.get("input").cloned().unwrap_or(Value::Object(serde_json::Map::new())),
        }),
        _ => None,
    }
}

fn decode_message_start(raw: &Value) -> Option<AnthropicStreamMessageStart> {
    let obj = raw.as_object()?;
    let empty_usage = serde_json::Map::new();
    let usage = obj.get("usage").and_then(|v| v.as_object()).unwrap_or(&empty_usage);
    let content = obj
        .get("content")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(decode_message_content_block).collect())
        .unwrap_or_default();
    Some(AnthropicStreamMessageStart {
        id: str_field(obj, "id").unwrap_or_default(),
        role: str_field(obj, "role").unwrap_or_else(|| "assistant".to_owned()),
        content,
        model: str_field(obj, "model").unwrap_or_default(),
        stop_reason: str_field(obj, "stop_reason"),
        stop_sequence: str_field(obj, "stop_sequence"),
        usage: AnthropicUsage {
            input_tokens: usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
            output_tokens: usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
        },
    })
}

fn decode_delta(raw: &Value) -> Option<AnthropicContentBlockDelta> {
    let obj = raw.as_object()?;
    match obj.get("type").and_then(|v| v.as_str())? {
        "text_delta" => Some(AnthropicContentBlockDelta::TextDelta {
            text: str_field(obj, "text").unwrap_or_default(),
        }),
        "input_json_delta" => Some(AnthropicContentBlockDelta::InputJsonDelta {
            partial_json: str_field(obj, "partial_json").unwrap_or_default(),
        }),
        _ => None,
    }
}

/// Decode one generic [`SseEvent`] into zero or more
/// [`AnthropicStreamEvent`]s. Never panics -- malformed JSON or an
/// unrecognized shape becomes [`AnthropicStreamEvent::Unknown`] (same
/// contract as [`super::openai_events::decode_openai_sse_event`]).
pub fn decode_anthropic_sse_event(raw: &SseEvent) -> DecodedAnthropicSseEvent {
    let parsed: Value = match serde_json::from_str(&raw.data) {
        Ok(v) => v,
        Err(_) => {
            return DecodedAnthropicSseEvent {
                events: vec![AnthropicStreamEvent::Unknown {
                    raw: Value::String(raw.data.clone()),
                }],
                unknown_fields: None,
            };
        }
    };

    let Some(obj) = parsed.as_object() else {
        return DecodedAnthropicSseEvent {
            events: vec![AnthropicStreamEvent::Unknown { raw: parsed }],
            unknown_fields: None,
        };
    };

    let mut events = Vec::new();
    let event_type = obj
        .get("type")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .or_else(|| raw.event.clone());

    match event_type.as_deref() {
        Some("message_start") => {
            if let Some(message) = obj.get("message").and_then(decode_message_start) {
                events.push(AnthropicStreamEvent::MessageStart { message });
            }
        }
        Some("content_block_start") => {
            if let Some(content_block) = obj.get("content_block").and_then(decode_content_block) {
                events.push(AnthropicStreamEvent::ContentBlockStart {
                    index: obj.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                    content_block,
                });
            }
        }
        Some("content_block_delta") => {
            if let Some(delta) = obj.get("delta").and_then(decode_delta) {
                events.push(AnthropicStreamEvent::ContentBlockDelta {
                    index: obj.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                    delta,
                });
            }
        }
        Some("content_block_stop") => {
            events.push(AnthropicStreamEvent::ContentBlockStop {
                index: obj.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            });
        }
        Some("message_delta") => {
            let empty_delta = serde_json::Map::new();
            let delta_obj = obj.get("delta").and_then(|v| v.as_object()).unwrap_or(&empty_delta);
            let usage = obj.get("usage").and_then(|v| v.as_object()).map(|u| AnthropicMessageDeltaUsage {
                output_tokens: u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
            });
            events.push(AnthropicStreamEvent::MessageDelta {
                delta: AnthropicMessageDeltaPayload {
                    stop_reason: str_field(delta_obj, "stop_reason"),
                    stop_sequence: str_field(delta_obj, "stop_sequence"),
                },
                usage,
            });
        }
        Some("message_stop") => {
            events.push(AnthropicStreamEvent::MessageStop);
        }
        Some("ping") => {
            events.push(AnthropicStreamEvent::Ping);
        }
        Some("error") => {
            let empty_error = serde_json::Map::new();
            let error_obj = obj.get("error").and_then(|v| v.as_object()).unwrap_or(&empty_error);
            events.push(AnthropicStreamEvent::Error {
                error: AnthropicStreamErrorPayload {
                    r#type: str_field(error_obj, "type").unwrap_or_else(|| "unknown_error".to_owned()),
                    message: str_field(error_obj, "message").unwrap_or_else(|| "unknown error".to_owned()),
                },
            });
        }
        _ => {}
    }

    // ADR-0024a: the Cognitum receipt facet is protocol-uniform -- decode
    // it from whichever event payload carries the top-level key, same as
    // the OpenAI decoder, regardless of which `type` this event otherwise
    // was.
    if let Some(receipt_raw) = obj.get("cognitum_receipt") {
        if let Some(receipt) = parse_meta_llm_receipt(receipt_raw) {
            events.push(AnthropicStreamEvent::Receipt { receipt });
        }
    }

    if events.is_empty() {
        events.push(AnthropicStreamEvent::Unknown {
            raw: parsed.clone(),
        });
    }

    let unknown_fields: serde_json::Map<String, Value> = obj
        .iter()
        .filter(|(key, _)| !KNOWN_TOP_LEVEL_KEYS.contains(&key.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    DecodedAnthropicSseEvent {
        events,
        unknown_fields: if unknown_fields.is_empty() {
            None
        } else {
            Some(unknown_fields)
        },
    }
}
