/**
 * OpenAI `chat.completions` streaming event types (ADR-0024a §D5): role,
 * content delta, tool-call fragments, finish reason, trailing usage, the
 * Cognitum receipt, a terminal wire-level error event, and the `[DONE]`
 * sentinel. Any recognized-but-not-decoded shape falls back to
 * {@link UnknownStreamEvent} rather than throwing.
 *
 * The receipt facet (`OpenAiReceiptEvent`) now carries the concrete
 * ADR-0024b §D3 `MetaLlmReceipt` shape (issue #59, D11 migration step 1)
 * rather than the earlier generic ADR-0028 `ExecutionReceipt` stub — this
 * is the "receipt field ... already anticipated" slot the streaming pass
 * (PR #88) reserved for it.
 *
 * One raw SSE `data:` payload can decode into *multiple* facets (e.g. one
 * chunk carrying both a content delta and, on the last chunk, a finish
 * reason) — {@link decodeOpenAiSseEvent} returns all of them, each
 * becoming its own {@link import("./envelope.js").MetaLlmStreamEnvelope}
 * with its own sequence number, preserving per-facet granularity rather
 * than flattening a chunk into one opaque event.
 */

import type { SseEvent } from "../../sse/parser.js";
import type { ChatCompletionUsage } from "../types/openai.js";
import { parseMetaLlmReceipt, type MetaLlmReceipt } from "../types/receipt.js";

export interface OpenAiRoleEvent {
  type: "role";
  index: number;
  role: string;
}

export interface OpenAiContentDeltaEvent {
  type: "content_delta";
  index: number;
  delta: string;
}

export interface OpenAiToolCallDeltaEvent {
  type: "tool_call_delta";
  index: number;
  toolCallIndex: number;
  id?: string;
  functionName?: string;
  argumentsDelta?: string;
}

export interface OpenAiFinishReasonEvent {
  type: "finish_reason";
  index: number;
  finishReason: string;
}

export interface OpenAiUsageEvent {
  type: "usage";
  usage: ChatCompletionUsage;
}

export interface OpenAiReceiptEvent {
  type: "receipt";
  receipt: MetaLlmReceipt;
}

export interface OpenAiStreamErrorPayload {
  message: string;
  type?: string;
  code?: string;
  param?: string;
}

/** A wire-level terminal error event embedded in the SSE stream itself (`data: {"error": {...}}`). */
export interface OpenAiStreamErrorEvent {
  type: "error";
  error: OpenAiStreamErrorPayload;
}

/** The literal `data: [DONE]` sentinel that closes a successful OpenAI chat-completions stream. */
export interface OpenAiDoneEvent {
  type: "done";
}

/** A syntactically valid SSE event whose payload this decoder does not recognize. Never a crash. */
export interface UnknownStreamEvent {
  type: "unknown";
  raw: unknown;
}

export type OpenAiStreamEvent =
  | OpenAiRoleEvent
  | OpenAiContentDeltaEvent
  | OpenAiToolCallDeltaEvent
  | OpenAiFinishReasonEvent
  | OpenAiUsageEvent
  | OpenAiReceiptEvent
  | OpenAiStreamErrorEvent
  | OpenAiDoneEvent
  | UnknownStreamEvent;

/** Top-level JSON keys this decoder understands; everything else is preserved as `unknownFields`. */
const KNOWN_TOP_LEVEL_KEYS = new Set([
  "id",
  "object",
  "created",
  "model",
  "choices",
  "usage",
  "cognitum_receipt",
  "system_fingerprint",
  "error",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface DecodedOpenAiSseEvent {
  events: OpenAiStreamEvent[];
  unknownFields?: Record<string, unknown>;
}

/**
 * Decode one generic {@link SseEvent} into zero or more {@link OpenAiStreamEvent}s.
 * Never throws — malformed JSON or an unrecognized shape becomes an
 * {@link UnknownStreamEvent} (ADR-0024a §D5: "Unknown valid events become
 * `UnknownStreamEvent`").
 */
export function decodeOpenAiSseEvent(raw: SseEvent): DecodedOpenAiSseEvent {
  const trimmed = raw.data.trim();
  if (trimmed === "[DONE]") {
    return { events: [{ type: "done" }] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.data);
  } catch {
    return { events: [{ type: "unknown", raw: raw.data }] };
  }
  if (!isRecord(parsed)) {
    return { events: [{ type: "unknown", raw: parsed }] };
  }

  const events: OpenAiStreamEvent[] = [];

  if (isRecord(parsed.error)) {
    const e = parsed.error;
    events.push({
      type: "error",
      error: {
        message: typeof e.message === "string" ? e.message : "unknown error",
        type: typeof e.type === "string" ? e.type : undefined,
        code: typeof e.code === "string" ? e.code : undefined,
        param: typeof e.param === "string" ? e.param : undefined,
      },
    });
  }

  if (Array.isArray(parsed.choices)) {
    for (const choiceRaw of parsed.choices) {
      if (!isRecord(choiceRaw)) continue;
      const index = typeof choiceRaw.index === "number" ? choiceRaw.index : 0;
      const delta = isRecord(choiceRaw.delta) ? choiceRaw.delta : {};

      if (typeof delta.role === "string") {
        events.push({ type: "role", index, role: delta.role });
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        events.push({ type: "content_delta", index, delta: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const toolCallRaw of delta.tool_calls) {
          if (!isRecord(toolCallRaw)) continue;
          const fn = isRecord(toolCallRaw.function) ? toolCallRaw.function : {};
          events.push({
            type: "tool_call_delta",
            index,
            toolCallIndex: typeof toolCallRaw.index === "number" ? toolCallRaw.index : 0,
            id: typeof toolCallRaw.id === "string" ? toolCallRaw.id : undefined,
            functionName: typeof fn.name === "string" ? fn.name : undefined,
            argumentsDelta: typeof fn.arguments === "string" ? fn.arguments : undefined,
          });
        }
      }
      if (typeof choiceRaw.finish_reason === "string") {
        events.push({ type: "finish_reason", index, finishReason: choiceRaw.finish_reason });
      }
    }
  }

  if (isRecord(parsed.usage)) {
    const u = parsed.usage;
    events.push({
      type: "usage",
      usage: {
        promptTokens: Number(u.prompt_tokens ?? 0),
        completionTokens: Number(u.completion_tokens ?? 0),
        totalTokens: Number(u.total_tokens ?? 0),
      },
    });
  }

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
