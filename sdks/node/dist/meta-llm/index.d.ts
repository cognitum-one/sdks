/** Capability negotiation (ADR-0019 §D6). Type-only scaffolding — issue #52 / M1. */
/** Where a {@link CapabilitySet} came from. */
type CapabilitySource = "server" | "static-compatibility-table";
/**
 * Runtime-advertised, versioned support for a named behavior.
 *
 * Unknown product versions MUST receive the intersection of proven-safe
 * capabilities, never the union (ADR-0019 §D6).
 */
interface CapabilitySet {
    product: string;
    productVersion: string;
    protocol: string;
    protocolVersion: string;
    features: Record<string, boolean>;
    limitations: string[];
    authMethods: string[];
    source: CapabilitySource;
}

/** Why a {@link CancellationToken} was cancelled (ADR-0023 §D7). */
type CancellationReason = "caller" | "deadline" | "shutdown";
/**
 * Transport-neutral cancellation contract. Distinct from "cancel remote
 * operation" and "terminate local process" — see `OperationHandle` in
 * `./operations.js`.
 */
interface CancellationToken {
    readonly isCancelled: boolean;
    readonly reason?: CancellationReason;
}
/** Time-budget model (ADR-0023 §D8). Timeouts are separate values, never one shared 30s default. */
interface TimeBudget {
    connectTimeoutMs?: number;
    firstByteTimeoutMs?: number;
    idleTimeoutMs?: number;
    requestDeadlineMs?: number;
    waitDeadlineMs?: number;
    cancelGraceMs?: number;
    retrySleepBudgetMs?: number;
}

/**
 * Credential-provider contract and secret redaction (ADR-0022 §D1, §D10).
 * Type-only scaffolding — issue #52 / M1. No HTTP implementation ships in
 * this pass. Concrete providers land in issue #53; redaction logic in #54.
 */
/** Parameters describing the credential a caller is about to request. */
interface CredentialRequest {
    product: string;
    normalizedOrigin: string;
    audience: string;
    requiredScopes: string[];
    operation: string;
    interactiveAllowed: boolean;
}
/** Non-secret authority descriptor used to partition capability/cache state. */
interface CredentialAuthority {
    providerFingerprint: string;
    product: string;
    normalizedOrigin: string;
    audience: string;
    principal?: string;
    tenant?: string;
    delegatedSubtenant?: string;
    effectiveScopes?: string[];
    plan?: string;
}
declare const REDACT_INSPECT: unique symbol;
/**
 * Redacting wrapper around a secret value (ADR-0022 §D1/§D10).
 *
 * Node inspection, `JSON.stringify`, error formatting, and template-literal
 * coercion MUST NOT reveal the wrapped value — only {@link reveal} does.
 */
declare class RedactedSecret {
    #private;
    constructor(value: string);
    /** Explicit, auditable access to the underlying secret. */
    reveal(): string;
    toString(): string;
    toJSON(): string;
    [REDACT_INSPECT](): string;
}
/** A credential acquired from a {@link CredentialProvider}. */
interface Credential {
    scheme: string;
    secret: RedactedSecret;
    expiresAt?: string;
    grantedScopes?: string[];
    audience: string;
    source: string;
    authority: CredentialAuthority;
}
/**
 * Product clients accept a credential provider, not an untyped reusable
 * header map (ADR-0022 §D1). No HTTP implementation ships in this pass —
 * concrete providers land in issue #53.
 */
interface CredentialProvider {
    describeAuthority(request: CredentialRequest): Promise<CredentialAuthority>;
    acquire(request: CredentialRequest): Promise<Credential>;
    /** Non-secret stable provider identity, safe to log. */
    identity(): string;
    invalidate(reason: string): Promise<void>;
}

/**
 * Shared per-call request context (ADR-0019 §D5) and budget policy
 * (ADR-0022 §D6). Type-only scaffolding — issue #52 / M1.
 */

