/**
 * Anthropic `messages` streaming event types (ADR-0024a §D5, issue #58 M2
 * continuation — item 2 of the tracked "what's left" list). Mirrors
 * `./openai-events.ts`'s decode discipline exactly, but for the Anthropic
 * Messages wire protocol: `message_start`, `content_block_start`,
 * `content_block_delta`, `content_block_stop`, `message_delta`,
 * `message_stop`, `ping`, and a wire-level `error` event. Any recognized
 * SSE frame whose payload shape this decoder does not understand falls
 * back to {@link UnknownStreamEvent} rather than throwing — same contract
 * as the OpenAI decoder.
 *
 * Unlike OpenAI chat-completions chunks (which carry no `event:` field and
 * pack multiple facets into one JSON object), Anthropic's wire sets a real
 * SSE `event:` name that duplicates the JSON payload's own `"type"` field
 * (ADR-0024a §D5 ground truth). This decoder switches on the JSON
 * payload's `"type"` (not `raw.event`) so a mismatched/missing `event:`
 * field never hides a well-formed payload — the JSON body is authoritative,
 * exactly as it is for the OpenAI decoder's `choices[].delta` shape.
 *
 * `ping` is modeled as its own recognized variant (`AnthropicPingEvent`),
 * NOT `unknown` — it carries no payload but is a real, expected keepalive
 * frame, not a decode failure.
 *
 * The Cognitum receipt facet (`cognitum_receipt`) is decoded from whichever
 * event payload carries it, same top-level-key check as
 * `decodeOpenAiSseEvent` — ADR-0024a treats the receipt facet as
 * protocol-uniform, not chat-completions-specific.
 */

import type { SseEvent } from "../../sse/parser.js";
import { parseMetaLlmReceipt, type MetaLlmReceipt } from "../types/receipt.js";
import type { AnthropicContentBlock, AnthropicUsage } from "../types/anthropic.js";

/** The `message` object embedded in a `message_start` event — a message whose content/usage are still being filled in. */
export interface AnthropicStreamMessageStart {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stopReason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stopSequence?: string | null;
  usage: AnthropicUsage;
}

export interface AnthropicMessageStartEvent {
  type: "message_start";
  message: AnthropicStreamMessageStart;
}

/** The content block a `content_block_start` event opens at `index` — fields fill in via subsequent `content_block_delta`s. */
export type AnthropicStreamContentBlockStart =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export interface AnthropicContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  contentBlock: AnthropicStreamContentBlockStart;
}

export type AnthropicContentBlockDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partialJson: string };

export interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: AnthropicContentBlockDelta;
}

export interface AnthropicContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

export interface AnthropicMessageDeltaPayload {
  stopReason: string | null;
  stopSequence?: string | null;
}

/** `message_delta`'s trailing `usage` only ever carries `output_tokens` (ADR-0024a §D5 ground truth). */
export interface AnthropicMessageDeltaUsage {
  outputTokens: number;
}

export interface AnthropicMessageDeltaEvent {
  type: "message_delta";
  delta: AnthropicMessageDeltaPayload;
  usage?: AnthropicMessageDeltaUsage;
}

/** The wire terminal condition for a successful Anthropic Messages stream — there is no `[DONE]` sentinel. */
export interface AnthropicMessageStopEvent {
  type: "message_stop";
}

/** Keepalive heartbeat. Carries no payload; recognized deliberately rather than falling back to `unknown`. */
export interface AnthropicPingEvent {
  type: "ping";
}

export interface AnthropicStreamErrorPayload {
  type: string;
  message: string;
}

/** A wire-level terminal error event embedded in the SSE stream itself (`data: {"type":"error","error":{...}}`). */
export interface AnthropicStreamErrorEvent {
  type: "error";
  error: AnthropicStreamErrorPayload;
}

export interface AnthropicReceiptEvent {
  type: "receipt";
  receipt: MetaLlmReceipt;
}

/** A syntactically valid SSE event whose payload this decoder does not recognize. Never a crash. */
export interface UnknownStreamEvent {
  type: "unknown";
  raw: unknown;
}

export type AnthropicStreamEvent =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | AnthropicStreamErrorEvent
  | AnthropicReceiptEvent
  | UnknownStreamEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeContentBlock(raw: unknown): AnthropicStreamContentBlockStart | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.type === "text") {
    return { type: "text", text: typeof raw.text === "string" ? raw.text : "" };
  }
  if (raw.type === "tool_use") {
    return {
      type: "tool_use",
      id: typeof raw.id === "string" ? raw.id : "",
      name: typeof raw.name === "string" ? raw.name : "",
      input: isRecord(raw.input) ? raw.input : {},
    };
  }
  return undefined;
}

function decodeMessageStart(raw: unknown): AnthropicStreamMessageStart | undefined {
  if (!isRecord(raw)) return undefined;
  const usageRaw = isRecord(raw.usage) ? raw.usage : {};
  const stopReasonRaw = raw.stop_reason ?? raw.stopReason;
  const stopSequenceRaw = raw.stop_sequence ?? raw.stopSequence;
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    type: "message",
    role: "assistant",
    content: Array.isArray(raw.content) ? raw.content.map(decodeContentBlockAsMessageBlock).filter((c): c is AnthropicContentBlock => c !== undefined) : [],
    model: typeof raw.model === "string" ? raw.model : "",
    stopReason:
      typeof stopReasonRaw === "string"
        ? (stopReasonRaw as AnthropicStreamMessageStart["stopReason"])
        : null,
    stopSequence: typeof stopSequenceRaw === "string" ? stopSequenceRaw : undefined,
    usage: {
      inputTokens: Number((usageRaw as Record<string, unknown>).input_tokens ?? 0),
      outputTokens: Number((usageRaw as Record<string, unknown>).output_tokens ?? 0),
    },
  };
}

