/**
 * MetaLlmClient (ADR-0024a). Issue #58 / M2.
 *
 * M2 start (PR #85):
 *  - real, HTTP-backed `health()`, `whoami()`, and `models()` — the
 *    "Stable-track, simplest" group per §D2's maturity table;
 *  - `capabilities()` from the static compatibility snapshot (no I/O — no
 *    runtime capabilities endpoint is published yet, §D9 gate #3);
 *  - fails closed on `ready(feature)` (dependency readiness is only
 *    published "when published", §D1 — nothing is published yet).
 *
 * M2 continuation (PR #86): real HTTP call logic for `chat.completions`
 * and `messages.create` — idempotency-key generation, bounded 429/502/503
 * retry, and a single 401-refresh (`./nonstream.js`).
 *
 * This pass (issue #58 / M2 continuation): the same real HTTP call logic
 * for the remaining direct nonstream operations named in ADR-0024a §D7 —
 * `completions` (legacy OpenAI completions), `responses`, `embeddings`,
 * and `messages.countTokens` — reusing `./nonstream.js`'s
 * `postJsonIdempotent` verbatim rather than a per-operation reimplementation.
 *
 * ADR-0024b D11 migration step 1 (issue #59): `MetaLlmRoutingControls` is
 * now the concrete §D2 shape and lands as an optional field on
 * `chat.completions`/`messages.create`/`completions`/`responses` requests
 * (see `./types/openai.js`/`./types/anthropic.js`); `client.usage()` is the
 * new read-only, authenticated-account-scoped §D3 endpoint; and every
 * nonstream/stream response now decodes a `MetaLlmReceipt` when the server
 * includes one. Explicitly still out of scope: batches, pods, bench,
 * webhooks, guidance, collaboration, evolution, MicroLoRA, flywheel,
 * genome, brain, vectors, and conditional hosts (§D5-§D8) — separate
 * future issues per §D11 steps 2-4.
 */

import {
  AgenticError,
  assertScopeGranted,
  type CapabilitySet,
  type Credential,
  type CredentialProvider,
  type RequestContext,
} from "../agentic/index.js";
import {
  resolveMetaLlmClientConfig,
  type MetaLlmClientConfig,
  type MetaLlmRoutingControls,
  type MetaLlmSafetyControl,
  type ResolvedMetaLlmClientConfig,
} from "./config.js";
import type { MetaLlmHealth, MetaLlmModelList, MetaLlmWhoAmI } from "./discovery.js";
import type { MetaLlmResult, MetaLlmResponseMeta } from "./envelope.js";
import { mapMetaLlmHttpError } from "./http-errors.js";
import { postJsonIdempotent, type NonstreamDeps } from "./nonstream.js";
import type { AnthropicStreamEvent } from "./stream/anthropic-events.js";
import { chatCompletionsStreamImpl } from "./stream/chat-completions-stream.js";
import type { MetaLlmStreamEnvelope } from "./stream/envelope.js";
import { messagesCreateStreamImpl } from "./stream/messages-stream.js";
import type { OpenAiStreamEvent } from "./stream/openai-events.js";
import type {
  AnthropicMessage,
  AnthropicMessageRequest,
  CountTokensRequest,
  CountTokensResult,
} from "./types/anthropic.js";
import type {
  ChatCompletion,
  ChatCompletionRequest,
  EmbeddingRequest,
  EmbeddingResponse,
  LegacyCompletion,
  LegacyCompletionRequest,
  ResponsesRequest,
  ResponsesResponse,
} from "./types/openai.js";
import { assertValidUsageQuery, parseUsageSummary, type UsageQuery, type UsageSummary } from "./types/usage.js";

const DEFAULT_CAPABILITY_VERSION = "0.0.0";
const PRODUCT = "meta-llm";

/** Options accepted by every operation method. */
export interface MetaLlmCallOptions {
  requestContext?: Partial<RequestContext>;
  routingControls?: MetaLlmRoutingControls;
  safetyControl?: MetaLlmSafetyControl;
}

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Serving-protocol client for Meta LLM (ADR-0024a). Construction performs no
 * I/O (ADR-0024a §D1, ADR-0019 §D3).
 */
export class MetaLlmClient {
  private readonly config: ResolvedMetaLlmClientConfig;

  constructor(config: MetaLlmClientConfig) {
    this.config = resolveMetaLlmClientConfig(config);
  }

  // ---------------------------------------------------------------------
  // D2: health, models, whoami, capabilities, ready — implemented this pass
  // ---------------------------------------------------------------------

  /** Process-level health only — never identity or readiness (ADR-0024a §D1). */
  async health(options?: MetaLlmCallOptions): Promise<MetaLlmResult<MetaLlmHealth>> {
    return this.getJson<MetaLlmHealth>("/v1/health", "health", options, {
      requireCredential: false,
    });
  }

