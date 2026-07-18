//! `MetaLlmStreamEnvelope<E>` (ADR-0024a §D5's frozen streaming envelope
//! shape) plus a small optional text/tool accumulator over a
//! `chat.completions` event stream (D5 point 2: "an optional text/tool
//! accumulator over that stream").

use std::collections::HashMap;

use crate::meta_llm::envelope::MetaLlmReceipt;
use crate::meta_llm::types::ChatCompletionUsage;

use super::openai_events::OpenAiStreamEvent;

/// Wraps every parsed stream event with sequencing/provenance metadata.
/// Frozen shape per ADR-0024a §D5 -- do not add fields without an ADR update.
#[derive(Debug, Clone)]
pub struct MetaLlmStreamEnvelope<E> {
    pub event: E,
    /// 1-based order of this event within one logical stream call.
    pub sequence: u64,
    /// ISO-8601 timestamp of when this envelope was produced locally.
    pub received_at: String,
    pub request_id: String,
    /// The underlying SSE `event:` field name, if any (OpenAI chat
    /// completions does not set one).
    pub raw_event_name: Option<String>,
    /// Fields present on the wire payload that this decoder does not
    /// recognize -- preserved losslessly.
    pub unknown_fields: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Default)]
pub struct ToolCallAccumulation {
    pub id: Option<String>,
    pub name: Option<String>,
    pub arguments: String,
}

#[derive(Debug, Clone, Default)]
pub struct ChatCompletionsStreamSnapshot {
    pub role: Option<String>,
    pub content_by_choice: HashMap<u32, String>,
    pub tool_calls_by_choice: HashMap<u32, Vec<ToolCallAccumulation>>,
    pub finish_reason_by_choice: HashMap<u32, String>,
    pub usage: Option<ChatCompletionUsage>,
    pub receipt: Option<MetaLlmReceipt>,
    pub completed: bool,
}

/// Accumulates a `chat.completions` stream's role/content/tool-call/
/// finish/usage/receipt facets into one final snapshot. Works identically
/// whether the stream ended successfully or was cut short -- the caller
/// absorbs whatever envelopes were yielded before a terminal error and
/// reads [`Self::snapshot`] for the partial result (ADR-0024a §D5: partial
/// state is whatever was already delivered through normal iteration, not a
/// separately-reconstructed value).
#[derive(Debug, Default)]
pub struct ChatCompletionsStreamAccumulator {
    role: Option<String>,
    content_by_index: HashMap<u32, String>,
    tool_calls_by_index: HashMap<u32, HashMap<u32, ToolCallAccumulation>>,
    finish_reason_by_index: HashMap<u32, String>,
    usage: Option<ChatCompletionUsage>,
    receipt: Option<MetaLlmReceipt>,
    done: bool,
}

impl ChatCompletionsStreamAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn absorb(&mut self, envelope: &MetaLlmStreamEnvelope<OpenAiStreamEvent>) {
        match &envelope.event {
            OpenAiStreamEvent::Role { role, .. } => {
                self.role = Some(role.clone());
            }
            OpenAiStreamEvent::ContentDelta { index, delta } => {
                self.content_by_index
                    .entry(*index)
                    .or_default()
                    .push_str(delta);
            }
            OpenAiStreamEvent::ToolCallDelta {
                index,
                tool_call_index,
                id,
                function_name,
                arguments_delta,
            } => {
                let by_index = self.tool_calls_by_index.entry(*index).or_default();
                let existing = by_index.entry(*tool_call_index).or_default();
                if let Some(id) = id {
                    existing.id = Some(id.clone());
                }
                if let Some(name) = function_name {
                    existing.name = Some(name.clone());
                }
                if let Some(delta) = arguments_delta {
                    existing.arguments.push_str(delta);
                }
            }
            OpenAiStreamEvent::FinishReason {
                index,
                finish_reason,
            } => {
                self.finish_reason_by_index
                    .insert(*index, finish_reason.clone());
            }
            OpenAiStreamEvent::Usage { usage } => {
                self.usage = Some(*usage);
            }
            OpenAiStreamEvent::Receipt { receipt } => {
                self.receipt = Some(receipt.clone());
            }
            OpenAiStreamEvent::Done => {
                self.done = true;
            }
            OpenAiStreamEvent::Error { .. } | OpenAiStreamEvent::Unknown { .. } => {}
        }
    }

    pub fn snapshot(&self) -> ChatCompletionsStreamSnapshot {
        let tool_calls_by_choice = self
            .tool_calls_by_index
            .iter()
            .map(|(index, by_index)| (*index, by_index.values().cloned().collect()))
            .collect();
        ChatCompletionsStreamSnapshot {
            role: self.role.clone(),
            content_by_choice: self.content_by_index.clone(),
            tool_calls_by_choice,
            finish_reason_by_choice: self.finish_reason_by_index.clone(),
            usage: self.usage,
            receipt: self.receipt.clone(),
            completed: self.done,
        }
    }
}