/** A `message_start.message.content` entry decodes with the same shapes `AnthropicContentBlock` recognizes; unrecognized entries are dropped rather than throwing. */
function decodeContentBlockAsMessageBlock(raw: unknown): AnthropicContentBlock | undefined {
  const block = decodeContentBlock(raw);
  if (!block) return undefined;
  return block;
}

function decodeDelta(raw: unknown): AnthropicContentBlockDelta | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.type === "text_delta") {
    return { type: "text_delta", text: typeof raw.text === "string" ? raw.text : "" };
  }
  if (raw.type === "input_json_delta") {
    const partialJsonRaw = raw.partial_json ?? raw.partialJson;
    return { type: "input_json_delta", partialJson: typeof partialJsonRaw === "string" ? partialJsonRaw : "" };
  }
  return undefined;
}

export interface DecodedAnthropicSseEvent {
  events: AnthropicStreamEvent[];
  unknownFields?: Record<string, unknown>;
}

/** Top-level JSON keys this decoder understands per event `type`; everything else is preserved as `unknownFields`. */
const KNOWN_TOP_LEVEL_KEYS = new Set([
  "type",
  "message",
  "index",
  "content_block",
  "delta",
  "usage",
  "error",
  "cognitum_receipt",
]);

/**
 * Decode one generic {@link SseEvent} into zero or more
 * {@link AnthropicStreamEvent}s. Never throws — malformed JSON or an
 * unrecognized shape becomes an {@link UnknownStreamEvent} (same contract
 * as {@link import("./openai-events.js").decodeOpenAiSseEvent}).
 */
export function decodeAnthropicSseEvent(raw: SseEvent): DecodedAnthropicSseEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.data);
  } catch {
    return { events: [{ type: "unknown", raw: raw.data }] };
  }
  if (!isRecord(parsed)) {
    return { events: [{ type: "unknown", raw: parsed }] };
  }

  const events: AnthropicStreamEvent[] = [];
  const type = typeof parsed.type === "string" ? parsed.type : raw.event;

  switch (type) {
    case "message_start": {
      const message = decodeMessageStart(parsed.message);
      if (message) events.push({ type: "message_start", message });
      break;
    }
    case "content_block_start": {
      const contentBlock = decodeContentBlock(parsed.content_block);
      if (contentBlock) {
        events.push({
          type: "content_block_start",
          index: typeof parsed.index === "number" ? parsed.index : 0,
          contentBlock,
        });
      }
      break;
    }
    case "content_block_delta": {
      const delta = decodeDelta(parsed.delta);
      if (delta) {
        events.push({
          type: "content_block_delta",
          index: typeof parsed.index === "number" ? parsed.index : 0,
          delta,
        });
      }
      break;
    }
    case "content_block_stop":
      events.push({ type: "content_block_stop", index: typeof parsed.index === "number" ? parsed.index : 0 });
      break;
    case "message_delta": {
      const deltaRaw = isRecord(parsed.delta) ? parsed.delta : {};
      const stopReasonRaw = deltaRaw.stop_reason ?? deltaRaw.stopReason;
      const stopSequenceRaw = deltaRaw.stop_sequence ?? deltaRaw.stopSequence;
      const usageRaw = isRecord(parsed.usage) ? parsed.usage : undefined;
      events.push({
        type: "message_delta",
        delta: {
          stopReason: typeof stopReasonRaw === "string" ? stopReasonRaw : null,
          stopSequence: typeof stopSequenceRaw === "string" ? stopSequenceRaw : undefined,
        },
        usage: usageRaw
          ? { outputTokens: Number(usageRaw.output_tokens ?? usageRaw.outputTokens ?? 0) }
          : undefined,
      });
      break;
    }
    case "message_stop":
      events.push({ type: "message_stop" });
      break;
    case "ping":
      events.push({ type: "ping" });
      break;
    case "error": {
      const errorRaw = isRecord(parsed.error) ? parsed.error : {};
      events.push({
        type: "error",
        error: {
          type: typeof errorRaw.type === "string" ? errorRaw.type : "unknown_error",
          message: typeof errorRaw.message === "string" ? errorRaw.message : "unknown error",
        },
      });
      break;
    }
    default:
      break;
  }

  // ADR-0024a: the Cognitum receipt facet is protocol-uniform — decode it
  // from whichever event payload carries the top-level key, same as the
  // OpenAI decoder, regardless of which `type` this event otherwise was.
  if (parsed.cognitum_receipt !== undefined) {
    const receipt = parseMetaLlmReceipt(parsed.cognitum_receipt);
    if (receipt) events.push({ type: "receipt", receipt });
  }

  if (events.length === 0) {
    events.push({ type: "unknown", raw: parsed });
  }

  const unknownFields: Record<string, unknown> = {};
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) unknownFields[key] = parsed[key];
  }

  return { events, unknownFields: Object.keys(unknownFields).length > 0 ? unknownFields : undefined };
}