  /** `/v1/models`. May not list every alias the resolver accepts (ADR-0024a Context). */
  async models(options?: MetaLlmCallOptions): Promise<MetaLlmResult<MetaLlmModelList>> {
    return this.getJson<MetaLlmModelList>("/v1/models", "models", options, {
      requireCredential: true,
    });
  }

  /** Authenticated account and credential type only (ADR-0024a §D1). */
  async whoami(options?: MetaLlmCallOptions): Promise<MetaLlmResult<MetaLlmWhoAmI>> {
    return this.getJson<MetaLlmWhoAmI>("/v1/whoami", "whoami", options, {
      requireCredential: true,
    });
  }

  /**
   * `GET /v1/usage` (ADR-0024b §D1's `client.usage`, D11 migration step 1).
   * Strictly authenticated-account scoped — every query is bound to the
   * caller's own credential; there is no parameter that can select another
   * account's usage. Uses the contract's bounded `YYYY-MM` range plus
   * optional `model`/`provider`/`groupBy` grouping (§D3). An empty result
   * is returned exactly as reported — never reinterpreted as "no usage
   * anywhere" vs. "this account genuinely has none" (§D3: no speculative
   * fallback logic is layered on top).
   */
  async usage(
    query: UsageQuery,
    options?: MetaLlmCallOptions,
  ): Promise<MetaLlmResult<UsageSummary>> {
    try {
      assertValidUsageQuery(query);
    } catch (cause) {
      throw new AgenticError("validation", `usage query rejected: ${(cause as Error).message}`, {
        product: PRODUCT,
        operation: "usage",
        retryable: false,
        cause,
      });
    }
    const params = new URLSearchParams({ from: query.from, to: query.to });
    if (query.model) params.set("model", query.model);
    if (query.provider) params.set("provider", query.provider);
    if (query.groupBy) params.set("group_by", query.groupBy);

    const { data, meta } = await this.getJson<unknown>(`/v1/usage?${params.toString()}`, "usage", options, {
      requireCredential: true,
    });
    return { data: parseUsageSummary(data), meta };
  }

  /**
   * Versioned behavior safe for this caller, from the static compatibility
   * snapshot (no I/O — ADR-0024a §D9 gate #3 is not yet published). Unknown
   * server versions receive the intersection of proven-safe capabilities,
   * never the union (ADR-0019 §D6).
   */
  capabilities(): CapabilitySet {
    return (
      this.config.capabilitiesSnapshot ?? {
        product: PRODUCT,
        productVersion: DEFAULT_CAPABILITY_VERSION,
        protocol: "cognitum.meta-llm.http",
        protocolVersion: "1.0",
        features: {},
        limitations: ["no capabilities_snapshot configured"],
        authMethods: [],
        source: "static-compatibility-table",
      }
    );
  }

  /**
   * Dependency readiness for a named feature. Fails closed: no readiness
   * endpoint is published yet (ADR-0024a §D1: "when published").
   */
  async ready(feature: string): Promise<never> {
    throw new AgenticError(
      "unsupported_capability",
      `ready("${feature}") is unsupported: no readiness endpoint is published for meta-llm yet`,
      { product: PRODUCT, operation: "ready", retryable: false },
    );
  }

  // ---------------------------------------------------------------------
  // D3: protocol-specific wire types only this pass — placeholders below
  // ---------------------------------------------------------------------

  readonly chat = {
    /**
     * `POST /v1/chat/completions` (OpenAI-style). Real HTTP call logic
     * (issue #58 / M2 continuation): idempotency-key generation, bounded
     * 429/502/503 retry, and a single 401-refresh — see `./nonstream.js`.
     * Streaming (`request.stream = true`) is not validated against here —
     * this pass only implements the nonstream path (§D5 is a follow-up
     * issue).
     */
    completions: (
      request: ChatCompletionRequest,
      options?: MetaLlmCallOptions,
    ): Promise<MetaLlmResult<ChatCompletion>> =>
      postJsonIdempotent<ChatCompletion>(
        this.nonstreamDeps(options),
        "/v1/chat/completions",
        "chat.completions",
        request,
      ),

    /**
     * `POST /v1/chat/completions` with `stream: true` (ADR-0024a §D5).
     * Issue #58 / M2 continuation — the first protocol wired onto the
     * generic SSE parser (`../sse/parser.js`); Anthropic Messages and
     * Responses streaming are deferred follow-ups that reuse the same
     * parser. Returns an async generator — iterate with `for await`; it
     * completes normally only after the OpenAI wire terminal condition
     * (`[DONE]` or a `finish_reason`) is observed, otherwise it throws a
     * typed `AgenticError` describing why (see `./stream/chat-completions-stream.js`).
     */
    completionsStream: (
      request: ChatCompletionRequest,
      options?: MetaLlmCallOptions,
    ): AsyncGenerator<MetaLlmStreamEnvelope<OpenAiStreamEvent>, void, void> =>
      chatCompletionsStreamImpl(this.nonstreamDeps(options), request, options?.requestContext),
  };

