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

/** Finality of a single cost observation within a receipt. */
type CostFinality = "estimate" | "reserved" | "committed" | "provider_reported" | "invoiced";
/** A single labeled cost observation (ADR-0022 §D6 distinct-fields rule). */
interface CostObservation {
    source: string;
    amount: number;
    currency: string;
    finality: CostFinality;
}

/**
 * ADR-0024b §D2: routing types and precedence. Issue #59, D11 migration
 * step 1 ("Release routing receipt and usage read-only support after
 * ADR-0024a serving").
 *
 * `ModelSelector` deliberately has NO escape hatch for a raw provider model
 * ID — `auto`, a `ModelTier`, or a contract-declared alias string are the
 * only three shapes the audited resolver accepts; anything else is rejected
 * server-side as `model_not_found` (§D2). This is a deliberate rejection,
 * not an oversight, so no fourth "raw model id" variant is added here.
 *
 * Unknown values RECEIVED from the server (e.g. a `resolved_tier` that
 * predates this SDK's enum) must be preserved rather than dropped — see
 * `../types/receipt.js`'s `ReceiptModelTier`/`ReceiptCacheResult`, which
 * widen the known union with `(string & {})` so an unrecognized wire value
 * still round-trips as a plain string instead of being coerced away.
 *
 * Values the SDK *sends*, by contrast, are validated against the closed set
 * at request time via `assertSendableRoutingControls` — §D2: "stable
 * methods cannot send them until capabilities declare support."
 *
 * Body controls win over `X-Cognitum-*` headers (§D2) — this SDK never
 * exposes a generic header-override surface for routing, safety, auth,
 * request ID, idempotency, trace, host, or content-length fields (see
 * `../nonstream.ts`/`../client.ts`: headers are built internally from typed
 * fields only), so there is no header path these controls could lose to.
 */
type ModelTier = "low" | "mid" | "high";
type ModelSelector = {
    readonly kind: "auto";
} | {
    readonly kind: "tier";
    readonly tier: ModelTier;
} | {
    readonly kind: "contract_declared_alias";
    readonly alias: string;
};
type FallbackPolicy = "fail_fast" | "best_effort";
type EscalationStrategy = "stream_oneshot" | "post_hoc" | "buffered" | "inflight";
type CacheMode = "disabled" | "exact" | "semantic";
type SafetyMode = "block" | "warn" | "redact";
/**
 * Opaque, sanitized attribution metadata (ADR-0024b §D2). Included in
 * operation/idempotency metadata where contracted, but never treated as
 * tenant, budget, rate-limit, or resource-owner authority.
 */
type SubTenantAttribution = string;
/** ADR-0024b §D2's `MetaLlmRoutingControls`. */
interface MetaLlmRoutingControls {
    model?: ModelSelector;
    minTier?: ModelTier;
    maxTier?: ModelTier;
    fallbackPolicy?: FallbackPolicy;
    escalation?: EscalationStrategy;
    cache?: CacheMode;
    safety?: SafetyMode;
    subTenantId?: SubTenantAttribution;
}
/** Thrown by `assertSendableRoutingControls` — never thrown by response parsing. */
declare class UnsendableRoutingControlsError extends Error {
    constructor(message: string);
}
/**
 * Validates a caller-supplied `MetaLlmRoutingControls` immediately before it
 * is serialized onto the wire. Throws rather than silently sending an
 * unrecognized enum member or a raw provider model ID. Never called on data
 * received from the server — received unknown values are preserved, not
 * rejected (see `../types/receipt.js`).
 */
declare function assertSendableRoutingControls(controls: MetaLlmRoutingControls | undefined): void;

/**
 * MetaLlmClient construction and deployment ownership (ADR-0024a §D1).
 *
 * Type-only scaffolding plus construction-time validation for issue #58 / M2.
 * Construction performs NO I/O — see {@link MetaLlmClient} in `./client.js`
 * for the first real HTTP-backed operations (`health`, `whoami`, `models`).
 */

