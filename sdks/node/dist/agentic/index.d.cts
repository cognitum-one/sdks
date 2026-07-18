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

/**
 * Shared agentic error taxonomy and retry classification (ADR-0023 §D1, §D3).
 * Type-only scaffolding — issue #52 / M1. No retry loop implementation ships
 * here; concrete HTTP mapping lands with each product client.
 */
/** Agentic extension of the ADR-0004 base error kind enumeration (ADR-0023 §D1). */
type AgenticErrorKind = "configuration" | "authentication" | "permission_denied" | "not_found" | "validation" | "conflict" | "rate_limited" | "budget_exceeded" | "safety_blocked" | "consent_required" | "unsupported_capability" | "protocol" | "integrity" | "isolation_unavailable" | "transport" | "deadline_exceeded" | "cancelled" | "process_failed" | "operation_failed" | "unknown";
/** Operation retry classification (ADR-0023 §D3). A status code alone is never sufficient. */
type OperationRetryClass = "safe_read" | "idempotent_mutation" | "idempotent_with_key" | "non_idempotent" | "streaming" | "local_process";
/**
 * Common failure shape shared by every agentic product (ADR-0023 §D1).
 *
 * `message`, `details`, and `cause` MUST be redacted by the caller before
 * this type is constructed for exposure — this base class does not perform
 * redaction itself (see `SecretRedactor` in `./credentials.js` for that
 * contract).
 */
declare class AgenticError extends Error {
    readonly kind: AgenticErrorKind;
    readonly product?: string;
    readonly operation?: string;
    readonly status?: number;
    readonly code?: string;
    readonly requestId?: string;
    readonly correlationId?: string;
    readonly protocolVersion?: string;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;
    readonly attemptCount?: number;
    readonly details?: unknown;
    /**
     * Underlying cause of this error, wired through to the native ES2022
     * `Error.cause` (this repo requires Node >=18, which supports it).
     * Mirrors Python's `cause: BaseException | None` (wired to
     * `self.__cause__`) and Rust's `cause: Option<String>` (FIX 2 of the M1
     * cross-language consistency review — Node previously had no equivalent
     * field).
     */
    readonly cause?: unknown;
    constructor(kind: AgenticErrorKind, message: string, fields?: Partial<Omit<AgenticError, "kind" | "message" | "name" | "retryable"> & {
        retryable: boolean;
    }>);
}
/**
 * Fail-closed error raised when a required capability is absent or unknown
 * (ADR-0019 §D6). MUST be raised before any spend, mutation, consent, or
 * code-execution side effect.
 */
declare class UnsupportedCapabilityError extends AgenticError {
    readonly capability: string;
    constructor(product: string, operation: string, capability: string, message?: string);
}
/**
 * Retry-policy shape (ADR-0023 §D4). Values MUST match ADR-0005's
 * equal-jitter formula verbatim; agentic modules MUST NOT diverge from it.
 */
interface RetryPolicy {
    baseMs: number;
    capMs: number;
    maxAttempts: number;
    retrySleepBudgetMs: number;
}
/** Canonical defaults: 500 ms base, 30 s cap, 4 total attempts, 60 s sleep budget. */
declare const DEFAULT_RETRY_POLICY: RetryPolicy;
/**
 * Pure equal-jitter backoff calculation, ADR-0005/ADR-0023 verbatim:
 *
 * ```text
 * delay_ms(attempt) = min(cap_ms, max(server_hint_ms, base_ms * 2**attempt + jitter))
 * ```
 *
 * `jitterMs` is caller-injected (rather than internally randomized) so
 * cross-language conformance fixtures can assert exact values with a fixed
 * seed, per ADR-0023's compliance note on injected clocks/randomness.
 */