/** How the SDK should treat an operation whose cost estimate is unknown. */
type OnUnknownEstimate = "reject" | "allow_server_enforcement";
/** Client-side spend guard, not an accounting authority (ADR-0022 §D6). */
interface BudgetPolicy {
    maxEstimatedCost?: number;
    maxCommittedCost?: number;
    currency?: string;
    maxTier?: string;
    allowEscalation?: boolean;
    reservationTtlMs?: number;
    onUnknownEstimate: OnUnknownEstimate;
}
/** Resolved tenant binding for a request. Never a generic caller override (ADR-0022 §D4). */
interface TenantContext {
    tenantId?: string;
    delegatedSubtenantId?: string;
}
/**
 * Per-call request context shared across every agentic product client
 * (ADR-0019 §D5): identity, correlation, idempotency, budget, timeouts, and
 * cancellation. Product-specific fields (routing plane, safety mode, solve
 * input, etc.) do NOT belong here.
 */
interface RequestContext {
    requestId: string;
    correlationId?: string;
    idempotencyKey?: string;
    tenant?: TenantContext;
    normalizedOrigin: string;
    credentialProvider?: CredentialProvider;
    budgetPolicy?: BudgetPolicy;
    timeBudget?: TimeBudget;
    cancellation?: CancellationToken;
    /** Optional trace-context carrier (e.g. W3C `traceparent`/`tracestate`). */
    tracingCarrier?: Record<string, string>;
}

/**
 * MetaLlmClient construction and deployment ownership (ADR-0024a §D1).
 *
 * Type-only scaffolding plus construction-time validation for issue #58 / M2.
 * Construction performs NO I/O — see {@link MetaLlmClient} in `./client.js`
 * for the first real HTTP-backed operations (`health`, `whoami`, `models`).
 */

/**
 * ADR-0024b product-specific routing controls. Frozen as an opaque
 * placeholder here — the concrete shape lands with issue #59
 * (ADR-0024b: Meta LLM platform resources, routing, and usage). A generic
 * caller override MUST NOT be able to conflict with the eventual typed
 * fields (ADR-0024a §D3), so this stays a nominal, intentionally-narrow
 * record rather than `Record<string, unknown>` reused elsewhere.
 */
interface MetaLlmRoutingControls {
    readonly __brand?: "MetaLlmRoutingControls";
    [key: string]: unknown;
}
/**
 * ADR-0024b product-specific safety control. Frozen as an opaque placeholder
 * — see {@link MetaLlmRoutingControls} for the same issue #59 deferral note.
 */
interface MetaLlmSafetyControl {
    readonly __brand?: "MetaLlmSafetyControl";
    [key: string]: unknown;
}
/** A single telemetry observation emitted around one MetaLlmClient operation. */
interface MetaLlmTelemetryEvent {
    operation: string;
    requestId: string;
    httpStatus?: number;
    durationMs?: number;
    retryAfterMs?: number;
    idempotentReplay?: boolean;
}
/**
 * Caller-supplied telemetry hooks (ADR-0028). Deliberately minimal in this
 * pass — no cost/usage aggregation, no drift detection wiring yet. Hooks
 * MUST NOT receive secrets; callers wire redaction via `SecretRedactor`
 * from `../agentic/index.js` before logging anything derived from these
 * events.
 */
interface MetaLlmTelemetryHooks {
    onRequestStart?(event: Pick<MetaLlmTelemetryEvent, "operation" | "requestId">): void;
    onRequestEnd?(event: MetaLlmTelemetryEvent): void;
}
/**
 * Fetch-compatible transport hook, injectable for tests (ADR-0024a §D1
 * `transport` field). Defaults to `globalThis.fetch`.
 */
type MetaLlmTransport = typeof fetch;
/** Construction config for {@link MetaLlmClient} (ADR-0024a §D1). */
interface MetaLlmClientConfig {
    /**
     * Explicit HTTPS origin. A production URL becomes a default only after
     * publication in the contract bundle (ADR-0024a §D1) — there is no
     * built-in default here, unlike the root `Cognitum` client.
     */
    baseUrl: string;
    /**
     * Opt out of the HTTPS-origin requirement for local development and
     * tests only (e.g. a local mock server on `http://127.0.0.1`). Defaults
     * to `false`. Never set this against a real deployment.
     */
    allowInsecureHttp?: boolean;
    credentialProvider?: CredentialProvider;
    transport?: MetaLlmTransport;
    defaultRequestContext?: Partial<RequestContext>;
    defaultRoutingControls?: MetaLlmRoutingControls;
    defaultSafetyControl?: MetaLlmSafetyControl;
    budgetPolicy?: BudgetPolicy;
    /**
     * Static compatibility-table entry consulted by `capabilities()` until a
     * runtime capabilities endpoint is published (ADR-0024a §D9 gate #3).
     */
    capabilitiesSnapshot?: CapabilitySet;
    telemetry?: MetaLlmTelemetryHooks;
}
/** Normalized, defaulted construction state held by {@link MetaLlmClient}. */
interface ResolvedMetaLlmClientConfig extends MetaLlmClientConfig {
    baseUrl: string;
}
/**
 * Validate and normalize a {@link MetaLlmClientConfig}. Pure function, no
 * I/O — construction MUST stay side-effect free (ADR-0024a §D1, ADR-0019 §D3).
 */
