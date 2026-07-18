/**
 * Meta LLM serving client (ADR-0024a). Product namespace per ADR-0019 §D2:
 * `@cognitum-one/sdk/meta-llm`.
 *
 * Issue #58 / M2 start: `MetaLlmClient` construction, wire types, and
 * real `health()` / `whoami()` / `models()` implementations. Streaming
 * (§D5), the five protocol operations' HTTP logic, and ADR-0024b routing
 * controls are deliberately out of scope — see follow-up issues.
 *
 * Per ADR-0019 §D4, this module depends on `../agentic/index.js` and MUST
 * NOT be imported by any other product module (`meta-proxy`, `metaharness`,
 * `harnessaas`).
 */

export type {
  MetaLlmClientConfig,
  MetaLlmRoutingControls,
  MetaLlmSafetyControl,
  MetaLlmTelemetryEvent,
  MetaLlmTelemetryHooks,
  MetaLlmTransport,
  ResolvedMetaLlmClientConfig,
} from "./config.js";
export { resolveMetaLlmClientConfig } from "./config.js";

export type { MetaLlmReceipt, MetaLlmResponseMeta, MetaLlmResult } from "./envelope.js";

export type { MetaLlmHealth, MetaLlmModelInfo, MetaLlmModelList, MetaLlmWhoAmI } from "./discovery.js";

export type {
  ChatCompletion,
  ChatCompletionChoice,
  ChatCompletionRequest,
  ChatCompletionUsage,
  ChatContentPart,
  ChatMessage,
  ChatToolCall,
  ChatToolChoice,
  ChatToolDefinition,
  EmbeddingDatum,
  EmbeddingRequest,
  EmbeddingResponse,
  EmbeddingUsage,
  LegacyCompletion,
  LegacyCompletionChoice,
  LegacyCompletionRequest,
  ResponsesOutputItem,
  ResponsesRequest,
  ResponsesResponse,
} from "./types/openai.js";

export type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessageParam,
  AnthropicMessageRequest,
  AnthropicToolChoice,
  AnthropicToolDefinition,
  AnthropicUsage,
  CountTokensRequest,
  CountTokensResult,
} from "./types/anthropic.js";

// ADR-0024b D11 migration step 1 (issue #59): routing controls, money,
// receipt, and usage/budget types.
export type {
  CacheMode,
  EscalationStrategy,
  FallbackPolicy,
  ModelSelector,
  ModelTier,
  SafetyMode,
  SubTenantAttribution,
} from "./types/routing.js";
export { assertSendableRoutingControls, UnsendableRoutingControlsError } from "./types/routing.js";

export type { Money } from "./types/money.js";
export { parseMoney } from "./types/money.js";

export type { ReceiptCacheResult, ReceiptModelTier, SafetySummary } from "./types/receipt.js";
export { parseMetaLlmReceipt } from "./types/receipt.js";

export type {
  BudgetView,
  CacheStats,
  UsageBreakdownEntry,
  UsagePeriodEntry,
  UsageQuery,
  UsageSummary,
  UsageTotals,
} from "./types/usage.js";
export { assertValidUsageQuery, InvalidUsageQueryError, parseUsageSummary } from "./types/usage.js";

export type { MetaLlmCallOptions } from "./client.js";
export { MetaLlmClient } from "./client.js";

export type { MetaLlmStreamEnvelope } from "./stream/envelope.js";
export { ChatCompletionsStreamAccumulator } from "./stream/envelope.js";

export type {
  DecodedOpenAiSseEvent,
  OpenAiContentDeltaEvent,
  OpenAiDoneEvent,
  OpenAiFinishReasonEvent,
  OpenAiReceiptEvent,
  OpenAiRoleEvent,
  OpenAiStreamErrorEvent,
  OpenAiStreamErrorPayload,
  OpenAiStreamEvent,
  OpenAiToolCallDeltaEvent,
  OpenAiUsageEvent,
  UnknownStreamEvent,
} from "./stream/openai-events.js";
export { decodeOpenAiSseEvent } from "./stream/openai-events.js";