declare function equalJitterDelayMs(attempt: number, policy?: RetryPolicy, serverHintMs?: number, jitterMs?: number): number;
/** Idempotency-key binding contract (ADR-0023 §D5). */
interface IdempotencyBindingV1 {
    authenticatedPrincipal: string;
    tenantContext?: string;
    delegatedSubtenantContext?: string;
    httpMethod: string;
    normalizedRouteIdentity: string;
    canonicalRequestSha256: string;
    idempotencyKey: string;
    contractMajor: number;
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
/** Coarse secret-classification tiers used to drive redaction (ADR-0022 §D10). */
type SecretClassification = "secret" | "sensitive" | "public";
/**
 * Applies recursive, schema- and key-name-based redaction to a value before
 * it is formatted or handed to a caller telemetry hook (ADR-0022 §D10). No
 * concrete implementation ships in this pass — lands in issue #54.
 */
interface SecretRedactor {
    classify(fieldName: string, value: unknown): SecretClassification;
    redact<T>(value: T): T;
}

/**
 * Concrete `CredentialProvider` for a static Cognitum-cloud API key
 * (ADR-0022 §D1, §D2, §D3). Issue #53 / M1 follow-up — the frozen
 * `CredentialProvider` contract from issue #52 (`./credentials.js`) gets its
 * first real implementation here.
 *
 * This wraps a caller-supplied API key (or `COGNITUM_API_KEY`, matching the
 * resolution order already used by `HttpClient.resolveApiKey` in
 * `../client.js` and codified in ADR-0003 §"Credential provisioning") and
 * hands it out only for the exact `product` / `normalizedOrigin` /
 * `audience` the provider was constructed for (ADR-0022 §D1/§D3: "The
 * provider MUST refuse an audience or origin mismatch" / "Credential
 * providers are bound to the normalized origin selected during client
 * construction. A redirect to another origin is not followed with
 * credentials."). There is no wildcard origin or suffix matching — every
 * check below is exact string equality.
 *
 * No HTTP request is made or shaped here — this type produces credentials,
 * it does not send them.
 */

/** Canonical env var per ADR-0003 §"Credential provisioning" / `../client.js`. */
declare const DEFAULT_API_KEY_ENV_VAR = "COGNITUM_API_KEY";
/** Construction-time options for {@link StaticApiKeyCredentialProvider}. */
interface StaticApiKeyCredentialProviderOptions {
    /** Product this provider is authoritative for (e.g. "cognitum-cloud"). */
    product: string;
    /** Exact normalized origin this provider is bound to (ADR-0022 §D3). */
    normalizedOrigin: string;
    /** Exact audience this provider is bound to (ADR-0022 §D1). */
    audience: string;
    /**
     * Explicit API key. When omitted, resolved from `envVar`
     * (default {@link DEFAULT_API_KEY_ENV_VAR}) per ADR-0003's resolution
     * order: explicit arg, then environment variable, then fail at
     * construction time.
     */
    apiKey?: string;
    /** Override the environment variable name checked when `apiKey` is omitted. */
    envVar?: string;
    /**
     * Wire scheme label surfaced on the acquired {@link Credential}.
     * Defaults to `"X-API-Key"`, the canonical cloud header per ADR-0003.
     */
    scheme?: string;
    /** Injectable environment map, for testing. Defaults to `process.env`. */
    env?: Record<string, string | undefined>;
}
/**
 * Concrete `CredentialProvider` wrapping one static Cognitum-cloud API key
 * (ADR-0022 §D1/§D2/§D3). Fails closed on any product, origin, or audience
 * mismatch — see {@link StaticApiKeyCredentialProvider#assertMatch}.
 */
declare class StaticApiKeyCredentialProvider implements CredentialProvider {
    #private;
    constructor(options: StaticApiKeyCredentialProviderOptions);
    /** Non-secret stable provider identity, safe to log. */
    identity(): string;
    describeAuthority(request: CredentialRequest): Promise<CredentialAuthority>;
    acquire(request: CredentialRequest): Promise<Credential>;
    invalidate(_reason: string): Promise<void>;
    private authority;
    /**
     * Fail-closed match check (ADR-0022 §D1/§D3). Exact string equality only
     * — no wildcard origin, suffix matching, or DNS-parent trust.
     */
    private assertMatch;
}

/**
 * Concrete `SecretRedactor` implementation — the sentinel scan defined by
 * ADR-0028 §D13, driven by ADR-0022 §D10 classification and the D12
 * category list. Closes issue #54.
 *
 * Faithful to D13's exact mechanism (see docs/adr/0028-...-redaction.md):
 *
 *   1. A key-name check against the D12 category list runs first — a value
 *      can be sensitive purely because of the field it lives in, regardless
 *      of shape.
 *   2. Fixed-format matchers (bearer token, JWT, PEM private-key block,
 *      cloud-provider access-key pattern, pre-signed URL query parameter)
 *      run next.
 *   3. A Shannon-entropy fallback over a contiguous token of >= 20 characters
 *      runs ONLY if no fixed-format matcher hit — a match is classified by
 *      pattern first, entropy only as a fallback. The threshold is scoped to
 *      the token's actual character set rather than one global cutoff: a
 *      16-symbol hex-only token (max possible entropy log2(16) = 4.0 bits/
 *      char) uses a 3.0 bits/char threshold, since real hex-encoded secrets
 *      never approach the unreachable theoretical max (empirically 3.4-3.9
 *      bits/char for 32/64-char hex tokens); a broader alphanumeric/
 *      base64-like token keeps the original 4.0 bits/char threshold. This is
 *      the same charset-scoped-threshold technique used by detect-secrets /
 *      truffleHog.
 *   4. Traversal is a bounded-depth-8 DFS: a value reached at depth 9 or
 *      deeper is replaced with `[max-depth-exceeded]` without further
 *      recursion. Cycles are broken by an object-identity ancestor set and
 *      replaced with `[cyclic-reference]`. Matches are replaced with
 *      `[redacted:<category>]`, where `<category>` is a D12 category name,
 *      or `secret-pattern` / `high-entropy` for value-only matches.
 */

/** D12/D13 category list consulted by the key-name check. */
type D12Category = "prompts" | "messages" | "tool-arguments-results" | "source" | "repository-urls" | "patches" | "credentials" | "environment-values" | "webhook-bodies" | "signed-urls" | "raw-tenant-user-identifiers";
/**
 * Concrete `SecretRedactor` (ADR-0022 §D1/§D10) implementing the exact
 * sentinel-scan mechanism specified by ADR-0028 §D13.
 */
declare class SentinelSecretRedactor implements SecretRedactor {
    #private;
    classify(fieldName: string, value: unknown): SecretClassification;
    redact<T>(value: T): T;
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
 * OperationHandle / OperationState and transport-neutral pagination /
 * event-stream primitives (ADR-0019 §D5, ADR-0023 §D9). Type-only
 * scaffolding — issue #52 / M1. No polling loop or event-stream
 * implementation ships in this pass.
 */

/** Native lifecycle states for a durable remote operation (ADR-0023 §D9). */
type OperationState = "pending" | "running" | "approval_required" | "completed" | "failed" | "cancelled" | "cancellation_requested";
/** A point-in-time view of a durable operation, including terminal failures. */
interface OperationSnapshot<TResult = unknown> {
    id: string;
    state: OperationState;
    result?: TResult;
    error?: AgenticError;
    updatedAt: string;
}
/** Options controlling {@link OperationHandle.wait}. */
interface WaitOptions {
    waitDeadlineMs?: number;
    pollIntervalMs?: number;
}
/** Options controlling {@link OperationHandle.events}. */
interface EventStreamOptions {
    lastEventId?: string;
    idleTimeoutMs?: number;
}
/** A single durable-operation event (ADR-0023 §D6). */
interface OperationEvent<TPayload = unknown> {
    id: string;
    type: string;
    sequence?: number;
    occurredAt: string;
    payload: TPayload;
}
/**
 * Common handle contract for remote batches, pods, and HarnessaaS jobs
 * (ADR-0023 §D9). `events` is only present when the product capability set
 * declares event-stream support — see ADR-0019 §D6.
 *
 * `cancel` is always present but MUST fail closed — implementations that
 * don't support cancellation MUST reject with `UnsupportedCapabilityError`
 * (see `./errors.js`) rather than omitting the method or silently no-oping
 * (FIX 4 of the M1 cross-language consistency review, per ADR-0019 §D6's
 * fail-closed philosophy; Rust's default `OperationHandle::cancel` already
 * does this and is the reference behavior).
 */
interface OperationHandle<TResult = unknown> {
    readonly id: string;
    readonly product: string;
    readonly originBinding: string;
    readonly tenantBinding?: string;
    readonly createdAt: string;
    get(): Promise<OperationSnapshot<TResult>>;
    wait(options?: WaitOptions): Promise<OperationSnapshot<TResult>>;
    events?(options?: EventStreamOptions): AsyncIterable<OperationEvent>;
    cancel(): Promise<OperationSnapshot<TResult>>;
    result(): Promise<TResult>;
}
/** Cursor-based page request, independent of transport (HTTP query, RPC field, etc.). */
interface PageRequest {
    cursor?: string;
    limit?: number;
}
/** A single page of results. */
interface Page<T> {
    items: T[];
    nextCursor?: string;
    hasMore: boolean;
}

/**
 * ExecutionReceipt / LineageReference type-only stubs (ADR-0028 §D7, §D9).
 * Tracking issue #56 builds these out further (verification, canonical
 * bytes, signature checks). This pass only freezes the field shapes.
 */
/** Ordered guarantee levels for any artifact/witness/receipt/lineage check (ADR-0028 §D8). */
type VerificationLevel = "none" | "shape" | "digest" | "cryptographic" | "anchored";
/** Tagged verification outcome. `valid=true` at `shape` MUST NOT satisfy a `cryptographic` requirement. */
interface VerificationResult {
    level: VerificationLevel;
    valid: boolean;
    algorithm?: string;
    keyId?: string;
    checkedAt: string;
    subjectDigest?: string;
    warnings?: string[];
    failure?: string;
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
/** Verifiable common receipt envelope, v1 (ADR-0028 §D7). Type-only stub — issue #56. */
interface ExecutionReceipt {
    schema: "cognitum.execution-receipt.v1";
    receiptId: string;
    product: string;
    contractVersion: string;
    subject: {
        requestId: string;
        operationId?: string;
        tenantHash?: string;
    };
    startedAt: string;
    completedAt?: string;
    usage?: Record<string, unknown>;
    costs: CostObservation[];
    outcome: string;
    artifactDigests?: string[];
    lineageRoot?: string;
    canonicalization?: string;
    issuer?: string;
    keyId?: string;
    signature?: string;
    verification: VerificationResult;
}
/** Verifiable lineage proof reference, v1 (ADR-0028 §D9). Type-only stub — issue #56. */
interface LineageReference {
    schema: "cognitum.lineage-reference.v1";
    subject: {
        requestId: string;
        operationId?: string;
    };
    leaf?: string;
    root?: string;
    sequence?: number;
    previousCheckpoint?: string;
    checkpointTime?: string;
    canonicalization?: string;
    issuer?: string;
    keyId?: string;
    signature?: string;
    verification: VerificationResult;
}

/**
 * ExecutionReceipt / LineageReference construction + verification (issue #56,
 * building out the ADR-0028 §D7-§D9 type-only stubs from PR #79).
 *
 * Deliberate scope limits (documented rather than silently skipped):
 * - Signatures are HMAC-SHA256 (symmetric, caller-supplied key resolver),
 *   not asymmetric Ed25519. ADR-0028 §D7 asks for "a discoverable, rotatable
 *   verification key" without mandating an algorithm; a full asymmetric PKI
 *   (key discovery/rotation service) is out of scope for this pass.
 * - `anchored` (§D8) requires an externally durable checkpoint/proof. This
 *   module only calls an optional caller-supplied `checkAnchor` callback; it
 *   does not implement or assume any specific anchor/ledger service.
 * - Checkpoint "freshness" (§D9) is a parseable-timestamp + optional
 *   max-age check, not a live clock-skew/NTP protocol.
 */

/** Deterministic JSON: recursively sorted object keys, no whitespace. */
declare function canonicalJson(value: unknown): string;
declare function sha256Hex(bytes: string): string;
interface BuildExecutionReceiptInput {
    receiptId: string;
    product: string;
    contractVersion: string;
    requestId: string;
    operationId?: string;
    tenantHash?: string;
    startedAt: string;
    completedAt?: string;
    usage?: Record<string, unknown>;
    costs?: CostObservation[];
    outcome: string;
    artifactDigests?: string[];
    lineageRoot?: string;
    issuer?: string;
    keyId?: string;
    /** Optional signer; if supplied, signs the canonical (unsigned) payload. */
    sign?: (canonicalBytes: string) => string;
    now?: () => string;
}
/** Builds an ExecutionReceiptV1 from operation metadata, usage/cost, and timestamps. */
declare function buildExecutionReceipt(input: BuildExecutionReceiptInput): ExecutionReceipt;
declare function shapeCheckExecutionReceipt(r: ExecutionReceipt): string | undefined;
declare function shapeCheckLineageReference(l: LineageReference): string | undefined;
interface VerifyReceiptOptions {
    minLevel: VerificationLevel;
    /** Independently obtained expected digest, for `digest`-level checks. */
    expectedDigest?: string;
    /** Resolves a trusted key for (issuer, keyId); absence means "no proof possible". */
    resolveKey?: (issuer: string, keyId: string) => Uint8Array | undefined;
    /** Optional external durability/anchor check for `anchored`. */
    checkAnchor?: (lineageRoot: string) => boolean;
    now?: () => string;
}
/** Verifies a receipt against a minimum required VerificationLevel (fail-closed). */
declare function verifyExecutionReceipt(receipt: ExecutionReceipt, opts: VerifyReceiptOptions): VerificationResult;
interface VerifyLineageChainOptions {
    minLevel: VerificationLevel;
    resolveKey?: (issuer: string, keyId: string) => Uint8Array | undefined;
    maxCheckpointAgeMs?: number;
    now?: () => string;
}
interface LineageChainVerification {
    valid: boolean;
    level: VerificationLevel;
    brokenAtIndex?: number;
    results: VerificationResult[];
    failure?: string;
}
/**
 * Verifies a LineageReference chain is well-formed: each entry's
 * `previousCheckpoint` resolves to the prior entry's `root`, sequence numbers
 * strictly increase, and no `root` digest repeats (cycle detection). This is
 * a structural check (§D9), not a full Merkle/anchored proof.
 */
declare function verifyLineageChain(chain: LineageReference[], opts: VerifyLineageChainOptions): LineageChainVerification;

export { AgenticError, type AgenticErrorKind, type BudgetPolicy, type BuildExecutionReceiptInput, type CancellationReason, type CancellationToken, type CapabilitySet, type CapabilitySource, type CostFinality, type CostObservation, type Credential, type CredentialAuthority, type CredentialProvider, type CredentialRequest, type D12Category, DEFAULT_API_KEY_ENV_VAR, DEFAULT_RETRY_POLICY, type EventStreamOptions, type ExecutionReceipt, type IdempotencyBindingV1, type LineageChainVerification, type LineageReference, type OnUnknownEstimate, type OperationEvent, type OperationHandle, type OperationRetryClass, type OperationSnapshot, type OperationState, type Page, type PageRequest, RedactedSecret, type RequestContext, type RetryPolicy, type SecretClassification, type SecretRedactor, SentinelSecretRedactor, StaticApiKeyCredentialProvider, type StaticApiKeyCredentialProviderOptions, type TenantContext, type TimeBudget, UnsupportedCapabilityError, type VerificationLevel, type VerificationResult, type VerifyLineageChainOptions, type VerifyReceiptOptions, type WaitOptions, buildExecutionReceipt, canonicalJson, equalJitterDelayMs, sha256Hex, shapeCheckExecutionReceipt, shapeCheckLineageReference, verifyExecutionReceipt, verifyLineageChain };