declare function resolveMetaLlmClientConfig(config: MetaLlmClientConfig): ResolvedMetaLlmClientConfig;

/**
 * Result and metadata envelope (ADR-0024a §D4). Type-only this pass — the
 * receipt/drift-comparison logic described in §D4's "body and headers
 * duplicate receipt fields" paragraph is deferred to the follow-up issue
 * that lands ADR-0024b's `MetaLlmReceipt`.
 */
/**
 * Placeholder for ADR-0024b's `MetaLlmReceipt`. Kept as `unknown` rather than
 * `Record<string, unknown>` so callers cannot accidentally treat an absent
 * receipt as a shaped, empty object (ADR-0024a §D4: "Missing metadata
 * remains missing").
 */
type MetaLlmReceipt = unknown;
/** Per-response metadata carried alongside every {@link MetaLlmResult} (ADR-0024a §D4). */
interface MetaLlmResponseMeta {
    requestId: string;
    protocolVersion?: string;
    httpStatus: number;
    retryAfterMs?: number;
    idempotentReplay?: boolean;
    receipt?: MetaLlmReceipt;
    warnings?: string[];
    unknownHeaders?: Record<string, string>;
}
/** Envelope wrapping every MetaLlmClient operation result (ADR-0024a §D4). */
interface MetaLlmResult<T> {
    data: T;
    meta: MetaLlmResponseMeta;
}

/**
 * Discovery wire types: health, models, whoami (ADR-0024a §D1, §D2).
 *
 * No service-owned OpenAPI contract exists yet (ADR-0024a §D9 gate #1), so
 * these stay intentionally permissive (`raw` passthrough) rather than
 * pretending to be the eventual GA contract.
 */
/** `health()` response — process-level only, never identity or readiness. */
interface MetaLlmHealth {
    status: string;
    version?: string;
    /** Unrecognized fields from the server response, preserved verbatim. */
    raw?: Record<string, unknown>;
}
/** A single entry from `models()`. `/v1/models` may not list every accepted alias. */
interface MetaLlmModelInfo {
    id: string;
    object?: string;
    ownedBy?: string;
    created?: number;
    raw?: Record<string, unknown>;
}
/** `models()` response. */
interface MetaLlmModelList {
    object?: string;
    models: MetaLlmModelInfo[];
    raw?: Record<string, unknown>;
}
/** `whoami()` response — authenticated account and credential type only. */
interface MetaLlmWhoAmI {
    accountId?: string;
    credentialType?: string;
    scopes?: string[];
    tenantId?: string;
    raw?: Record<string, unknown>;
}

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
 */