  /**
   * `POST /v1/completions` (legacy OpenAI completions). Real HTTP call
   * logic (issue #58 / M2 continuation) — this is a "direct nonstream
   * call whose accepted contract declares safe replay" per ADR-0024a §D7,
   * the same class as `chat.completions`/`messages.create`, so it reuses
   * `postJsonIdempotent` from `./nonstream.js` verbatim (idempotency-key
   * generation, bounded 429/502/503 retry, single 401-refresh).
   */
  completions(
    request: LegacyCompletionRequest,
    options?: MetaLlmCallOptions,
  ): Promise<MetaLlmResult<LegacyCompletion>> {
    return postJsonIdempotent<LegacyCompletion>(
      this.nonstreamDeps(options),
      "/v1/completions",
      "completions",
      request,
    );
  }

  readonly messages = {
    /**
     * `POST /v1/messages` (Anthropic-style). Real HTTP call logic (issue
     * #58 / M2 continuation) — see `chat.completions`'s doc comment and
     * `./nonstream.js` for the shared idempotency/retry logic.
     */
    create: (
      request: AnthropicMessageRequest,
      options?: MetaLlmCallOptions,
    ): Promise<MetaLlmResult<AnthropicMessage>> =>
      postJsonIdempotent<AnthropicMessage>(
        this.nonstreamDeps(options),
        "/v1/messages",
        "messages.create",
        request,
      ),
    /**
     * `POST /v1/messages/count_tokens`. Same "direct nonstream call"
     * class as `messages.create` (ADR-0024a §D7) — reuses
     * `postJsonIdempotent` verbatim.
     */
    countTokens: (
      request: CountTokensRequest,
      options?: MetaLlmCallOptions,
    ): Promise<MetaLlmResult<CountTokensResult>> =>
      postJsonIdempotent<CountTokensResult>(
        this.nonstreamDeps(options),
        "/v1/messages/count_tokens",
        "messages.countTokens",
        request,
      ),

    /**
     * `POST /v1/messages` with `stream: true` (ADR-0024a §D5). Issue #58 /
     * M2 continuation, item 2 of the tracked "what's left" list — reuses
     * the same generic SSE parser (`../sse/parser.js`) `chat.completionsStream`
     * wired up in PR #88. Returns an async generator — iterate with `for
     * await`; it completes normally only after the Anthropic wire terminal
     * condition (`message_stop`) is observed, otherwise it throws a typed
     * `AgenticError` describing why (see `./stream/messages-stream.js`).
     */
    createStream: (
      request: AnthropicMessageRequest,
      options?: MetaLlmCallOptions,
    ): AsyncGenerator<MetaLlmStreamEnvelope<AnthropicStreamEvent>, void, void> =>
      messagesCreateStreamImpl(this.nonstreamDeps(options), request, options?.requestContext),
  };

  /**
   * `POST /v1/responses`. Current server is stateless: callers resend
   * conversation input. `previousResponseId` is preview and MUST NOT be
   * described as recovery (ADR-0024a §D3) — this method does not restore
   * or synthesize any prior conversation state; it only sends `request`
   * as given. Real HTTP call logic (issue #58 / M2 continuation) reuses
   * `postJsonIdempotent` verbatim, same as `chat.completions`.
   */
  responses(
    request: ResponsesRequest,
    options?: MetaLlmCallOptions,
  ): Promise<MetaLlmResult<ResponsesResponse>> {
    return postJsonIdempotent<ResponsesResponse>(
      this.nonstreamDeps(options),
      "/v1/responses",
      "responses",
      request,
    );
  }

  /**
   * `POST /v1/embeddings`. Real HTTP call logic (issue #58 / M2
   * continuation) reuses `postJsonIdempotent` verbatim — infrastructure is
   * identical to the other direct nonstream operations even though
   * embeddings has its own separate maturity gate criteria in ADR-0024a
   * §D2 ("input limits, dimensions, usage, errors and auth published").
   */
  embeddings(
    request: EmbeddingRequest,
    options?: MetaLlmCallOptions,
  ): Promise<MetaLlmResult<EmbeddingResponse>> {
    return postJsonIdempotent<EmbeddingResponse>(
      this.nonstreamDeps(options),
      "/v1/embeddings",
      "embeddings",
      request,
    );
  }

  /**
   * Close local connections and wait only. Never cancels a remote
   * operation, stops a pod, releases a reservation, or revokes a
   * credential (ADR-0024a §D1).
   */
  async close(): Promise<void> {
    // No persistent local connections are opened by this client (the
    // fetch-based transport has no pool to drain); reserved for a future
    // transport that does.
  }