/**
 * ADR-0024b product-specific safety control. Frozen as an opaque placeholder
 * — this stays a separate, still-deferred surface from `MetaLlmRoutingControls`
 * (whose `safety: SafetyMode` field is now concrete): richer safety
 * configuration (detector-class selection, thresholds) is out of this
 * pass's scope.
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
 * ADR-0028's `Money`: an exact decimal amount + ISO-4217 currency, decoded
 * from wire USD decimal values so cost/price/savings fields never enter the
 * public domain model as binary floating point (ADR-0024b §D3: "Wire
 * fields such as current USD price values decode into ADR-0028 decimal
 * `Money`; they never enter the public domain model as binary floating
 * point").
 *
 * No `Money`/decimal type exists yet elsewhere in this SDK (checked
 * `../../agentic/receipts.ts`'s `CostObservation.amount`, which is still a
 * plain `number` from the earlier ADR-0028 receipt/lineage stub — that is
 * an existing gap, out of scope to fix here, not something this type
 * inherits). This is a minimal string-backed decimal wrapper rather than a
 * new bignum/decimal dependency — the SDK does not otherwise depend on one,
 * and a decimal string is the only representation that cannot silently
 * lose precision at the JS/TS layer.
 *
 * Deliberately no arithmetic is provided here — this type exists to
 * prevent accidental floating-point ingestion of money values, not to be a
 * money-math library. Callers needing arithmetic should parse `amount`
 * with a decimal library of their own choosing.
 */
interface Money {
    /** Exact decimal string, e.g. `"0.0123"`. Never a `number`. */
    readonly amount: string;
    /** ISO-4217 currency code, e.g. `"USD"`. */
    readonly currency: string;
}
/**
 * Decode a wire money value into a {@link Money}. Accepts `amount` as
 * either a decimal string (preferred — exact) or a JSON number (tolerated;
 * a JSON number has already lost the ability to represent arbitrary
 * decimal precision at the `JSON.parse` boundary, but this decoder
 * performs no further floating-point arithmetic on it — it is converted
 * with `String()` only, never rounded or rescaled). Returns `undefined`
 * for a missing or malformed value rather than fabricating a zero amount.
 */
declare function parseMoney(raw: unknown): Money | undefined;

/**
 * ADR-0024b §D3's `MetaLlmReceipt`. Replaces the `unknown` placeholder that
 * shipped with ADR-0024a's envelope (`../envelope.ts`) — this is the
 * concrete shape issue #59 reserved that placeholder for.
 *
 * Every field here is server-authoritative evidence, not something this
 * SDK computes or backfills — a missing cost/price/savings field stays
 * missing rather than being reconstructed from token counts (§D3:
 * "Missing cost is not reconstructed from tokens"). Parsing never throws:
 * an unrecognized shape yields `undefined` (for the whole receipt) or a
 * preserved-but-untyped `raw` entry (for individual unknown fields), never
 * a thrown error — response parsing must not reject evidence just because
 * this SDK's enum set has not caught up yet (§D2).
 */

/**
 * `resolved_tier` can widen beyond this SDK's known `ModelTier` set as the
 * server evolves — the value is preserved as a plain string rather than
 * dropped or coerced (§D2: "Unknown received values are preserved").
 */
type ReceiptModelTier = ModelTier | (string & {});
/** Same unknown-preserving treatment as {@link ReceiptModelTier}, for `cache_result`. */
type ReceiptCacheResult = "hit" | "miss" | "bypass" | (string & {});
/**
 * Only contract-safe detector classes and counts are exposed here (§D4:
 * "Warn and redact expose only contract-safe detector classes and counts.
 * Prompts, matches, secrets, and unredacted content are excluded").
 */
