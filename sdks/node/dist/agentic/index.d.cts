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
 * Fail-closed error raised when a scope preflight (ADR-0022 §D5) finds a
 * credential with KNOWN granted scopes that do not include the scope an
 * operation requires. "Before a billable or mutating call, a provider with
 * known granted scopes is checked locally. Missing scope returns
 * `PermissionDeniedError` before I/O." Never raised when `grantedScopes` is
 * absent/unknown — "the SDK never guesses that a broader-looking string
 * implies permission," and equally it never guesses the opposite: an
 * unknown scope set is sent once and left to the server (§D5).
 */
declare class PermissionDeniedError extends AgenticError {
    readonly requiredScope: string;
    readonly grantedScopes: string[];
    constructor(product: string, operation: string, requiredScope: string, grantedScopes: string[], message?: string);
}
/**
 * ADR-0022 §D7 consent grant kinds. A locally recorded `ConsentGrant` names
 * exactly one of these — never a generic boolean — so consent for one kind
 * never implies another ("Consent for sponsored inference does not imply
 * cloud fallback or training contribution").
 */
type ConsentGrantKind = "sponsored_inference" | "power_saver_routing" | "cloud_fallback" | "source_upload" | "artifact_retention" | "training_data_contribution" | "external_webhook_delivery";
/**
 * A narrow, locally-recorded (or signed) consent grant (ADR-0022 §D7). The
 * grant must match product, origin, subject, and action before it satisfies
 * a gated call — the SDK never infers consent from credential presence, a
 * prior operation on another origin, environment variables, or a retry
 * policy.
 *
 * Type-only scaffolding: this module does not verify signatures or attest
 * server-persisted grants (§D7's "consequential kind" re-check requirement)
 * — it only defines the shape and the presence/expiry check that product
 * clients (starting with `MetaProxyClient`, ADR-0025a §D9) apply before a
 * gated call.
 */
interface ConsentGrant {
    kind: ConsentGrantKind;
    product: string;
    origin: string;
    subject: string;
    scope: string;
    issuedAt: string;
    /** Absent means the grant does not expire. */
    expiresAt?: string;
    /**
     * Present when the grant is signed or attested by the issuing service.
     * §D7: consequential kinds (`sponsored_inference`, `training_data_contribution`,
     * `source_upload`, `artifact_retention`, `external_webhook_delivery`)
     * require this; the low-stakes kinds (`power_saver_routing`, `cloud_fallback`)
     * may be an unsigned local record without one.
     */
    evidenceId?: string;
}
/**
 * Fail-closed error raised when a gated operation requires an ADR-0022 §D7
 * consent grant that is absent, expired, or does not match the call
 * (product/origin/subject/action). Credential presence is never a
 * substitute for consent (§D7/ADR-0025a §D9): "Headless clients return
 * `ConsentRequiredError` rather than prompt." Carries a machine-readable
 * `requiredKind` per §D7 ("Headless SDKs return `ConsentRequiredError` with
 * a machine-readable required kind").
 */
declare class ConsentRequiredError extends AgenticError {
    readonly requiredKind: ConsentGrantKind;
    constructor(product: string, operation: string, requiredKind: ConsentGrantKind, message?: string);
}
/**
 * Fail-closed error raised when a product client that excludes browser use
 * (ADR-0029 §D2 — Meta Proxy is excluded because "its loopback token, local
 * consent, process ownership, and CORS behavior are not a browser contract")
 * is constructed in a browser-like runtime. §D2: "construction MUST throw
 * `UnsupportedRuntimeError` before reading a credential, opening a socket,
 * importing an installer, or executing a process."
 */
