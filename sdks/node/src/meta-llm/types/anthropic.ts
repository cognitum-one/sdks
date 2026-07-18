/**
 * Anthropic-style wire types (ADR-0024a §D3): Messages and count-tokens.
 * Request/response shapes only — no HTTP call logic lands in this pass
 * (issue #58 / M2 scope).
 *
 * Image and document content blocks are modeled for forward compatibility,
 * but the audited server currently rejects them (ADR-0024a Context table) —
 * callers MUST NOT assume they are accepted yet.
 *
 * Field names here are idiomatic camelCase; the wire uses snake_case
 * (`max_tokens`, `stop_sequences`, ...). See `./openai.ts` for the same
 * mapping note — the follow-up HTTP-logic issue owns the conversion.
 *
 * `routingControls` (ADR-0024b §D2, issue #59) is added to
 * `AnthropicMessageRequest` — see `./openai.ts`'s module doc for the full
 * list of the four request shapes this field lands on.
 */

import type { MetaLlmRoutingControls } from "./routing.js";

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      toolUseId: string;
      content?: string | AnthropicContentBlock[];
      isError?: boolean;
    }
  | {
      // Modeled for forward compatibility only — currently rejected server-side.
      type: "image";
      source: { type: "base64"; mediaType: string; data: string };
    };

export interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string };

/** `POST /v1/messages` request. `maxTokens` is required by the Anthropic wire shape. */
export interface AnthropicMessageRequest {
  model: string;
  messages: AnthropicMessageParam[];
  maxTokens: number;
  system?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  stream?: boolean;
  tools?: AnthropicToolDefinition[];
  toolChoice?: AnthropicToolChoice;
  metadata?: { userId?: string };
  /** ADR-0024b §D2. Body controls win over any `X-Cognitum-*` header. */
  routingControls?: MetaLlmRoutingControls;
}

export interface AnthropicUsage {
  inputTokens: number;
  outputTokens: number;
}

/** `POST /v1/messages` response. */
export interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stopReason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stopSequence?: string | null;
  usage: AnthropicUsage;
}

/**
 * `POST /v1/messages/count_tokens` request. Mirrors the message-creation
 * shape minus generation parameters (ADR-0024a §D3 Context table).
 */
export interface CountTokensRequest {
  model: string;
  messages: AnthropicMessageParam[];
  system?: string;
  tools?: AnthropicToolDefinition[];
}

/** `POST /v1/messages/count_tokens` response. */
export interface CountTokensResult {
  inputTokens: number;
}
