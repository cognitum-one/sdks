/**
 * MetaLlmClient (ADR-0024a). Issue #58 / M2 start.
 *
 * This pass:
 *  - implements real, HTTP-backed `health()`, `whoami()`, and `models()` —
 *    the "Stable-track, simplest" group per §D2's maturity table;
 *  - implements `capabilities()` from the static compatibility snapshot
 *    (no I/O — no runtime capabilities endpoint is published yet, §D9
 *    gate #3);
 *  - fails closed on `ready(feature)` (dependency readiness is only
 *    published "when published", §D1 — nothing is published yet);
 *  - freezes typed placeholders for `chat.completions`, `completions`,
 *    `messages.create`, `messages.countTokens`, `responses`, and
 *    `embeddings` that reject with `AgenticError` until their HTTP logic
 *    lands in a follow-up issue.
 *
 * Explicitly out of scope this pass (see PR description): streaming
 * (§D5), the five protocol operations' HTTP logic, and ADR-0024b routing
 * controls.
 */

import {
  AgenticError,
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
 * Returns (never throws synchronously) a rejected promise so callers can
 * always `await`/`.catch()` these placeholders like any other operation
 * method, rather than needing a synchronous try/catch around the call
 * expression itself.
 */
function notImplemented(operation: string): Promise<never> {
  return Promise.reject(
    new AgenticError(
      "unsupported_capability",
      `MetaLlmClient.${operation} is not implemented yet (ADR-0024a §D2/§D3 wire ` +
        `types only landed in issue #58 / M2 — HTTP logic is a follow-up issue)`,
      { product: PRODUCT, operation, retryable: false },
    ),
  );
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
    completions: (
      _request: ChatCompletionRequest,
      _options?: MetaLlmCallOptions,
    ): Promise<MetaLlmResult<ChatCompletion>> => notImplemented("chat.completions"),
  };

  completions(
    _request: LegacyCompletionRequest,
    _options?: MetaLlmCallOptions,
  ): Promise<MetaLlmResult<LegacyCompletion>> {
    return notImplemented("completions");
  }

  readonly messages = {
    create: (
      _request: AnthropicMessageRequest,
      _options?: MetaLlmCallOptions,
    ): Promise<MetaLlmResult<AnthropicMessage>> => notImplemented("messages.create"),
    countTokens: (
      _request: CountTokensRequest,
      _options?: MetaLlmCallOptions,
    ): Promise<MetaLlmResult<CountTokensResult>> => notImplemented("messages.countTokens"),
  };

  responses(
    _request: ResponsesRequest,
    _options?: MetaLlmCallOptions,
  ): Promise<MetaLlmResult<ResponsesResponse>> {
    return notImplemented("responses");
  }

  embeddings(
    _request: EmbeddingRequest,
    _options?: MetaLlmCallOptions,
  ): Promise<MetaLlmResult<EmbeddingResponse>> {
    return notImplemented("embeddings");
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
  // Internal HTTP glue shared by health/whoami/models
  // ---------------------------------------------------------------------

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

    const credential = await this.resolveCredential(operation, ["meta-llm.read"]).catch(
      (cause) => {
        if (opts.requireCredential) {
          throw new AgenticError("authentication", `failed to acquire credential: ${cause}`, {
            product: PRODUCT,
            operation,
            requestId,
            retryable: false,
            cause,
          });
        }
        return undefined;
      },
    );

    if (opts.requireCredential && !credential) {
      throw new AgenticError(
        "authentication",
        `MetaLlmClient.${operation} requires a credential_provider`,
        { product: PRODUCT, operation, requestId, retryable: false },
      );
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
      throw await this.mapHttpError(response, operation, requestId);
    }

    const data = (await response.json()) as T;
    const meta: MetaLlmResponseMeta = {
      requestId: response.headers.get("x-cognitum-request-id") ?? requestId,
      httpStatus: response.status,
      protocolVersion: response.headers.get("x-cognitum-protocol-version") ?? undefined,
    };
    return { data, meta };
  }

  private async mapHttpError(
    response: Response,
    operation: string,
    requestId: string,
  ): Promise<AgenticError> {
    const status = response.status;
    const bodyText = await response.text().catch(() => "");
    const fields = { product: PRODUCT, operation, status, requestId };

    switch (status) {
      case 401:
        return new AgenticError("authentication", bodyText || "authentication failed", {
          ...fields,
          retryable: false,
        });
      case 403:
        return new AgenticError("permission_denied", bodyText || "permission denied", {
          ...fields,
          retryable: false,
        });
      case 404:
        return new AgenticError("not_found", bodyText || "not found", {
          ...fields,
          retryable: false,
        });
      case 429: {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
        return new AgenticError("rate_limited", bodyText || "rate limited", {
          ...fields,
          retryable: true,
          retryAfterMs,
        });
      }
      case 502:
      case 503:
        return new AgenticError("transport", bodyText || `upstream error ${status}`, {
          ...fields,
          retryable: true,
        });
      default:
        return new AgenticError("protocol", bodyText || `unexpected status ${status}`, {
          ...fields,
          retryable: false,
        });
    }
  }
}