declare class UnsupportedRuntimeError extends AgenticError {
    readonly runtime: string;
    constructor(product: string, operation: string, runtime: string, message?: string);
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
 * Concrete `CredentialProvider` for a delegated Cognitum OAuth access token
 * (ADR-0022 §D1, §D2, §D3; ADR-0024a §D8). Closes the gap left by PR #83's
 * `StaticApiKeyCredentialProvider`: ADR-0022 §D2's credential/header matrix
 * names Meta LLM as accepting "Product-declared `cog_` key OR a delegated
 * OAuth token" ("Never send both; route scope and auth method are
 * negotiated"), but until this provider, only the `cog_`-key half of that
 * row had an implementation.
 *
 * This provider does NOT implement an OAuth authorization-code/PKCE
 * browser login flow — that is out of scope here, exactly as
 * `StaticApiKeyCredentialProvider` accepts an already-resolved API key
 * rather than minting one. It accepts either:
 *
 * - an explicit, already-acquired access token (optionally with its own
 *   expiry/granted-scopes), or
 * - an injectable async `tokenProvider` callback the caller wires to their
 *   own OAuth refresh-token flow, invoked lazily on first `acquire()` and
 *   again — at most once per `acquire()` call — when the current token is
 *   expired.
 *
 * Wire scheme is `"Bearer"` (not `"X-API-Key"`), per ADR-0022 §D2's
 * "delegated OAuth token" row and ADR-0024a §D8's OAuth-uses-bearer
 * convention; `applyAuth` in `../meta-llm/nonstream.js` / `client.js`
 * already special-cases `scheme.toLowerCase() === "bearer"` to write the
 * standard `Authorization` header instead of a literal header named after
 * the scheme string, so this provider only has to supply that scheme name.
 *
 * Origin/audience/product binding mirrors
 * `StaticApiKeyCredentialProvider` exactly (ADR-0022 §D1/§D3): exact
 * string equality only, no wildcard origin or suffix matching. The
 * returned secret is wrapped in the same `RedactedSecret` type — Node
 * inspection, `JSON.stringify`, and error formatting MUST NOT reveal it.
 *
 * No HTTP request is made or shaped here — this type produces
 * credentials, it does not send them.
 */

/** Result of an {@link OAuthTokenSource} invocation. */
interface OAuthTokenSourceResult {
    accessToken: string;
    /** Absent means the token does not expire (or expiry is unknown to the caller). */
    expiresAt?: Date;
    /**
     * Scopes the identity service actually granted, if the caller's refresh
     * flow surfaces them. Left `undefined` (rather than guessed) when the
     * caller's OAuth flow doesn't expose this — ADR-0022 §D5 requires the
     * SDK never assume a broader-looking string implies permission.
     */
    grantedScopes?: string[];
}
/**
 * Caller-supplied async callback wired to an already-implemented OAuth
 * refresh-token flow. This provider calls it to obtain an initial token
 * (when no explicit `accessToken` is given) and to refresh an expired one
 * — it never performs the authorization-code/PKCE exchange itself.
 */
type OAuthTokenSource = () => Promise<OAuthTokenSourceResult>;
/** Construction-time options for {@link OAuthTokenCredentialProvider}. */
interface OAuthTokenCredentialProviderOptions {
    /** Product this provider is authoritative for (e.g. "meta-llm"). */
    product: string;
    /** Exact normalized origin this provider is bound to (ADR-0022 §D3). */
    normalizedOrigin: string;
    /** Exact audience this provider is bound to (ADR-0022 §D1). */
    audience: string;
    /**
     * An already-acquired OAuth access token. When omitted, `tokenProvider`
     * MUST be given — the provider fetches the initial token lazily, on the
     * first `acquire()` call, rather than at construction time.
     */
    accessToken?: string;
    /** Expiry of `accessToken`, if known. */
    expiresAt?: Date;
    /** Scopes granted to `accessToken`, if known (see {@link OAuthTokenSourceResult.grantedScopes}). */
    grantedScopes?: string[];
    /**
     * Injectable callback wired to the caller's own OAuth refresh-token
     * flow. Required when `accessToken` is omitted; optional (but
     * recommended) otherwise — supplying it lets an expired explicit token
     * be refreshed instead of failing closed.
     */
    tokenProvider?: OAuthTokenSource;
    /**
     * Wire scheme label surfaced on the acquired {@link Credential}.
     * Defaults to `"Bearer"` per ADR-0022 §D2 / ADR-0024a §D8 — OAuth
     * access tokens are never sent as `X-API-Key`.
     */
    scheme?: string;
}
/**
 * Concrete `CredentialProvider` wrapping one delegated Cognitum OAuth
 * access token (ADR-0022 §D1/§D2/§D3, ADR-0024a §D8). Fails closed on any
 * product, origin, or audience mismatch (mirrors
 * `StaticApiKeyCredentialProvider#assertMatch`), on an expired token with
 * no refresh callback, and on any use after `invalidate()`.
 */
declare class OAuthTokenCredentialProvider implements CredentialProvider {
    #private;
    constructor(options: OAuthTokenCredentialProviderOptions, now?: () => Date);
    /** Non-secret stable provider identity, safe to log. */
    identity(): string;
    describeAuthority(request: CredentialRequest): Promise<CredentialAuthority>;
    acquire(request: CredentialRequest): Promise<Credential>;
    invalidate(_reason: string): Promise<void>;
    private authority;
    /**
     * Fail-closed match check (ADR-0022 §D1/§D3). Exact string equality
     * only — no wildcard origin, suffix matching, or DNS-parent trust.
     */
    private assertMatch;
}

/**
 * ADR-0022 §D5 scope preflight, shared by every product client's mutating
 * request path.
 *
 * > "The SDK contract manifest maps every operation to its required
 * > scopes. Before a billable or mutating call, a provider with known
 * > granted scopes is checked locally. Missing scope returns
 * > `PermissionDeniedError` before I/O. Unknown scope sets are sent once
 * > and mapped from the server response; the SDK never guesses that a
 * > broader-looking string implies permission."
 *
 * `credential.grantedScopes === undefined` means "unknown" — the SDK does
 * not block locally and lets the server be authoritative (matches
 * `StaticApiKeyCredentialProvider`, which never sets `grantedScopes` at
 * all today). An explicit array (including an empty one) means "known",
 * and a missing required scope fails closed here, before any network I/O.
 *
 * Scopes are matched as exact contract tokens (§D5: "Wildcard
 * interpretation belongs to the identity service, not the SDK").
 */

/**
 * Throws {@link PermissionDeniedError} when `credential.grantedScopes` is
 * known (defined) and does not contain `requiredScope`. No-op — including
 * when `grantedScopes` is `undefined` — otherwise.
 */
declare function assertScopeGranted(product: string, operation: string, requiredScope: string, credential: Credential): void;

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
 * TelemetrySink / TelemetryEvent type-only stubs and safe semantic attribute
 * constants (ADR-0028 §D1, §D3). This is M6's first pass: it freezes the
 * sink contract, the event shape, and the `cognitum.*` attribute name
 * constants. Tracking issue #70 builds this out further into a real
 * emission pipeline -- trace propagation (§D2), the event/metric catalog
 * (§D4), dropped-event counting, and the content-free fallback diagnostic
 * hook all require the actual emit call sites this pass does not wire up.
 * No product client (meta_llm/meta_proxy/metaharness/harnessaas) emits
 * through this interface yet, and no OpenTelemetry adapter ships in this
 * pass.
 *
 * The one piece of real logic in this module is {@link NoopTelemetrySink}:
 * per §D1, "a no-op sink is the default" is a functional requirement, not a
 * placeholder, so it is a genuine (if trivial) implementation.
 *
 * Design decisions made in this pass where §D1 does not fully specify a
 * wire shape (recorded here since they are not literal ADR quotes):
 * - {@link TelemetrySeverity} is a conventional four-level set (`debug`,
 *   `info`, `warn`, `error`) matching common logging/OpenTelemetry severity
 *   tiers. The ADR does not enumerate exact values.
 * - {@link TraceContext} carries W3C `traceParent`/`traceState` strings
 *   (§D2's own vocabulary) so `TelemetryEvent.traceContext` has a stable
 *   optional shape for the §D2 follow-up to populate; nothing constructs a
 *   defined value in this pass.
 * - `attributes`/`measurements` are open `Record<string, unknown>` maps,
 *   matching how `ExecutionReceipt.usage` (`./receipts.ts`) already models
 *   an open, schema-free map elsewhere in this module.
 * - `TelemetrySink.flush` takes a `deadlineMs: number` (milliseconds)
 *   rather than a `Date`, so the same unit is usable verbatim across all
 *   three languages (Rust's `u64`, Python's `float` seconds would otherwise
 *   force a per-language conversion at the boundary).
 */
/** Severity of a {@link TelemetryEvent}. ADR-0028 §D1 does not specify exact values -- see the module doc comment for the design rationale. */
type TelemetrySeverity = "debug" | "info" | "warn" | "error";
/**
 * W3C trace-context carrier (ADR-0028 §D2). Optional at this layer: §D2
 * trace propagation (generating or joining `traceparent`/`tracestate`) is
 * out of scope for this pass (tracking issue #70) -- this type exists so
 * {@link TelemetryEvent.traceContext} has a stable shape for that follow-up
 * to populate.
 */
interface TraceContext {
    traceParent?: string;
    traceState?: string;
}
/**
 * A single telemetry event (ADR-0028 §D1). Per §D1, sinks receive
 * already-redacted events -- they never receive raw requests or responses
 * through this interface. `attributes`/`measurements` are open maps; the
 * §D3 attribute constants below name the stable, low-cardinality keys a
 * caller SHOULD use when populating them.
 */
interface TelemetryEvent {
    name: string;
    timestamp: string;
    severity: TelemetrySeverity;
    traceContext?: TraceContext;
    attributes: Record<string, unknown>;
    measurements: Record<string, unknown>;
}
/**
 * Optional telemetry sink boundary (ADR-0028 §D1): "The core SDK defines a
 * small optional sink rather than taking a required dependency on one
 * observability vendor." Product clients accept a `TelemetrySink`, mirroring
 * the async-method interface shape already established by
 * {@link CredentialProvider} (`./credentials.ts`).
 *
 * Per §D1, "Sink failures, timeouts, and backpressure MUST NOT fail or
 * delay the product operation; the SDK counts dropped events and may emit
 * one content-free diagnostic through a fallback hook." That call-site
 * behavior (catching an `emit`/`flush` rejection, incrementing a
 * dropped-event counter, invoking the fallback hook) requires the actual
 * emit call sites this pass does not wire up -- tracked by issue #70. This
 * interface only defines the shape implementors satisfy.
 */
interface TelemetrySink {
    /** Emits one already-redacted {@link TelemetryEvent}. */
    emit(event: TelemetryEvent): Promise<void>;
    /**
     * Flushes any buffered events. `deadlineMs` bounds how long the sink may
     * take; honoring the bound is the sink implementation's responsibility --
     * no shared timeout wrapper ships in this pass.
     */
    flush(deadlineMs: number): Promise<void>;
}
/**
 * The default sink (ADR-0028 §D1: "A no-op sink is the default."). This is
 * real, functional logic, not a placeholder: `emit` performs no I/O and
 * never rejects; `flush` resolves immediately.
 */
declare class NoopTelemetrySink implements TelemetrySink {
    emit(_event: TelemetryEvent): Promise<void>;
    flush(_deadlineMs: number): Promise<void>;
}
/** `cognitum.product` -- e.g. `meta-llm`. Cardinality rule: fixed set. */
declare const ATTR_PRODUCT = "cognitum.product";
/** `cognitum.operation` -- e.g. `chat.completions.create`. Cardinality rule: contract set. */
declare const ATTR_OPERATION = "cognitum.operation";
/** `cognitum.protocol` -- e.g. `openai-chat`. Cardinality rule: contract set. */
declare const ATTR_PROTOCOL = "cognitum.protocol";
/** `cognitum.contract.version` -- e.g. `1.2`. Cardinality rule: low. */
declare const ATTR_CONTRACT_VERSION = "cognitum.contract.version";
/** `cognitum.request.id` -- opaque UUID. Cardinality rule: trace/log only, never a metric label. */
declare const ATTR_REQUEST_ID = "cognitum.request.id";
/** `cognitum.tenant.hash` -- truncated keyed hash. Cardinality rule: trace/log only. */
declare const ATTR_TENANT_HASH = "cognitum.tenant.hash";
/** `cognitum.model.alias` -- e.g. `cognitum-auto`. Cardinality rule: public aliases only; raw provider model optional and low-cardinality guarded. */
declare const ATTR_MODEL_ALIAS = "cognitum.model.alias";
/** `cognitum.tier` -- `low`, `mid`, `high`. Cardinality rule: fixed set. */
declare const ATTR_TIER = "cognitum.tier";
/** `cognitum.routing.plane` -- `local`, `cloud`, `passthrough`, `sponsored`. Cardinality rule: fixed set; only server/proxy-reported. */
declare const ATTR_ROUTING_PLANE = "cognitum.routing.plane";
/** `cognitum.routing.reason` -- contract code. Cardinality rule: bounded enum, not free text. */
declare const ATTR_ROUTING_REASON = "cognitum.routing.reason";
/** `cognitum.cache.result` -- `hit`, `miss`, `disabled`. Cardinality rule: fixed set. */
declare const ATTR_CACHE_RESULT = "cognitum.cache.result";
/** `cognitum.operation.state` -- job/pod/batch state. Cardinality rule: product contract set. */
declare const ATTR_OPERATION_STATE = "cognitum.operation.state";
/** `cognitum.error.kind` -- common error kind. Cardinality rule: fixed set. */
declare const ATTR_ERROR_KIND = "cognitum.error.kind";
/** `cognitum.retry.count` -- integer. Cardinality rule: measurement. */
declare const ATTR_RETRY_COUNT = "cognitum.retry.count";

/**
 * W3C Trace Context parse / generate / join logic and stable span-name
 * builders (ADR-0028 §D2).
 *
 * This module ADDS real logic on top of the {@link TraceContext} carrier
 * type frozen in `./telemetry.ts` during the §D1/§D3 pass (PR #115) -- it
 * does not redefine that type. Per §D2: "Remote HTTP clients propagate W3C
 * `traceparent` and `tracestate` when enabled and when allowed by the
 * product contract... Trace context is generated or joined by the SDK but
 * never used as an authorization, tenant, idempotency, or evidence
 * identity. Untrusted server or subprocess trace values are validated
 * before joining."
 *
 * Nothing in this module performs network I/O or wires into a product
 * client's HTTP request logic (meta-llm/meta-proxy/metaharness/harnessaas)
 * -- that is explicitly out of scope for this pass, mirroring how
 * `sse/parser.ts` shipped as a protocol-agnostic core before any product
 * wired it in.
 *
 * ## W3C Trace Context spec simplifications made in this pass
 *
 * - **Version**: only `traceparent` version `"00"` is accepted. The spec's
 *   own forward-compatibility rule (Trace Context, "Versioning of
 *   traceparent") allows a higher version to append trailing fields after
 *   `trace-flags`; this SDK has no use for any such field, so rather than
 *   parse-and-ignore unknown trailing data, any non-`"00"` version (or a
 *   `traceparent` that does not split into exactly four `-`-separated
 *   fields) is treated as invalid input. Per §D2's "untrusted values must
 *   be validated before joining," {@link joinOrGenerateTraceContext} simply
 *   falls back to generating a fresh trace context in that case rather than
 *   guessing at a newer wire shape.
 * - **`tracestate`**: a "reasonably strict" validator, not the full spec.
 *   Enforced: non-empty, at most 32 members, each `key=value` pair with a
 *   key restricted to lowercase alphanumerics plus `-`/`*`/`_`/`/` (with at
 *   most one `@` tenant/vendor separator, each side non-empty) and a value
 *   restricted to printable ASCII (0x20-0x7E) excluding `,`/`=` and
 *   leading/trailing spaces. Not enforced: the spec's separate tenant-id
 *   (<=241 chars) / vendor-id (<=13 chars) length caps around `@` -- this
 *   pass uses one shared 256-char cap on each side instead.
 * - **Random source**: `node:crypto`'s `randomBytes` (already used
 *   elsewhere in this module tree, e.g. `oauth-token-provider.ts`) is a
 *   cryptographically secure OS-backed source, so generation here uses it
 *   directly -- no new dependency, and no need to fall back to a
 *   non-cryptographic PRNG (unlike the Rust SDK, where the equivalent
 *   secure-random dependency, `uuid`, is feature-gated behind product
 *   features this base module cannot depend on).
 */

/** The only `traceparent` version this implementation accepts. See the module doc comment's "Version" simplification. */
declare const TRACE_VERSION = "00";
/** Default `trace-flags` value used when this SDK generates a new trace-parent: bit 0 ("sampled") set. */
declare const DEFAULT_TRACE_FLAGS = "01";
/** Max `tracestate` list members this parser accepts (matches the W3C spec's own cap). */
declare const MAX_TRACESTATE_MEMBERS = 32;
/**
 * Parses and validates a raw `traceparent` header value (W3C Trace Context:
 * `{version}-{trace-id}-{parent-id}-{trace-flags}`, e.g.
 * `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`). Returns `null`
 * on ANY malformed input (wrong version, wrong hex-char-count, all-zero
 * trace-id or parent-id, wrong separator count, non-hex characters) --
 * never throws, matching §D2's "untrusted server or subprocess trace values
 * are validated before joining."
 */
declare function parseTraceParent(header: string): TraceContext | null;
/**
 * Generates a fresh, valid `traceparent`: a random 32-hex-char trace-id and
 * 16-hex-char parent-id (both guaranteed nonzero), `trace-flags = "01"`
 * (sampled).
 */
declare function generateTraceParent(): TraceContext;
/** One validated `tracestate` list member. */
interface TraceStateMember {
    key: string;
    value: string;
}
/**
 * Parses a raw `tracestate` header value into an ordered list of validated
 * `key=value` members (comma-separated, up to {@link MAX_TRACESTATE_MEMBERS}).
 * Returns `null` on ANY malformed input (empty, too many members, malformed
 * key/value characters) -- never throws. See the module doc comment for
 * exactly which spec details this validator simplifies.
 */
declare function parseTraceState(header: string): TraceStateMember[] | null;
/** Formats a list of `tracestate` members back into the wire string. */
declare function formatTraceState(members: TraceStateMember[]): string;
/**
 * Joins an incoming, untrusted `traceparent`/`tracestate` pair if valid, or
 * generates a fresh trace context otherwise. Per §D2: a receiving service
 * keeps the incoming trace-id but generates its own new parent-id/span-id
 * (this SDK is a new span in the same trace); `trace-flags` is reset to
 * {@link DEFAULT_TRACE_FLAGS} since this pass does not interpret or
 * propagate the incoming sampling bit. An invalid incoming `traceparent`
 * NEVER throws and NEVER gets joined -- it falls back to generation,
 * matching "untrusted server or subprocess trace values are validated
 * before joining." An invalid incoming `tracestate` is silently dropped
 * (treated as absent) rather than invalidating the whole join.
 */
declare function joinOrGenerateTraceContext(incomingTraceparentHeader?: string, incomingTracestateHeader?: string): TraceContext;
/** Builds the stable span name `cognitum.meta_llm.<operation>`. */
declare function metaLlmSpanName(operation: string): string;
/** Builds the stable span name `cognitum.meta_proxy.<operation>`. */
declare function metaProxySpanName(operation: string): string;
/** Builds the stable span name `cognitum.metaharness.<operation>`. */
declare function metaharnessSpanName(operation: string): string;
/** Builds the stable span name `cognitum.harnessaas.<operation>`. */
declare function harnessaasSpanName(operation: string): string;

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

/**
 * Deterministic JSON: recursively sorted object keys, no whitespace.
 *
 * This is the reference canonicalization for `cognitum-canonical-json-v1`,
 * shared with the Rust and Python SDKs: field names are natively camelCase
 * here (matching `ExecutionReceipt`/`LineageReference`'s TS types and
 * Rust's `#[serde(rename_all = "camelCase")]`; Python renames its
 * snake_case dataclass fields to camelCase only for this signable payload),
 * and `JSON.stringify` already renders whole-valued numbers without a
 * trailing `.0` (JS has a single `number` type) -- Rust's `serde_json` and
 * Python's `json` module both normalize their float/int-preserving output
 * to match this before canonicalizing, so no change was needed here.
 */
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

export { ATTR_CACHE_RESULT, ATTR_CONTRACT_VERSION, ATTR_ERROR_KIND, ATTR_MODEL_ALIAS, ATTR_OPERATION, ATTR_OPERATION_STATE, ATTR_PRODUCT, ATTR_PROTOCOL, ATTR_REQUEST_ID, ATTR_RETRY_COUNT, ATTR_ROUTING_PLANE, ATTR_ROUTING_REASON, ATTR_TENANT_HASH, ATTR_TIER, AgenticError, type AgenticErrorKind, type BudgetPolicy, type BuildExecutionReceiptInput, type CancellationReason, type CancellationToken, type CapabilitySet, type CapabilitySource, type ConsentGrant, type ConsentGrantKind, ConsentRequiredError, type CostFinality, type CostObservation, type Credential, type CredentialAuthority, type CredentialProvider, type CredentialRequest, type D12Category, DEFAULT_API_KEY_ENV_VAR, DEFAULT_RETRY_POLICY, DEFAULT_TRACE_FLAGS, type EventStreamOptions, type ExecutionReceipt, type IdempotencyBindingV1, type LineageChainVerification, type LineageReference, MAX_TRACESTATE_MEMBERS, NoopTelemetrySink, OAuthTokenCredentialProvider, type OAuthTokenCredentialProviderOptions, type OAuthTokenSource, type OAuthTokenSourceResult, type OnUnknownEstimate, type OperationEvent, type OperationHandle, type OperationRetryClass, type OperationSnapshot, type OperationState, type Page, type PageRequest, PermissionDeniedError, RedactedSecret, type RequestContext, type RetryPolicy, type SecretClassification, type SecretRedactor, SentinelSecretRedactor, StaticApiKeyCredentialProvider, type StaticApiKeyCredentialProviderOptions, TRACE_VERSION, type TelemetryEvent, type TelemetrySeverity, type TelemetrySink, type TenantContext, type TimeBudget, type TraceContext, type TraceStateMember, UnsupportedCapabilityError, UnsupportedRuntimeError, type VerificationLevel, type VerificationResult, type VerifyLineageChainOptions, type VerifyReceiptOptions, type WaitOptions, assertScopeGranted, buildExecutionReceipt, canonicalJson, equalJitterDelayMs, formatTraceState, generateTraceParent, harnessaasSpanName, joinOrGenerateTraceContext, metaLlmSpanName, metaProxySpanName, metaharnessSpanName, parseTraceParent, parseTraceState, sha256Hex, shapeCheckExecutionReceipt, shapeCheckLineageReference, verifyExecutionReceipt, verifyLineageChain };