/** A single chat message. Content may be plain text or a multi-part array. */
interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool" | "developer";
    content: string | ChatContentPart[] | null;
    name?: string;
    toolCallId?: string;
    toolCalls?: ChatToolCall[];
}
type ChatContentPart = {
    type: "text";
    text: string;
} | {
    type: "image_url";
    imageUrl: {
        url: string;
        detail?: "auto" | "low" | "high";
    };
};
interface ChatToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}
interface ChatToolDefinition {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}
type ChatToolChoice = "none" | "auto" | "required" | {
    type: "function";
    function: {
        name: string;
    };
};
/** `POST /v1/chat/completions` request. Server currently caps `n = 1`. */
interface ChatCompletionRequest {
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
    responseFormat?: {
        type: "text" | "json_object";
    };
    seed?: number;
}
interface ChatCompletionUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}
interface ChatCompletionChoice {
    index: number;
    message: ChatMessage;
    finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null;
    logprobs?: unknown;
}
/** `POST /v1/chat/completions` response. */
interface ChatCompletion {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: ChatCompletionChoice[];
    usage?: ChatCompletionUsage;
    systemFingerprint?: string;
}
/** `POST /v1/completions` (legacy) request. */
interface LegacyCompletionRequest {
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
}
interface LegacyCompletionChoice {
    text: string;
    index: number;
    logprobs?: unknown;
    finishReason: "stop" | "length" | "content_filter" | null;
}
/** `POST /v1/completions` (legacy) response. */
interface LegacyCompletion {
    id: string;
    object: "text_completion";
    created: number;
    model: string;
    choices: LegacyCompletionChoice[];
    usage?: ChatCompletionUsage;
}
/** Discriminated Responses output item. Kept intentionally partial pending GA. */
type ResponsesOutputItem = {
    type: "message";
    id: string;
    role: "assistant";
    content: ChatContentPart[];
} | {
    type: "reasoning";
    id: string;
    summary?: string[];
} | {
    type: "tool_call";
    id: string;
    name: string;
    arguments: string;
};
/**
 * `POST /v1/responses` request. Current server is stateless: callers resend
 * conversation input. `previousResponseId` is preview and MUST NOT be
 * described as recovery (ADR-0024a §D3).
 */
interface ResponsesRequest {
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
}
/** `POST /v1/responses` response. */
interface ResponsesResponse {
    id: string;
    object: "response";
    createdAt: number;
    model: string;
    status: "completed" | "in_progress" | "failed" | "incomplete";
    output: ResponsesOutputItem[];
    usage?: ChatCompletionUsage;
    previousResponseId?: string;
    incompleteDetails?: {
        reason: string;
    };
}
/** `POST /v1/embeddings` request. */
interface EmbeddingRequest {
    model: string;
    input: string | string[];
    encodingFormat?: "float" | "base64";
    dimensions?: number;
    user?: string;
}
interface EmbeddingDatum {
    object: "embedding";
    embedding: number[];
    index: number;
}
interface EmbeddingUsage {
    promptTokens: number;
    totalTokens: number;
}
/** `POST /v1/embeddings` response. */
interface EmbeddingResponse {
    object: "list";
    data: EmbeddingDatum[];
    model: string;
    usage: EmbeddingUsage;
}

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
 */
