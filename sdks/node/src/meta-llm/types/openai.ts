/**
 * OpenAI-style wire types (ADR-0024a §D3): chat completions, legacy
 * completions, Responses, and embeddings. Request/response shapes only —
 * no HTTP call logic lands in this pass (issue #58 / M2 scope).
 *
 * The SDK does not invent a universal prompt object (ADR-0024a §D3):
 * content blocks, tools, tool choices, finish reasons, and usage stay in
 * this native OpenAI-compatible namespace rather than a cross-protocol
 * shared shape.
 *
 * Field names here are idiomatic camelCase (this SDK's convention), not the
 * wire's snake_case (`max_tokens`, `top_p`, ...). The follow-up issue that
 * implements the actual HTTP call logic for these operations owns the
 * snake_case <-> camelCase mapping; no such mapping exists yet since this
 * pass ships types only.
 *
 * `routingControls` (ADR-0024b §D2, issue #59) is added to
 * `ChatCompletionRequest`, `LegacyCompletionRequest`, and `ResponsesRequest`
 * — the same three protocol request shapes ADR-0024b's issue names,
 * alongside `AnthropicMessageRequest` in `./anthropic.ts`. `EmbeddingRequest`
 * deliberately does NOT get this field: it is out of ADR-0024b D11 step 1's
 * scope.
 */

import type { MetaLlmRoutingControls } from "./routing.js";

/** A single chat message. Content may be plain text or a multi-part array. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer";
  content: string | ChatContentPart[] | null;
  name?: string;
  toolCallId?: string;
  toolCalls?: ChatToolCall[];
}

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; imageUrl: { url: string; detail?: "auto" | "low" | "high" } };

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type ChatToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

/** `POST /v1/chat/completions` request. Server currently caps `n = 1`. */
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /** Server-enforced maximum of 1 (ADR-0024a §D3). */
  n?: 1;
  stream?: boolean;
  stop?: string | string[];
  presencePenalty?: number;
  frequencyPenalty?: number;
  logitBias?: Record<string, number>;
  user?: string;
  tools?: ChatToolDefinition[];
  toolChoice?: ChatToolChoice;
  responseFormat?: { type: "text" | "json_object" };
  seed?: number;
  /** ADR-0024b §D2. Body controls win over any `X-Cognitum-*` header. */
  routingControls?: MetaLlmRoutingControls;
}

export interface ChatCompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  logprobs?: unknown;
}

/** `POST /v1/chat/completions` response. */
export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
  systemFingerprint?: string;
}

/** `POST /v1/completions` (legacy) request. */
export interface LegacyCompletionRequest {
  model: string;
  prompt: string | string[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  n?: 1;
  stream?: boolean;
  logprobs?: number;
  echo?: boolean;
  stop?: string | string[];
  presencePenalty?: number;
  frequencyPenalty?: number;
  bestOf?: number;
  logitBias?: Record<string, number>;
  user?: string;
  /** ADR-0024b §D2. Body controls win over any `X-Cognitum-*` header. */
  routingControls?: MetaLlmRoutingControls;
}

export interface LegacyCompletionChoice {
  text: string;
  index: number;
  logprobs?: unknown;
  finishReason: "stop" | "length" | "content_filter" | null;
}

/** `POST /v1/completions` (legacy) response. */
export interface LegacyCompletion {
  id: string;
  object: "text_completion";
  created: number;
  model: string;
  choices: LegacyCompletionChoice[];
  usage?: ChatCompletionUsage;
}

/** Discriminated Responses output item. Kept intentionally partial pending GA. */
export type ResponsesOutputItem =
  | { type: "message"; id: string; role: "assistant"; content: ChatContentPart[] }
  | { type: "reasoning"; id: string; summary?: string[] }
  | { type: "tool_call"; id: string; name: string; arguments: string };

/**
 * `POST /v1/responses` request. Current server is stateless: callers resend
 * conversation input. `previousResponseId` is preview and MUST NOT be
 * described as recovery (ADR-0024a §D3).
 */
export interface ResponsesRequest {
  model: string;
  input: string | ChatContentPart[];
  instructions?: string;
  /** Preview-only; server does not restore conversation state (ADR-0024a §D3). */
  previousResponseId?: string;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stream?: boolean;
  tools?: ChatToolDefinition[];
  toolChoice?: ChatToolChoice;
  metadata?: Record<string, string>;
  /** ADR-0024b §D2. Body controls win over any `X-Cognitum-*` header. */
  routingControls?: MetaLlmRoutingControls;
}

/** `POST /v1/responses` response. */
export interface ResponsesResponse {
  id: string;
  object: "response";
  createdAt: number;
  model: string;
  status: "completed" | "in_progress" | "failed" | "incomplete";
  output: ResponsesOutputItem[];
  usage?: ChatCompletionUsage;
  previousResponseId?: string;
  incompleteDetails?: { reason: string };
}

/** `POST /v1/embeddings` request. */
export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  encodingFormat?: "float" | "base64";
  dimensions?: number;
  user?: string;
}

export interface EmbeddingDatum {
  object: "embedding";
  embedding: number[];
  index: number;
}

export interface EmbeddingUsage {
  promptTokens: number;
  totalTokens: number;
}

/** `POST /v1/embeddings` response. */
export interface EmbeddingResponse {
  object: "list";
  data: EmbeddingDatum[];
  model: string;
  usage: EmbeddingUsage;
}