interface SafetySummary {
    mode?: string;
    detectorClasses?: string[];
    blocked?: boolean;
    /** Unrecognized fields from the server response, preserved verbatim. */
    raw?: Record<string, unknown>;
}
/** ADR-0024b §D3's `MetaLlmReceipt`. */
interface MetaLlmReceipt {
    requestId: string;
    resolvedTier?: ReceiptModelTier;
    resolvedModel?: string;
    escalated?: boolean;
    capDegraded?: boolean;
    routingReason?: string;
    price?: Money;
    cacheResult?: ReceiptCacheResult;
    cacheSavings?: Money;
    promptCacheSavings?: Money;
    fallbackUsed?: boolean;
    breakerCounts?: Record<string, number>;
    subTenantId?: string;
    safetySummary?: SafetySummary;
    usage?: Record<string, unknown>;
    costs: CostObservation[];
    /** Fields present on the wire this decoder does not recognize, preserved verbatim (never dropped). */
    raw?: Record<string, unknown>;
}
/**
 * Parse a raw wire `cognitum_receipt` payload into a typed
 * {@link MetaLlmReceipt}. Returns `undefined` for a missing/malformed
 * receipt rather than a shaped empty object (ADR-0024a §D4: "Missing
 * metadata remains missing").
 */
declare function parseMetaLlmReceipt(raw: unknown): MetaLlmReceipt | undefined;