type AnthropicContentBlock = {
    type: "text";
    text: string;
} | {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
} | {
    type: "tool_result";
    toolUseId: string;
    content?: string | AnthropicContentBlock[];
    isError?: boolean;
} | {
    type: "image";
    source: {
        type: "base64";
        mediaType: string;
        data: string;
    };
};
interface AnthropicMessageParam {
    role: "user" | "assistant";
    content: string | AnthropicContentBlock[];
}
interface AnthropicToolDefinition {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
}
type AnthropicToolChoice = {
    type: "auto";
} | {
    type: "any";
} | {
    type: "tool";
    name: string;
};
/** `POST /v1/messages` request. `maxTokens` is required by the Anthropic wire shape. */
interface AnthropicMessageRequest {
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
    metadata?: {
        userId?: string;
    };
}
interface AnthropicUsage {
    inputTokens: number;
    outputTokens: number;
}
/** `POST /v1/messages` response. */
interface AnthropicMessage {
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
interface CountTokensRequest {
    model: string;
    messages: AnthropicMessageParam[];
    system?: string;
    tools?: AnthropicToolDefinition[];
}
/** `POST /v1/messages/count_tokens` response. */
interface CountTokensResult {
    inputTokens: number;
}

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

/** Options accepted by every operation method. */
interface MetaLlmCallOptions {
    requestContext?: Partial<RequestContext>;
    routingControls?: MetaLlmRoutingControls;
    safetyControl?: MetaLlmSafetyControl;
}
/**
 * Serving-protocol client for Meta LLM (ADR-0024a). Construction performs no
 * I/O (ADR-0024a §D1, ADR-0019 §D3).
 */
declare class MetaLlmClient {
    private readonly config;
    constructor(config: MetaLlmClientConfig);
    /** Process-level health only — never identity or readiness (ADR-0024a §D1). */
    health(options?: MetaLlmCallOptions): Promise<MetaLlmResult<MetaLlmHealth>>;
    /** `/v1/models`. May not list every alias the resolver accepts (ADR-0024a Context). */
    models(options?: MetaLlmCallOptions): Promise<MetaLlmResult<MetaLlmModelList>>;
    /** Authenticated account and credential type only (ADR-0024a §D1). */
    whoami(options?: MetaLlmCallOptions): Promise<MetaLlmResult<MetaLlmWhoAmI>>;
    /**
     * Versioned behavior safe for this caller, from the static compatibility
     * snapshot (no I/O — ADR-0024a §D9 gate #3 is not yet published). Unknown
     * server versions receive the intersection of proven-safe capabilities,
     * never the union (ADR-0019 §D6).
     */
    capabilities(): CapabilitySet;
    /**
     * Dependency readiness for a named feature. Fails closed: no readiness
     * endpoint is published yet (ADR-0024a §D1: "when published").
     */
    ready(feature: string): Promise<never>;
    readonly chat: {
        /**
         * `POST /v1/chat/completions` (OpenAI-style). Real HTTP call logic
         * (issue #58 / M2 continuation): idempotency-key generation, bounded
         * 429/502/503 retry, and a single 401-refresh — see `./nonstream.js`.
         * Streaming (`request.stream = true`) is not validated against here —
         * this pass only implements the nonstream path (§D5 is a follow-up
         * issue).
         */
        completions: (request: ChatCompletionRequest, options?: MetaLlmCallOptions) => Promise<MetaLlmResult<ChatCompletion>>;
    };
    completions(_request: LegacyCompletionRequest, _options?: MetaLlmCallOptions): Promise<MetaLlmResult<LegacyCompletion>>;
    readonly messages: {
        /**
         * `POST /v1/messages` (Anthropic-style). Real HTTP call logic (issue
         * #58 / M2 continuation) — see `chat.completions`'s doc comment and
         * `./nonstream.js` for the shared idempotency/retry logic.
         */
        create: (request: AnthropicMessageRequest, options?: MetaLlmCallOptions) => Promise<MetaLlmResult<AnthropicMessage>>;
        countTokens: (_request: CountTokensRequest, _options?: MetaLlmCallOptions) => Promise<MetaLlmResult<CountTokensResult>>;
    };
    responses(_request: ResponsesRequest, _options?: MetaLlmCallOptions): Promise<MetaLlmResult<ResponsesResponse>>;
    embeddings(_request: EmbeddingRequest, _options?: MetaLlmCallOptions): Promise<MetaLlmResult<EmbeddingResponse>>;
    /**
     * Close local connections and wait only. Never cancels a remote
     * operation, stops a pod, releases a reservation, or revokes a
     * credential (ADR-0024a §D1).
     */
    close(): Promise<void>;
    /** Build the dependency bag `postJsonIdempotent` (`./nonstream.js`) needs. */
    private nonstreamDeps;
    private resolveCredential;
    private applyAuth;
    private getJson;
}

export { type AnthropicContentBlock, type AnthropicMessage, type AnthropicMessageParam, type AnthropicMessageRequest, type AnthropicToolChoice, type AnthropicToolDefinition, type AnthropicUsage, type ChatCompletion, type ChatCompletionChoice, type ChatCompletionRequest, type ChatCompletionUsage, type ChatContentPart, type ChatMessage, type ChatToolCall, type ChatToolChoice, type ChatToolDefinition, type CountTokensRequest, type CountTokensResult, type EmbeddingDatum, type EmbeddingRequest, type EmbeddingResponse, type EmbeddingUsage, type LegacyCompletion, type LegacyCompletionChoice, type LegacyCompletionRequest, type MetaLlmCallOptions, MetaLlmClient, type MetaLlmClientConfig, type MetaLlmHealth, type MetaLlmModelInfo, type MetaLlmModelList, type MetaLlmReceipt, type MetaLlmResponseMeta, type MetaLlmResult, type MetaLlmRoutingControls, type MetaLlmSafetyControl, type MetaLlmTelemetryEvent, type MetaLlmTelemetryHooks, type MetaLlmTransport, type MetaLlmWhoAmI, type ResolvedMetaLlmClientConfig, type ResponsesOutputItem, type ResponsesRequest, type ResponsesResponse, resolveMetaLlmClientConfig };