  // ---------------------------------------------------------------------
  // Internal HTTP glue shared by health/whoami/models, chat.completions,
  // and messages.create
  // ---------------------------------------------------------------------

  /** Build the dependency bag `postJsonIdempotent` (`./nonstream.js`) needs. */
  private nonstreamDeps(options?: MetaLlmCallOptions): NonstreamDeps {
    const tenant = options?.requestContext?.tenant ?? this.config.defaultRequestContext?.tenant;
    return {
      baseUrl: this.config.baseUrl,
      transport: this.config.transport ?? fetch,
      credentialProvider: this.config.credentialProvider,
      defaultRequestContext: tenant ? { tenant } : this.config.defaultRequestContext,
      telemetry: this.config.telemetry,
    };
  }

  private async resolveCredential(
    operation: string,
    requiredScopes: string[],
  ): Promise<Credential | undefined> {
    const provider: CredentialProvider | undefined = this.config.credentialProvider;
    if (!provider) return undefined;
    return provider.acquire({
      product: PRODUCT,
      normalizedOrigin: this.config.baseUrl,
      audience: this.config.baseUrl,
      requiredScopes,
      operation,
      interactiveAllowed: false,
    });
  }

  private applyAuth(headers: Record<string, string>, credential?: Credential): void {
    if (!credential) return;
    // The SDK sends exactly one contracted placement per operation
    // (ADR-0024a §D8). `credential.scheme` is either the literal header
    // name (e.g. `StaticApiKeyCredentialProvider`'s default "X-API-Key")
    // or "bearer", which maps to the standard `Authorization` header.
    if (credential.scheme.toLowerCase() === "bearer") {
      headers.Authorization = `Bearer ${credential.secret.reveal()}`;
    } else {
      headers[credential.scheme] = credential.secret.reveal();
    }
  }

  private async getJson<T>(
    path: string,
    operation: string,
    options: MetaLlmCallOptions | undefined,
    opts: { requireCredential: boolean },
  ): Promise<MetaLlmResult<T>> {
    const requestId =
      options?.requestContext?.requestId ??
      this.config.defaultRequestContext?.requestId ??
      newRequestId();

    this.config.telemetry?.onRequestStart?.({ operation, requestId });
    const startedAt = Date.now();

    // ADR-0024a §D1: `health()` is process-level response only — never
    // identity or readiness — so it must not acquire (or attempt to
    // acquire) a credential at all when a credential isn't required. Only
    // `whoami`/`models` (both `requireCredential: true`) touch
    // `credentialProvider` here.
    let credential: Credential | undefined;
    if (opts.requireCredential) {
      credential = await this.resolveCredential(operation, ["meta-llm.read"]).catch((cause) => {
        throw new AgenticError("authentication", `failed to acquire credential: ${cause}`, {
          product: PRODUCT,
          operation,
          requestId,
          retryable: false,
          cause,
        });
      });

      if (!credential) {
        throw new AgenticError(
          "authentication",
          `MetaLlmClient.${operation} requires a credential_provider`,
          { product: PRODUCT, operation, requestId, retryable: false },
        );
      }

      // ADR-0022 §D5 scope preflight, before any I/O below. Also serves
      // ADR-0024a §D8's "does not assume OAuth platform access": an
      // `OAuthTokenCredentialProvider` whose granted scopes are known and
      // cover only completion-family scopes (e.g. `meta-llm.inference`)
      // is refused here for `usage`/`whoami`/`models` rather than silently
      // sent through — it never reaches "meta-llm.read".
      assertScopeGranted(PRODUCT, operation, "meta-llm.read", credential);
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-Cognitum-Request-Id": requestId,
    };
    this.applyAuth(headers, credential);

    const transport = this.config.transport ?? fetch;
    const url = `${this.config.baseUrl}${path}`;

    let response: Response;
    try {
      response = await transport(url, { method: "GET", headers });
    } catch (cause) {
      this.config.telemetry?.onRequestEnd?.({
        operation,
        requestId,
        durationMs: Date.now() - startedAt,
      });
      throw new AgenticError("transport", `${operation} request failed: ${cause}`, {
        product: PRODUCT,
        operation,
        requestId,
        retryable: true,
        cause,
      });
    }

    const durationMs = Date.now() - startedAt;
    this.config.telemetry?.onRequestEnd?.({
      operation,
      requestId,
      httpStatus: response.status,
      durationMs,
    });

    if (!response.ok) {
      throw await mapMetaLlmHttpError(response, operation, requestId);
    }

    const data = (await response.json()) as T;
    const meta: MetaLlmResponseMeta = {
      requestId: response.headers.get("x-cognitum-request-id") ?? requestId,
      httpStatus: response.status,
      protocolVersion: response.headers.get("x-cognitum-protocol-version") ?? undefined,
    };
    return { data, meta };
  }
}