/**
 * Result and metadata envelope (ADR-0024a §D4). The receipt/drift-
 * comparison logic described in §D4's "body and headers duplicate receipt
 * fields" paragraph remains deferred (still not implemented this pass —
 * only decoding a receipt already present on the response, not comparing
 * it against header/body duplicates), but `MetaLlmReceipt` itself is now
 * the concrete ADR-0024b §D3 shape (issue #59, D11 migration step 1)
 * rather than the earlier `unknown` placeholder.
 */

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
 *
 * `routingControls` (ADR-0024b §D2, issue #59) is added to
 * `ChatCompletionRequest`, `LegacyCompletionRequest`, and `ResponsesRequest`
 * — the same three protocol request shapes ADR-0024b's issue names,
 * alongside `AnthropicMessageRequest` in `./anthropic.ts`. `EmbeddingRequest`
 * deliberately does NOT get this field: it is out of ADR-0024b D11 step 1's
 * scope.
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
    /** ADR-0024b §D2. Body controls win over any `X-Cognitum-*` header. */
    routingControls?: MetaLlmRoutingControls;
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
    /** ADR-0024b §D2. Body controls win over any `X-Cognitum-*` header. */
    routingControls?: MetaLlmRoutingControls;
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
    /** ADR-0024b §D2. Body controls win over any `X-Cognitum-*` header. */
    routingControls?: MetaLlmRoutingControls;
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
 *
 * `routingControls` (ADR-0024b §D2, issue #59) is added to
 * `AnthropicMessageRequest` — see `./openai.ts`'s module doc for the full
 * list of the four request shapes this field lands on.
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
    /** ADR-0024b §D2. Body controls win over any `X-Cognitum-*` header. */
    routingControls?: MetaLlmRoutingControls;
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
 * ADR-0024b §D3's `UsageSummary`/`BudgetView`, plus the bounded query the
 * read-only `client.usage()` method (`../client.ts`) accepts.
 *
 * Usage is strictly authenticated-account scoped (§D3) — every query is
 * bound to the caller's own credential; there is no cross-tenant or
 * cross-account parameter anywhere in {@link UsageQuery}. An empty
 * `UsageSummary` is not reinterpreted as "no usage anywhere" vs "this
 * account genuinely has none" (§D3) — `client.usage()` returns whatever
 * the server reports as-is, with no speculative fallback logic layered on
 * top.
 */

interface CacheStats {
    hitRate?: number;
    savings?: Money;
    raw?: Record<string, unknown>;
}
interface UsageTotals {
    requests?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cost?: Money;
    raw?: Record<string, unknown>;
}
/**
 * Plan degradation and reset information are preserved as reported (§D4) —
 * this SDK never recomputes `status`/`headroom` from the other fields.
 */
interface BudgetView {
    serving?: Money;
    hardLimit?: Money;
    committed?: Money;
    reserved?: Money;
    headroom?: Money;
    status?: string;
    resetsAt?: string;
    raw?: Record<string, unknown>;
}
interface UsageBreakdownEntry {
    requests?: number;
    cost?: Money;
    raw?: Record<string, unknown>;
}
interface UsagePeriodEntry extends UsageBreakdownEntry {
    period: string;
}
/** ADR-0024b §D3's `UsageSummary`. */
interface UsageSummary {
    totals: UsageTotals;
    tierMix?: Record<string, number>;
    escalationRate?: number;
    cache?: CacheStats;
    fallbackRate?: number;
    emptyBilledRate?: number;
    byModel?: Record<string, UsageBreakdownEntry>;
    byProvider?: Record<string, UsageBreakdownEntry>;
    byPeriod?: UsagePeriodEntry[];
    budget?: BudgetView;
    /** Fields present on the wire this decoder does not recognize, preserved verbatim (never dropped). */
    raw?: Record<string, unknown>;
}
/** Bounded `YYYY-MM` query window plus optional grouping (ADR-0024b §D3). */
interface UsageQuery {
    /** Inclusive `YYYY-MM` start of the query range. */
    from: string;
    /** Inclusive `YYYY-MM` end of the query range. */
    to: string;
    model?: string;
    provider?: string;
    groupBy?: "model" | "provider" | "period";
}
declare class InvalidUsageQueryError extends Error {
    constructor(message: string);
}
/** Validates the bounded `YYYY-MM` range required by §D3 before any request is sent. */
declare function assertValidUsageQuery(query: UsageQuery): void;
/**
 * Parse a raw `/v1/usage` JSON body into a typed {@link UsageSummary}.
 * Never throws — an entirely empty/malformed body decodes to an
 * `UsageSummary` with empty `totals` rather than an error, since an empty
 * result is itself meaningful account-scoped evidence (§D3), not a parse
 * failure.
 */
declare function parseUsageSummary(raw: unknown): UsageSummary;

/**
 * Protocol-agnostic Server-Sent Events (SSE) byte-level parser
 * (ADR-0024a §D5, ADR-0023 §D8 for the caller-facing time budgets that
 * wrap this parser — this file itself has no timing logic).
 *
 * Pure state machine with NO Meta-LLM (or any other product) knowledge —
 * this module is reused as-is for Anthropic Messages streaming and
 * Responses streaming when those land in follow-up work (issue #58
 * tracks only `chat.completions` streaming this pass). Consumes raw
 * bytes via {@link SseParser.feed} (arbitrary fragmentation: chunks may
 * split mid-line, mid-field, or mid-UTF-8 codepoint — bytes are buffered
 * and only decoded once a complete line's bytes are known, so a split
 * multi-byte codepoint at a chunk boundary is always safe) and yields
 * fully-parsed {@link SseEvent}s. Multiple `data:` lines are joined with
 * `\n` per the SSE spec; comment lines (leading `:`) are dropped; CRLF,
 * lone CR, and LF line endings are all accepted.
 *
 * Bounded-garbage handling (ADR-0024a §D5 "bounded unknown events"):
 * a single physical line over `maxLineBytes`, one event's joined `data:`
 * payload over `maxEventBytes`, or unterminated buffered bytes over
 * `maxBufferedBytes` are all dropped as malformed rather than growing
 * memory without bound; `maxMalformedEvents` caps how many such drops are
 * tolerated before {@link SseParser.feed} throws {@link SseParseError} and
 * the caller must abort the stream.
 *
 * Deliberate simplification vs. the full WHATWG EventSource processing
 * model: the `id`/`retry` fields reset with every dispatched event rather
 * than persisting as a `last-event-id` across events (SSE reconnection
 * semantics) — none of the three target protocols (OpenAI, Anthropic,
 * Responses) rely on client-driven SSE reconnection this pass.
 */
/** One fully-parsed, dispatched SSE event (generic — no protocol knowledge). */
interface SseEvent {
    /** The `event:` field, if any. `undefined` means the default "message" type per spec. */
    event?: string;
    /** All `data:` lines for this event, joined with `\n` (SSE spec). */
    data: string;
    /** The `id:` field, if any and not containing a NUL byte. */
    id?: string;
    /** The `retry:` field in milliseconds, if any and all-ASCII-digit. */
    retry?: number;
}

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

/** The `message` object embedded in a `message_start` event — a message whose content/usage are still being filled in. */
interface AnthropicStreamMessageStart {
    id: string;
    type: "message";
    role: "assistant";
    content: AnthropicContentBlock[];
    model: string;
    stopReason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
    stopSequence?: string | null;
    usage: AnthropicUsage;
}
interface AnthropicMessageStartEvent {
    type: "message_start";
    message: AnthropicStreamMessageStart;
}
/** The content block a `content_block_start` event opens at `index` — fields fill in via subsequent `content_block_delta`s. */
type AnthropicStreamContentBlockStart = {
    type: "text";
    text: string;
} | {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
};
interface AnthropicContentBlockStartEvent {
    type: "content_block_start";
    index: number;
    contentBlock: AnthropicStreamContentBlockStart;
}
type AnthropicContentBlockDelta = {
    type: "text_delta";
    text: string;
} | {
    type: "input_json_delta";
    partialJson: string;
};
interface AnthropicContentBlockDeltaEvent {
    type: "content_block_delta";
    index: number;
    delta: AnthropicContentBlockDelta;
}
interface AnthropicContentBlockStopEvent {
    type: "content_block_stop";
    index: number;
}
interface AnthropicMessageDeltaPayload {
    stopReason: string | null;
    stopSequence?: string | null;
}
/** `message_delta`'s trailing `usage` only ever carries `output_tokens` (ADR-0024a §D5 ground truth). */
interface AnthropicMessageDeltaUsage {
    outputTokens: number;
}
interface AnthropicMessageDeltaEvent {
    type: "message_delta";
    delta: AnthropicMessageDeltaPayload;
    usage?: AnthropicMessageDeltaUsage;
}
/** The wire terminal condition for a successful Anthropic Messages stream — there is no `[DONE]` sentinel. */
interface AnthropicMessageStopEvent {
    type: "message_stop";
}
/** Keepalive heartbeat. Carries no payload; recognized deliberately rather than falling back to `unknown`. */
interface AnthropicPingEvent {
    type: "ping";
}
interface AnthropicStreamErrorPayload {
    type: string;
    message: string;
}
/** A wire-level terminal error event embedded in the SSE stream itself (`data: {"type":"error","error":{...}}`). */
interface AnthropicStreamErrorEvent {
    type: "error";
    error: AnthropicStreamErrorPayload;
}
interface AnthropicReceiptEvent {
    type: "receipt";
    receipt: MetaLlmReceipt;
}
/** A syntactically valid SSE event whose payload this decoder does not recognize. Never a crash. */
interface UnknownStreamEvent$1 {
    type: "unknown";
    raw: unknown;
}
type AnthropicStreamEvent = AnthropicMessageStartEvent | AnthropicContentBlockStartEvent | AnthropicContentBlockDeltaEvent | AnthropicContentBlockStopEvent | AnthropicMessageDeltaEvent | AnthropicMessageStopEvent | AnthropicPingEvent | AnthropicStreamErrorEvent | AnthropicReceiptEvent | UnknownStreamEvent$1;
interface DecodedAnthropicSseEvent {
    events: AnthropicStreamEvent[];
    unknownFields?: Record<string, unknown>;
}
/**
 * Decode one generic {@link SseEvent} into zero or more
 * {@link AnthropicStreamEvent}s. Never throws — malformed JSON or an
 * unrecognized shape becomes an {@link UnknownStreamEvent} (same contract
 * as {@link import("./openai-events.js").decodeOpenAiSseEvent}).
 */
declare function decodeAnthropicSseEvent(raw: SseEvent): DecodedAnthropicSseEvent;

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

interface OpenAiRoleEvent {
    type: "role";
    index: number;
    role: string;
}
interface OpenAiContentDeltaEvent {
    type: "content_delta";
    index: number;
    delta: string;
}
interface OpenAiToolCallDeltaEvent {
    type: "tool_call_delta";
    index: number;
    toolCallIndex: number;
    id?: string;
    functionName?: string;
    argumentsDelta?: string;
}
interface OpenAiFinishReasonEvent {
    type: "finish_reason";
    index: number;
    finishReason: string;
}
interface OpenAiUsageEvent {
    type: "usage";
    usage: ChatCompletionUsage;
}
interface OpenAiReceiptEvent {
    type: "receipt";
    receipt: MetaLlmReceipt;
}
interface OpenAiStreamErrorPayload {
    message: string;
    type?: string;
    code?: string;
    param?: string;
}
/** A wire-level terminal error event embedded in the SSE stream itself (`data: {"error": {...}}`). */
interface OpenAiStreamErrorEvent {
    type: "error";
    error: OpenAiStreamErrorPayload;
}
/** The literal `data: [DONE]` sentinel that closes a successful OpenAI chat-completions stream. */
interface OpenAiDoneEvent {
    type: "done";
}
/** A syntactically valid SSE event whose payload this decoder does not recognize. Never a crash. */
interface UnknownStreamEvent {
    type: "unknown";
    raw: unknown;
}
type OpenAiStreamEvent = OpenAiRoleEvent | OpenAiContentDeltaEvent | OpenAiToolCallDeltaEvent | OpenAiFinishReasonEvent | OpenAiUsageEvent | OpenAiReceiptEvent | OpenAiStreamErrorEvent | OpenAiDoneEvent | UnknownStreamEvent;
interface DecodedOpenAiSseEvent {
    events: OpenAiStreamEvent[];
    unknownFields?: Record<string, unknown>;
}
/**
 * Decode one generic {@link SseEvent} into zero or more {@link OpenAiStreamEvent}s.
 * Never throws — malformed JSON or an unrecognized shape becomes an
 * {@link UnknownStreamEvent} (ADR-0024a §D5: "Unknown valid events become
 * `UnknownStreamEvent`").
 */
declare function decodeOpenAiSseEvent(raw: SseEvent): DecodedOpenAiSseEvent;

/**
 * `MetaLlmStreamEnvelope<E>` (ADR-0024a §D5's frozen streaming envelope
 * shape) plus a small optional text/tool accumulator over a
 * `chat.completions` event stream (D5 point 2: "an optional text/tool
 * accumulator over that stream").
 */

/**
 * Wraps every parsed stream event with sequencing/provenance metadata.
 * Frozen shape per ADR-0024a §D5 — do not add fields without an ADR update.
 */
interface MetaLlmStreamEnvelope<E> {
    event: E;
    /** 1-based order of this event within one logical stream call. */
    sequence: number;
    /** ISO-8601 timestamp of when this envelope was produced locally. */
    receivedAt: string;
    requestId: string;
    /** The underlying SSE `event:` field name, if any (OpenAI chat completions does not set one). */
    rawEventName?: string;
    /** Fields present on the wire payload that this decoder does not recognize — preserved losslessly. */
    unknownFields?: Record<string, unknown>;
}
/**
 * Accumulates a `chat.completions` stream's role/content/tool-call/finish/
 * usage/receipt facets into one final snapshot. Works identically whether
 * the stream ended successfully or was cut short — the caller absorbs
 * whatever envelopes were yielded before a terminal error and reads
 * `snapshot()` for the partial result (ADR-0024a §D5: partial state is
 * whatever was already delivered through normal iteration, not a
 * separately-reconstructed value).
 */
declare class ChatCompletionsStreamAccumulator {
    private role;
    private contentByIndex;
    private toolCallsByIndex;
    private finishReasonByIndex;
    private usage;
    private receipt;
    private done;
    absorb(envelope: MetaLlmStreamEnvelope<OpenAiStreamEvent>): void;
    snapshot(): {
        role?: string;
        contentByChoice: Record<number, string>;
        toolCallsByChoice: Record<number, Array<{
            id?: string;
            name?: string;
            arguments: string;
        }>>;
        finishReasonByChoice: Record<number, string>;
        usage?: ChatCompletionUsage;
        receipt?: MetaLlmReceipt;
        completed: boolean;
    };
}

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
     * `GET /v1/usage` (ADR-0024b §D1's `client.usage`, D11 migration step 1).
     * Strictly authenticated-account scoped — every query is bound to the
     * caller's own credential; there is no parameter that can select another
     * account's usage. Uses the contract's bounded `YYYY-MM` range plus
     * optional `model`/`provider`/`groupBy` grouping (§D3). An empty result
     * is returned exactly as reported — never reinterpreted as "no usage
     * anywhere" vs. "this account genuinely has none" (§D3: no speculative
     * fallback logic is layered on top).
     */
    usage(query: UsageQuery, options?: MetaLlmCallOptions): Promise<MetaLlmResult<UsageSummary>>;
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
        completionsStream: (request: ChatCompletionRequest, options?: MetaLlmCallOptions) => AsyncGenerator<MetaLlmStreamEnvelope<OpenAiStreamEvent>, void, void>;
    };
    /**
     * `POST /v1/completions` (legacy OpenAI completions). Real HTTP call
     * logic (issue #58 / M2 continuation) — this is a "direct nonstream
     * call whose accepted contract declares safe replay" per ADR-0024a §D7,
     * the same class as `chat.completions`/`messages.create`, so it reuses
     * `postJsonIdempotent` from `./nonstream.js` verbatim (idempotency-key
     * generation, bounded 429/502/503 retry, single 401-refresh).
     */
    completions(request: LegacyCompletionRequest, options?: MetaLlmCallOptions): Promise<MetaLlmResult<LegacyCompletion>>;
    readonly messages: {
        /**
         * `POST /v1/messages` (Anthropic-style). Real HTTP call logic (issue
         * #58 / M2 continuation) — see `chat.completions`'s doc comment and
         * `./nonstream.js` for the shared idempotency/retry logic.
         */
        create: (request: AnthropicMessageRequest, options?: MetaLlmCallOptions) => Promise<MetaLlmResult<AnthropicMessage>>;
        /**
         * `POST /v1/messages/count_tokens`. Same "direct nonstream call"
         * class as `messages.create` (ADR-0024a §D7) — reuses
         * `postJsonIdempotent` verbatim.
         */
        countTokens: (request: CountTokensRequest, options?: MetaLlmCallOptions) => Promise<MetaLlmResult<CountTokensResult>>;
        /**
         * `POST /v1/messages` with `stream: true` (ADR-0024a §D5). Issue #58 /
         * M2 continuation, item 2 of the tracked "what's left" list — reuses
         * the same generic SSE parser (`../sse/parser.js`) `chat.completionsStream`
         * wired up in PR #88. Returns an async generator — iterate with `for
         * await`; it completes normally only after the Anthropic wire terminal
         * condition (`message_stop`) is observed, otherwise it throws a typed
         * `AgenticError` describing why (see `./stream/messages-stream.js`).
         */
        createStream: (request: AnthropicMessageRequest, options?: MetaLlmCallOptions) => AsyncGenerator<MetaLlmStreamEnvelope<AnthropicStreamEvent>, void, void>;
    };
    /**
     * `POST /v1/responses`. Current server is stateless: callers resend
     * conversation input. `previousResponseId` is preview and MUST NOT be
     * described as recovery (ADR-0024a §D3) — this method does not restore
     * or synthesize any prior conversation state; it only sends `request`
     * as given. Real HTTP call logic (issue #58 / M2 continuation) reuses
     * `postJsonIdempotent` verbatim, same as `chat.completions`.
     */
    responses(request: ResponsesRequest, options?: MetaLlmCallOptions): Promise<MetaLlmResult<ResponsesResponse>>;
    /**
     * `POST /v1/embeddings`. Real HTTP call logic (issue #58 / M2
     * continuation) reuses `postJsonIdempotent` verbatim — infrastructure is
     * identical to the other direct nonstream operations even though
     * embeddings has its own separate maturity gate criteria in ADR-0024a
     * §D2 ("input limits, dimensions, usage, errors and auth published").
     */
    embeddings(request: EmbeddingRequest, options?: MetaLlmCallOptions): Promise<MetaLlmResult<EmbeddingResponse>>;
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

export { type AnthropicContentBlock, type AnthropicContentBlockDelta, type AnthropicContentBlockDeltaEvent, type AnthropicContentBlockStartEvent, type AnthropicContentBlockStopEvent, type AnthropicMessage, type AnthropicMessageDeltaEvent, type AnthropicMessageDeltaPayload, type AnthropicMessageDeltaUsage, type AnthropicMessageParam, type AnthropicMessageRequest, type AnthropicMessageStartEvent, type AnthropicMessageStopEvent, type AnthropicPingEvent, type AnthropicReceiptEvent, type AnthropicStreamContentBlockStart, type AnthropicStreamErrorEvent, type AnthropicStreamErrorPayload, type AnthropicStreamEvent, type AnthropicStreamMessageStart, type AnthropicToolChoice, type AnthropicToolDefinition, type AnthropicUsage, type BudgetView, type CacheMode, type CacheStats, type ChatCompletion, type ChatCompletionChoice, type ChatCompletionRequest, type ChatCompletionUsage, ChatCompletionsStreamAccumulator, type ChatContentPart, type ChatMessage, type ChatToolCall, type ChatToolChoice, type ChatToolDefinition, type CountTokensRequest, type CountTokensResult, type DecodedAnthropicSseEvent, type DecodedOpenAiSseEvent, type EmbeddingDatum, type EmbeddingRequest, type EmbeddingResponse, type EmbeddingUsage, type EscalationStrategy, type FallbackPolicy, InvalidUsageQueryError, type LegacyCompletion, type LegacyCompletionChoice, type LegacyCompletionRequest, type MetaLlmCallOptions, MetaLlmClient, type MetaLlmClientConfig, type MetaLlmHealth, type MetaLlmModelInfo, type MetaLlmModelList, type MetaLlmReceipt, type MetaLlmResponseMeta, type MetaLlmResult, type MetaLlmRoutingControls, type MetaLlmSafetyControl, type MetaLlmStreamEnvelope, type MetaLlmTelemetryEvent, type MetaLlmTelemetryHooks, type MetaLlmTransport, type MetaLlmWhoAmI, type ModelSelector, type ModelTier, type Money, type OpenAiContentDeltaEvent, type OpenAiDoneEvent, type OpenAiFinishReasonEvent, type OpenAiReceiptEvent, type OpenAiRoleEvent, type OpenAiStreamErrorEvent, type OpenAiStreamErrorPayload, type OpenAiStreamEvent, type OpenAiToolCallDeltaEvent, type OpenAiUsageEvent, type ReceiptCacheResult, type ReceiptModelTier, type ResolvedMetaLlmClientConfig, type ResponsesOutputItem, type ResponsesRequest, type ResponsesResponse, type SafetyMode, type SafetySummary, type SubTenantAttribution, type UnknownStreamEvent, UnsendableRoutingControlsError, type UsageBreakdownEntry, type UsagePeriodEntry, type UsageQuery, type UsageSummary, type UsageTotals, assertSendableRoutingControls, assertValidUsageQuery, decodeAnthropicSseEvent, decodeOpenAiSseEvent, parseMetaLlmReceipt, parseMoney, parseUsageSummary, resolveMetaLlmClientConfig };
