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
 * MetaProxyClient construction and deployment ownership (ADR-0025a §D3).
 *
 * Type-only scaffolding plus construction-time validation for issue #61 /
 * M3 start. Construction performs NO I/O — see {@link MetaProxyClient} in
 * `./client.js` for the first real HTTP-backed operations (`status`,
 * `capabilities`).
 *
 * Unlike `MetaLlmClient` (ADR-0024a), which talks directly to Cognitum's
 * cloud service and therefore requires an explicit HTTPS origin with no
 * built-in default, `MetaProxyClient` talks to an ALREADY-RUNNING local
 * Meta Proxy sidecar process. Per ADR-0025a's Context section, the Rust
 * foreground binary "binds to `127.0.0.1:11435` by default" — so this
 * client's `origin` defaults to that literal loopback address rather than
 * requiring the caller to supply one, and literal loopback is the only
 * origin considered safe by default (ADR-0025a §D10: "Literal loopback is
 * the only stable origin"). This module does NOT install, start, or
 * reconfigure that process — see ADR-0025b's `MetaProxyManager` for that
 * (owned separately, and independent of this client per §D1's decision).
 */

/** Default loopback origin — matches the Rust proxy binary's default bind (ADR-0025a Context). */
declare const DEFAULT_META_PROXY_ORIGIN = "http://127.0.0.1:11435";
/** A single telemetry observation emitted around one MetaProxyClient operation. */
interface MetaProxyTelemetryEvent {
    operation: string;
    requestId: string;
    httpStatus?: number;
    durationMs?: number;
    retryAfterMs?: number;
}
/**
 * Caller-supplied telemetry hooks (ADR-0028), matching `MetaLlmClient`'s
 * convention (`../meta-llm/config.js`). Hooks MUST NOT receive secrets.
 */
interface MetaProxyTelemetryHooks {
    onRequestStart?(event: Pick<MetaProxyTelemetryEvent, "operation" | "requestId">): void;
    onRequestEnd?(event: MetaProxyTelemetryEvent): void;
}
/**
 * Fetch-compatible transport hook, injectable for tests. Defaults to
 * `globalThis.fetch`, matching `MetaLlmClient`'s `MetaLlmTransport`.
 */
type MetaProxyTransport = typeof fetch;
/**
 * Construction config for {@link MetaProxyClient} (ADR-0025a §D3).
 *
 * D6 (authentication and workload capabilities) is explicitly deferred —
 * this pass accepts only the same shared `CredentialProvider` contract
 * (ADR-0022) that `MetaLlmClient` uses, standing in for D3's
 * `local_credential_provider` field. `ProxyCredential`'s
 * `LocalBearerToken | WorkloadCapability` discriminated union and
 * capability minting via an injected `MetaProxyLifecycleProvider` are
 * follow-up work (§D6, ADR-0025b, ADR-0026a).
 */
interface MetaProxyClientConfig {
    /**
     * Loopback origin for the already-running Meta Proxy sidecar. Defaults to
     * {@link DEFAULT_META_PROXY_ORIGIN} when omitted (ADR-0025a §D3, Context).
     */
    origin?: string;
    /**
     * Opt out of the loopback-only requirement. Dangerous preview per
     * ADR-0025a §D10 ("Non-loopback use remains dangerous preview and
     * requires a separate TLS, remote identity, firewall, restricted CORS,
     * and exposure contract") — never set this against a real deployment.
     */
    allowNonLoopback?: boolean;
    /**
     * Local credential provider (ADR-0025a §D3: "It receives its local
     * credential from the typed provider in ADR-0022"). Required for
     * `status()`/`capabilities()` — the Proxy's `/status` route is
     * authenticated (ADR-0025a Context: "`GET /status` | Authenticated local
     * runtime and routing state").
     */
    localCredentialProvider?: CredentialProvider;
    transport?: MetaProxyTransport;
    defaultRequestContext?: Partial<RequestContext>;
    budgetPolicy?: BudgetPolicy;
    /**
     * Expected Proxy product version, checked against `MetaProxyStatus`'s
     * `compatibleSdkRange`/`productVersion` (ADR-0025a §D2: "Unknown versions
     * receive a minimum-safe set"). A mismatch surfaces as a
     * `MetaProxyResponseMeta.warnings` entry rather than a hard failure —
     * the exact compatibility-range semantics are D11 GA-gate work, not yet
     * published (ADR-0025a §D11 gate #2).
     */
    expectedProxyVersion?: string;
    /**
     * Static compatibility-table entry consulted by `capabilities()`
     * alongside the real `/status` call (ADR-0025a §D4: "Until then it uses
     * exact tested `/status` schema plus ADR-0020's pinned compatibility
     * table").
     */
    capabilitiesSnapshot?: CapabilitySet;
    telemetry?: MetaProxyTelemetryHooks;
}
/** Normalized, defaulted construction state held by {@link MetaProxyClient}. */
interface ResolvedMetaProxyClientConfig extends MetaProxyClientConfig {
    origin: string;
}
/** Test-only hook to reset the one-shot warning latch between test cases. */
declare function __resetMetaProxyNonLoopbackWarnLatch(): void;
/**
 * Defense-in-depth gate for the BEARER-ATTACHMENT path (ADR-0025a §D6/§D10:
 * "The bearer is sent only to literal loopback through a direct transport").
 * `resolveMetaProxyClientConfig` already rejects a non-loopback origin at
 * construction unless `allowNonLoopback` is set, so a client whose origin is
 * non-loopback but whose `allowNonLoopback` is falsy is structurally
 * unreachable — this re-check exists so the credential is never attached
 * without that invariant being re-proven at request time, not to be reached
 * in normal operation. Returns `true` when it is safe to attach a bearer.
 */
declare function isBearerAttachmentAllowed(origin: string, allowNonLoopback: boolean | undefined): boolean;
/**
 * Validate and normalize a {@link MetaProxyClientConfig}. Pure function, no
 * I/O — construction MUST stay side-effect free (ADR-0025a §D1: "Construction
 * never starts, installs, authenticates, probes, or reconfigures a process.").
 */
declare function resolveMetaProxyClientConfig(config?: MetaProxyClientConfig): ResolvedMetaProxyClientConfig;

/**
 * Status, capabilities, and plane-evidence wire types (ADR-0025a §D4).
 *
 * No service-owned OpenAPI contract exists yet for `/status` (§D11 gate #1
 * is not yet published), so `MetaProxyStatus` stays intentionally
 * permissive (`raw` passthrough for unrecognized fields), matching the same
 * convention `MetaLlmClient`'s discovery types use
 * (`../meta-llm/discovery.js`) for the same reason.
 *
 * `RoutingPlane` and `WorkloadPolicy` are formally defined in §D5 (data-plane
 * and policy model), which is explicitly OUT of scope for this pass — they
 * are declared here only because §D4's `MetaProxyStatus.configuredPlane` /
 * `selectedPlane` / `workloadPolicy` fields reference them. No routing,
 * consent, or plane-selection LOGIC from §D5 is implemented here.
 */
/**
 * The plane an inference request is (or would be) routed through
 * (ADR-0025a §D5). Reference-only in this pass — no plane-selection logic
 * is implemented; `MetaProxyStatus` fields that carry a plane are typed as
 * plain `string` (see its doc comment) rather than this union, consistent
 * with "no contract yet" fields elsewhere.
 */
type RoutingPlane = "local" | "cognitum_cloud" | "anthropic_passthrough" | "sponsored_cognitum";
/** Workload urgency classification (ADR-0025a §D5). Reference-only this pass. */
type WorkloadPolicy = "critical" | "standard" | "economy";
/**
 * `status()` response (ADR-0025a §D4). `configuredPlane`/`selectedPlane`/
 * `workloadPolicy` are typed as plain `string` rather than the
 * {@link RoutingPlane}/{@link WorkloadPolicy} unions above — the Proxy's
 * `/status` route has no published OpenAPI contract yet (§D11 gate #1), so
 * this stays permissive rather than pretending to validate a contract that
 * does not exist, matching `MetaLlmHealth`'s precedent
 * (`../meta-llm/discovery.js`). Values SHOULD be one of the documented
 * constants but the SDK does not reject an unrecognized one — it surfaces
 * it verbatim and lets the caller decide.
 */
interface MetaProxyStatus {
    productVersion: string;
    protocolVersion?: string;
    /** SDK/protocol compatibility range, format not yet contracted (§D11 gate #2). */
    compatibleSdkRange?: string;
    processState: string;
    /** The loopback `host:port` the Proxy is bound to. */
    bind?: string;
    configuredPlane: string;
    selectedPlane: string;
    routingReason?: string;
    automaticUsageState?: string;
    utilization?: number;
    resetAt?: string;
    workloadPolicy?: string;
    sponsoredAvailable?: boolean;
    cloudCredentialSource?: string;
    limitations: string[];
    requestId: string;
    /** Unrecognized fields from the server response, preserved verbatim. */
    raw?: Record<string, unknown>;
}
/**
 * Plane-routing evidence attached to an inference response or terminal
 * stream event (ADR-0025a §D4). Reserved for §D7 (inference/forwarding
 * contract) — `status()`/`capabilities()` in this pass never construct
 * one, since a routing receipt describes an inference call's plane
 * selection, which does not exist yet. Declared now so §D4's full contract
 * is represented in the type system ahead of §D7 landing.
 */
interface MetaProxyRoutingReceipt {
    requestId: string;
    configuredPlane: string;
    selectedPlane: string;
    routingReason?: string;
    automatic: boolean;
    workloadPolicy?: string;
    consentEvidenceId?: string;
    upstreamReceipt?: unknown;
    localUsage?: Record<string, unknown>;
    degraded: boolean;
    warnings?: string[];
}

/**
 * Result and metadata envelope (ADR-0025a §D3).
 *
 * Deliberately its OWN shape rather than a reuse of `MetaLlmResult`
 * (`../meta-llm/envelope.js`) — ADR-0025a §D3 specifies distinct fields
 * (`productVersion`, `routingReceipt`, `upstreamReceipt`) that `MetaLlmResult`
 * does not have, reflecting that every Proxy response must be able to carry
 * plane-routing evidence (§D4) that a direct Meta LLM response never needs.
 */

/**
 * Placeholder for an upstream (Cognitum-cloud) receipt forwarded through the
 * Proxy (ADR-0025a §D7, deferred). Kept as `unknown` rather than
 * `Record<string, unknown>` so callers cannot treat an absent receipt as a
 * shaped, empty object — same rationale as `MetaLlmReceipt`.
 */
type MetaProxyUpstreamReceipt = unknown;
/** Per-response metadata carried alongside every {@link MetaProxyResult} (ADR-0025a §D3). */
interface MetaProxyResponseMeta {
    requestId: string;
    productVersion?: string;
    protocolVersion?: string;
    httpStatus: number;
    /**
     * Seconds until retry is safe, per the standard `Retry-After` semantics —
     * note this is `retryAfter`, NOT `retryAfterMs` like `MetaLlmResponseMeta`
     * (ADR-0025a §D3 names the field `retry_after`, without a `_ms` suffix).
     */
    retryAfter?: number;
    /**
     * Plane-routing evidence for this response (ADR-0025a §D4). Populated
     * once inference operations exist (§D7) — `status()`/`capabilities()`
     * this pass do not attach one, since routing receipts describe an
     * inference call's plane selection, not the status endpoint itself.
     */
    routingReceipt?: MetaProxyRoutingReceipt;
    upstreamReceipt?: MetaProxyUpstreamReceipt;
    warnings?: string[];
    unknownHeaders?: Record<string, string>;
}
/** Envelope wrapping every MetaProxyClient operation result (ADR-0025a §D3). */
interface MetaProxyResult<T> {
    data: T;
    meta: MetaProxyResponseMeta;
}

/**
 * Data-plane routing intent and decode-time verification (ADR-0025a §D5).
 *
 * This module carries the caller's *supported intent* and verifies the
 * Proxy's decision against it — it deliberately does NOT implement a router.
 * ADR-0025a §D5: "The SDK communicates supported intent and verifies the
 * decision; it does not implement another router." There is no planner, no
 * plane selector, and no failover logic here; the Proxy owns all of that.
 *
 * `RoutingPlane` / `WorkloadPolicy` are re-exported from `./status.js` (where
 * §D4 already needed them for `MetaProxyStatus`) rather than redeclared, so
 * the union types have exactly one definition across the module.
 */

/**
 * A consent grant is an opaque ADR-0022 grant identifier — the SDK treats it
 * as a bare string ID and does not interpret its structure (ADR-0025a §D9
 * owns consent semantics; this pass only forwards intent).
 */
type ConsentGrantId = string;
/**
 * Supported routing intent a caller attaches to an inference call
 * (ADR-0025a §D5). The Proxy is the authority; the SDK sends this as intent
 * and verifies the returned receipt against it (see
 * {@link assertRoutingReceiptMatchesIntent}). None of these fields cause the
 * SDK to *choose* a plane.
 */
interface RoutingIntent {
    /**
     * If set, the returned receipt's `selectedPlane` MUST equal this or the
     * call is a protocol violation "even if output succeeds" (ADR-0025a §D5
     * rule 7). Verified at decode time by
     * {@link assertRoutingReceiptMatchesIntent}.
     */
    requiredPlane?: RoutingPlane;
    /** Planes the caller will accept. Advisory intent — the Proxy enforces. */
    allowedPlanes: RoutingPlane[];
    /** Workload urgency class (ADR-0025a §D5). `critical` suppresses automatic failover. */
    workloadPolicy: WorkloadPolicy;
    /** Ceiling the caller is willing to route under, when the Proxy exposes utilization. */
    maxUtilization?: number;
    /** Opaque ADR-0022 consent grant IDs relevant to this call (ADR-0025a §D5/§D9). */
    consentGrants: ConsentGrantId[];
    /** Whether the caller opts into training contribution (reported without content, §D9). */
    trainingShare: boolean;
    /** If true, the Proxy must fail rather than silently degrade to another plane (§D5 rule 5). */
    failIfUnavailable: boolean;
}
/**
 * The single decode-time verification §D5 mandates (rule 7): a
 * `requiredPlane` that the returned receipt contradicts is a protocol
 * violation, non-retryable, and MUST throw even when the HTTP call itself
 * was a well-formed 200. This is the SDK's *only* routing "decision" — a
 * pure after-the-fact check, never a selection.
 *
 * Throws {@link AgenticError} `kind: "protocol"` when:
 *  - `intent.requiredPlane` is set and no receipt was returned to verify
 *    against (§D4: "Every inference must return selected-plane evidence"), or
 *  - the receipt's `selectedPlane` does not equal `intent.requiredPlane`.
 *
 * A no-op when `intent` is undefined or carries no `requiredPlane`.
 */
declare function assertRoutingReceiptMatchesIntent(intent: RoutingIntent | undefined, receipt: MetaProxyRoutingReceipt | undefined): void;

/**
 * Proxy authentication credentials (ADR-0025a §D6).
 *
 * Two variants exist in the contract: `LocalBearerToken` (the raw local proxy
 * bearer) and `WorkloadCapability` (a minted `mh1.<payload>.<hmac>` scoped
 * capability). This pass ships ONLY the local-bearer variant as constructable
 * — {@link LocalBearerTokenCredentialProvider}. The `WorkloadCapability`
 * variant is TYPE-ONLY: minting requires an injected `MetaProxyLifecycleProvider`
 * (ADR-0025b) and its MetaHarness-backed adapter (ADR-0026a), neither of which
 * exists in this codebase yet, so there is deliberately no constructor,
 * factory, or minting function for it here (ADR-0025a §D6: "The SDK may
 * validate non-secret claims but does not mint capabilities itself").
 *
 * The secret itself is never reinvented — a resolved credential rides the
 * existing ADR-0022 `Credential` / `RedactedSecret` contract from
 * `../agentic/index.js`, exactly like `StaticApiKeyCredentialProvider`.
 */

/**
 * Env var the local bearer is read from when no explicit `token` is passed —
 * mirrors `StaticApiKeyCredentialProvider`'s `COGNITUM_API_KEY` resolution
 * order (explicit arg, then env var, then fail at construction time).
 */
declare const DEFAULT_META_PROXY_TOKEN_ENV_VAR = "COGNITUM_META_PROXY_TOKEN";
/**
 * The raw local proxy bearer (ADR-0025a §D6). Sent only to literal loopback
 * through a direct transport; never substituted with cloud, OAuth, sponsor,
 * or provider credentials.
 */
interface LocalBearerToken {
    kind: "local_bearer_token";
    /** Resolved bearer, carried by the ADR-0022 `Credential` contract (scheme `"bearer"`). */
    credential: Credential;
}
/**
 * Non-secret claims of a workload capability (ADR-0025a §D6). The wire format
 * is `mh1.<payload>.<hmac>`, signed with the local proxy token, with an expiry
 * at most 12 hours ahead. The SDK may validate these claims but does not mint
 * the capability.
 */
interface WorkloadCapabilityClaims {
    version: string;
    policy: WorkloadPolicy;
    worktreeId: string;
    /** ISO-8601 expiry; the contract caps this at 12 hours ahead of issuance. */
    expiresAt: string;
}
/**
 * A minted, scoped workload capability (ADR-0025a §D6). TYPE-ONLY in this
 * pass — see the module doc comment. There is no provider or factory that
 * produces one; that arrives with ADR-0025b's `MetaProxyLifecycleProvider`.
 */
interface WorkloadCapability {
    kind: "workload_capability";
    claims: WorkloadCapabilityClaims;
    /** The `mh1.<payload>.<hmac>` value, carried by the ADR-0022 `Credential` contract. */
    credential: Credential;
}
/**
 * The two Proxy credential shapes (ADR-0025a §D6:
 * `ProxyCredential = LocalBearerToken | WorkloadCapability`). Only
 * `LocalBearerToken` is constructable this pass.
 */
type ProxyCredential = LocalBearerToken | WorkloadCapability;
/** Construction-time options for {@link LocalBearerTokenCredentialProvider}. */
interface LocalBearerTokenCredentialProviderOptions {
    /** Exact normalized (loopback) origin this provider is bound to (ADR-0022 §D3). */
    normalizedOrigin: string;
    /** Exact audience this provider is bound to; defaults to `normalizedOrigin`. */
    audience?: string;
    /**
     * Explicit local bearer token. When omitted, resolved from `envVar`
     * (default {@link DEFAULT_META_PROXY_TOKEN_ENV_VAR}), then fails at
     * construction time — same fail-closed order as
     * `StaticApiKeyCredentialProvider`.
     */
    token?: string;
    /** Override the environment variable name checked when `token` is omitted. */
    envVar?: string;
    /** Injectable environment map, for testing. Defaults to `process.env`. */
    env?: Record<string, string | undefined>;
}
/**
 * Concrete `CredentialProvider` for the raw local proxy bearer
 * (ADR-0025a §D6, ADR-0022 §D1/§D3). Fails closed on construction if no
 * token is available, and on any product / origin / audience mismatch at
 * acquire time — exact string equality only, no wildcard or DNS-parent
 * trust. Always hands out `scheme: "bearer"` so the client maps it to the
 * `Authorization` header.
 *
 * This models the `LocalBearerToken` half of `ProxyCredential`; the
 * `WorkloadCapability` half is not mintable in this pass (see module doc).
 */
declare class LocalBearerTokenCredentialProvider implements CredentialProvider {
    #private;
    constructor(options: LocalBearerTokenCredentialProviderOptions);
    /** Non-secret stable provider identity, safe to log. */
    identity(): string;
    describeAuthority(request: CredentialRequest): Promise<CredentialAuthority>;
    acquire(request: CredentialRequest): Promise<Credential>;
    invalidate(_reason: string): Promise<void>;
    private authority;
    /** Fail-closed match check (ADR-0022 §D1/§D3). Exact string equality only. */
    private assertMatch;
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

/**
 * Non-streaming `chat.completions` forwarding for MetaProxyClient
 * (ADR-0025a §D7). Streaming (§D8) is out of scope this pass.
 *
 * ADR-0025a §D7 says Proxy chat/Messages "reuse only the wire types and
 * stream events" from ADR-0024a — so this module imports `ChatCompletion`/
 * `ChatCompletionRequest` from `../meta-llm/types/openai.js` verbatim, but
 * deliberately does NOT call `../meta-llm/nonstream.js`'s `postJsonIdempotent`:
 * that helper carries Proxy-inappropriate behavior (ADR-0024b `routingControls`
 * validation, `cognitum_receipt` decoding into a `MetaLlmReceipt`, and
 * meta-llm error mapping). The surrounding forwarding / retry / error contract
 * is Proxy-specific (§D7), so the idempotency + retry shape is re-implemented
 * lightly here:
 *  - a generated (or caller-supplied) `Idempotency-Key`, stable across the
 *    one possible 401-triggered retry;
 *  - at most one 401 credential refresh after a verified 401 challenge;
 *  - everything else — 429/502/503 included — is NEVER automatically
 *    retried (ADR-0025a §D8: "No Proxy POST is automatically retried while
 *    it drops `Idempotency-Key`"). That sentence is about whether the
 *    *Proxy server* honors the header for dedup — the currently-deployed
 *    Proxy drops it — so attaching one client-side does not make a retry
 *    safe. The Alternatives-considered table rejects "Retry Proxy POSTs"
 *    outright ("Idempotency is dropped and spend can duplicate"). A
 *    non-2xx surfaces as a single terminal, non-retryable `AgenticError`
 *    carrying `retryAfterMs` so the CALLER can retry manually. Bounded
 *    retry is reserved for the read-only status/models/identity routes
 *    (§D8), which this module does not implement.
 *
 * Security posture layered on top (§D6/§D10):
 *  - only an allowlist of caller headers is forwarded; `Authorization`, the
 *    local bearer, `Host`, `Content-Length`, sponsor markers, installation
 *    identity, and training-consent headers are NEVER caller-forwarded — the
 *    bearer comes only from validated local state (the credential provider);
 *  - the bearer is attached only when the origin is literal loopback (or
 *    `allowNonLoopback` was explicitly set) — a defense-in-depth re-check on
 *    top of construction-time validation;
 *  - `redirect: "manual"` on every request; a 3xx / opaque-redirect response
 *    is surfaced as a non-retryable protocol error, never followed;
 *  - ambient HTTP proxy env vars are ignored: the transport is called
 *    directly with only `{ method, headers, body, redirect }` — no dispatcher,
 *    agent, or proxy option is ever wired in.
 */

/**
 * Caller headers the Proxy forwards to the target cloud when supported
 * (ADR-0025a §D7). Anything not on this list is silently dropped before the
 * outgoing request is built — a caller can never inject `Authorization`,
 * `Host`, sponsor markers, etc. Matching is case-insensitive.
 */
declare const PROXY_CHAT_FORWARD_HEADER_ALLOWLIST: readonly ["Idempotency-Key", "X-Request-ID", "traceparent", "tracestate", "X-Cognitum-Fallback-Policy", "X-Cognitum-Min-Tier", "X-Cognitum-Max-Tier", "X-Cognitum-Escalation", "X-Cognitum-Cache", "X-Cognitum-Safety", "X-Cognitum-Sub-Tenant", "anthropic-version", "anthropic-beta"];
/** Options accepted by `MetaProxyClient.chat.completions`. */
interface MetaProxyChatCallOptions {
    requestContext?: Record<string, unknown>;
    /**
     * Supported routing intent (ADR-0025a §D5). When `requiredPlane` is set the
     * returned receipt is verified against it and a mismatch throws a
     * non-retryable protocol error — even on an otherwise-valid 200.
     */
    routingIntent?: RoutingIntent;
    /**
     * Caller headers to forward. Only members of
     * {@link PROXY_CHAT_FORWARD_HEADER_ALLOWLIST} are passed through (case-
     * insensitive); everything else is dropped before the request is sent, so a
     * caller cannot syntactically inject `Authorization` or any other protected
     * header into the outgoing request.
     */
    forwardHeaders?: Record<string, string>;
}
/** Dependency bag `forwardChatCompletion` needs from `MetaProxyClient`. */
interface ChatForwardDeps {
    origin: string;
    transport: MetaProxyTransport;
    credentialProvider?: CredentialProvider;
    allowNonLoopback?: boolean;
    defaultRequestContext?: Partial<RequestContext>;
    telemetry?: MetaProxyTelemetryHooks;
}
/**
 * Reject a redirect response outright (ADR-0025a §D6/§D10: "Cross-origin
 * redirects, rebinding hostnames, embedded credentials, and downgrade
 * redirects are rejected"). Handles both a real `fetch` opaque redirect
 * (`type === "opaqueredirect"`, `status === 0`, produced by
 * `redirect: "manual"`) and an explicit 3xx surfaced by a mock transport.
 * Exported so `client.ts`'s GET path applies the identical rule.
 */
declare function rejectRedirectResponse(response: {
    status: number;
    type?: string;
    headers: {
        get(name: string): string | null;
    };
}, operation: string, requestId: string): void;
/**
 * `POST /v1/chat/completions` through the Proxy (ADR-0025a §D7, non-streaming).
 * Returns a Proxy result whose `meta` carries the selected-plane routing
 * receipt; verifies it against `options.routingIntent.requiredPlane` (§D5
 * rule 7) before returning.
 */
declare function forwardChatCompletion(deps: ChatForwardDeps, request: ChatCompletionRequest, options?: MetaProxyChatCallOptions): Promise<MetaProxyResult<ChatCompletion>>;

/**
 * `ProxyTimeBudget` (ADR-0025a §D8):
 *
 * ```text
 * ProxyTimeBudget {
 *   connect_timeout,
 *   first_byte_timeout,
 *   idle_stream_timeout,
 *   overall_deadline
 * }
 * ```
 *
 * §D8: "The process currently uses a 10-second connect timeout and no
 * overall timeout. The SDK supplies cancellation and an optional overall
 * deadline. Timing out one request never kills the Proxy." — so
 * `connectTimeoutMs` has a documented 10s default (matching the deployed
 * Proxy's own connect-timeout behavior) while `overallDeadlineMs` has NO
 * default: it is caller-supplied only, and its absence means "no overall
 * timeout" exactly as today.
 *
 * This is a Proxy-specific type distinct from ADR-0023's generic
 * `TimeBudget` (`../agentic/index.js`) — ADR-0025a names exactly these four
 * fields, no more — even though the streaming implementation in
 * `./stream/chat-completions-stream.js` internally applies the identical
 * "race the blocking read against the smallest remaining budget" pattern
 * PR #88 proved correct for direct `MetaLlmClient` streaming.
 */
/** Caller-supplied time budget for one Proxy chat/Messages call (ADR-0025a §D8). */
interface ProxyTimeBudget {
    /**
     * Bounds each HTTP attempt (initial POST, and the at-most-one 401-refresh
     * retry) from send until a response begins arriving. Defaults to
     * {@link DEFAULT_PROXY_CONNECT_TIMEOUT_MS} when omitted, matching the
     * Proxy's own documented 10-second connect timeout (§D8).
     */
    connectTimeoutMs?: number;
    /** Bounds the wait for the first SSE body byte after a response begins. No default. */
    firstByteTimeoutMs?: number;
    /** Bounds the wait between subsequent SSE body bytes once streaming has started. No default. */
    idleStreamTimeoutMs?: number;
    /**
     * Bounds the ENTIRE call (pre-byte connect/retry phase plus the full
     * streaming read) from the moment the caller invokes the method. No
     * default — §D8: "The SDK supplies cancellation and an optional overall
     * deadline," i.e. omission means no overall timeout, exactly matching
     * today's undocumented-but-real Proxy behavior.
     */
    overallDeadlineMs?: number;
}
/** Matches the Proxy's own documented connect-timeout behavior (ADR-0025a §D8, Context). */
declare const DEFAULT_PROXY_CONNECT_TIMEOUT_MS = 10000;
/** {@link ProxyTimeBudget} after defaulting — `connectTimeoutMs` is always present. */
interface ResolvedProxyTimeBudget {
    connectTimeoutMs: number;
    firstByteTimeoutMs?: number;
    idleStreamTimeoutMs?: number;
    overallDeadlineMs?: number;
}
/** Apply {@link DEFAULT_PROXY_CONNECT_TIMEOUT_MS}; every other field passes through unchanged. */
declare function resolveProxyTimeBudget(budget?: ProxyTimeBudget): ResolvedProxyTimeBudget;

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
 * `MetaProxyStreamEnvelope<E>` (ADR-0025a §D8): "Chat and Messages use
 * ADR-0024a's lossless protocol streams and add plane and Proxy version
 * metadata." Rather than adding fields to the frozen `MetaLlmStreamEnvelope`
 * shape (`../../meta-llm/stream/envelope.js` — "do not add fields without an
 * ADR update"), this wraps it with a `proxyMeta` facet carrying exactly the
 * Proxy-specific evidence: product/protocol version (from the response
 * headers, same as non-streaming `MetaProxyResponseMeta`) and the routing/
 * upstream receipts once observed on the wire (ADR-0025a §D4/§D7).
 */

/** Proxy-specific metadata layered onto every streamed envelope (ADR-0025a §D8). */
interface MetaProxyStreamMeta {
    productVersion?: string;
    protocolVersion?: string;
    /**
     * Plane-routing evidence observed so far on this stream (ADR-0025a §D4).
     * `undefined` until the wire payload carrying `cognitum_routing_receipt`
     * arrives (typically, but not necessarily, the terminal chunk) — once
     * observed, every subsequently-yielded envelope carries it.
     */
    routingReceipt?: MetaProxyRoutingReceipt;
    /** Upstream (Cognitum-cloud) usage/receipt evidence, once observed (ADR-0025a §D7/§D8). */
    upstreamReceipt?: MetaProxyUpstreamReceipt;
}
/** Every streamed envelope from `MetaProxyClient.chat.completionsStream` (ADR-0025a §D8). */
interface MetaProxyStreamEnvelope<E> extends MetaLlmStreamEnvelope<E> {
    proxyMeta: MetaProxyStreamMeta;
}
/** The concrete envelope type `chat.completionsStream` yields. */
type MetaProxyChatStreamEnvelope = MetaProxyStreamEnvelope<OpenAiStreamEvent>;

/**
 * `chat.completionsStream` HTTP + SSE orchestration for `MetaProxyClient`
 * (ADR-0025a §D8, M3 continuation of issue #61).
 *
 * §D8: "Chat and Messages use ADR-0024a's lossless protocol streams and add
 * plane and Proxy version metadata." This module REUSES, rather than
 * reimplements:
 *  - PR #88's generic byte-level SSE parser (`../../sse/parser.js`);
 *  - PR #88/#93's OpenAI event decoder (`../../meta-llm/stream/openai-events.js`)
 *    — the byte-forwarded stream is decoded exactly like direct Meta LLM
 *    streaming (the Proxy forwards the same OpenAI wire shape verbatim,
 *    §D7: "reuse only the wire types and stream events");
 *  - `../forwarding.js`'s §D7 header allowlist, credential acquisition,
 *    bearer placement, idempotency-key minting, and routing-receipt decode
 *    helpers, so a caller sees byte-for-byte identical forwarding behavior
 *    whether they call the streaming or non-streaming method.
 *
 * On top of the reused pieces, this module adds exactly what §D8 asks for
 * beyond ADR-0024a's stream contract:
 *  - `MetaProxyStreamEnvelope.proxyMeta` (plane/version metadata, `./envelope.js`);
 *  - `ProxyTimeBudget`'s `connectTimeoutMs`/`overallDeadlineMs` (`../time-budget.js`),
 *    raced around the pre-byte HTTP attempt(s) in addition to the
 *    firstByte/idle races PR #88 already proved correct for the post-byte
 *    read loop;
 *  - the §D5 rule 7 required-plane check (`../routing.js`'s
 *    `assertRoutingReceiptMatchesIntent`, the SAME function the
 *    non-streaming path uses), applied to the LAST routing receipt observed
 *    on the wire before the stream's native terminal event.
 *
 * Retry contract (ADR-0025a §D8, and the just-fixed eb553f7 bug this MUST
 * NOT reintroduce): the pre-byte phase performs at most one 401-triggered
 * credential refresh and NEVER bounded-retries a 429/502/503 — "No Proxy
 * POST is automatically retried while it drops `Idempotency-Key`" describes
 * the currently-deployed Proxy dropping the header server-side, not whether
 * the SDK attaches one; attaching one client-side does not make a retry
 * safe. A non-2xx pre-byte response is therefore always a single terminal,
 * non-retryable error (`err.retryAfterMs` lets the CALLER retry manually).
 * Once any response byte has been read, there is NO retry at all, period —
 * "A pre-response disconnect may already have incurred work" only applies
 * pre-byte; post-byte a disconnect is unconditionally terminal, mirroring
 * PR #88's `../../meta-llm/stream/chat-completions-stream.js` exactly.
 *
 * Sponsored streaming (`stream: true` on a sponsored-plane call) is
 * explicitly OUT of scope this pass — see `../client.js`'s
 * `previewSponsoredChatCompletions` for the fail-fast guard (§D8: "Sponsored
 * `stream = true` fails locally until an end-to-end stream capability
 * exists").
 */

/** Options accepted by `MetaProxyClient.chat.completionsStream`. */
interface MetaProxyChatStreamCallOptions extends MetaProxyChatCallOptions {
    timeBudget?: ProxyTimeBudget;
    cancellation?: CancellationToken;
    /** Falls back to `requestContext.requestId` when provided, then a fresh UUID. */
    requestContext?: Partial<RequestContext>;
}
/**
 * `POST /v1/chat/completions` through the Proxy with `stream: true`
 * (ADR-0025a §D8). Returns an async generator of
 * `MetaProxyStreamEnvelope<OpenAiStreamEvent>` — iterate with `for await`.
 */
declare function forwardChatCompletionStream(deps: ChatForwardDeps, request: ChatCompletionRequest, options?: MetaProxyChatStreamCallOptions): AsyncGenerator<MetaProxyStreamEnvelope<OpenAiStreamEvent>, void, void>;

/**
 * MetaProxyClient (ADR-0025a). Issue #61 / M3 start.
 *
 * This pass implements exactly §D1 (public topology — only `status` and
 * `capabilities` exist as methods this pass; every other §D1 surface
 * — `chat`, `messages`, `models`, `whoami`, `preview.sponsored.*`,
 * `preview.routing` — is deliberately NOT declared yet, rather than stubbed
 * with a placeholder, since their construction depends on §D6 (auth),
 * §D7 (forwarding), §D9 (consent/sponsor), and §D5 (routing) groundwork
 * that is out of scope here), §D2 (maturity — everything below is preview;
 * see the class doc comment), §D3 (construction, zero I/O), and §D4
 * (`status()`/`capabilities()` as real HTTP calls against the local
 * sidecar's `/status` route, decoding the plane-evidence fields §D4
 * specifies).
 *
 * Construction mirrors `MetaLlmClient`'s conventions exactly
 * (`../meta-llm/client.js`): a resolved config object, an injectable
 * `transport`, a shared `CredentialProvider` for auth, and the same
 * telemetry-hook / request-ID / error-mapping shape. The one structural
 * difference is D3's own explicit instruction: `MetaProxyResult`/
 * `MetaProxyResponseMeta` are their OWN envelope, not a reuse of
 * `MetaLlmResult` — see `./envelope.js`'s doc comment for why.
 *
 * Deferred to follow-up M3 passes (see issue #61 and ADR-0025a):
 *  - §D5 data-plane and policy model (`RoutingIntent`, plane/policy rules);
 *  - §D6 authentication and workload capabilities beyond the minimal
 *    `CredentialProvider` this pass's constructor accepts;
 *  - §D7 inference/forwarding contract (`chat.completions`, `messages`);
 *  - §D8 streaming, errors, cancellation, and retry for the data plane;
 *  - §D9 consent, sponsor budget, and usage;
 *  - §D10 loopback and browser security beyond the loopback-origin
 *    validation already enforced by `./config.js`'s `resolveMetaProxyClientConfig`.
 */

/** Options accepted by every operation method (mirrors `MetaLlmCallOptions`). */
interface MetaProxyCallOptions {
    requestContext?: Record<string, unknown>;
}
/**
 * Client for an already-running, authenticated, loopback Meta Proxy sidecar
 * (ADR-0025a). Independent of `MetaProxyManager` (ADR-0025b) — construction
 * never starts, installs, authenticates, probes, or reconfigures a process
 * (ADR-0025a §D1).
 *
 * Every method on this class is `preview` maturity (ADR-0025a §D2: "All
 * current methods begin preview until a complete contract bundle exists").
 * `status`/`capabilities` are the group with a defined path to `Stable`
 * ("Versioned schema, plane evidence, limitations, and compatibility range
 * published") but have not reached it yet — no D11 GA gate has passed.
 */
declare class MetaProxyClient {
    private readonly config;
    constructor(config?: MetaProxyClientConfig);
    /** Read-only view of the effective configuration. */
    getConfig(): ResolvedMetaProxyClientConfig;
    /**
     * `GET /status` — authenticated local runtime and routing state
     * (ADR-0025a Context, §D4). `proxy_token_valid: true` (surfaced only as
     * a successful auth, never as a raw token) means only that auth
     * succeeded — this method never returns tokens, keys, OAuth data, unsafe
     * paths, or full account identifiers (§D4).
     */
    status(options?: MetaProxyCallOptions): Promise<MetaProxyResult<MetaProxyStatus>>;
    /**
     * Versioned behavior safe for this caller (ADR-0025a §D4: "`capabilities()`
     * uses an authenticated endpoint when available. Until then it uses exact
     * tested `/status` schema plus ADR-0020's pinned compatibility table. It
     * never discovers support by sending a prompt."). No dedicated
     * `/capabilities` route is published, so this calls the same
     * authenticated `/status` endpoint `status()` uses and merges it with
     * `config.capabilitiesSnapshot` — it never sends an inference request to
     * probe support.
     */
    capabilities(options?: MetaProxyCallOptions): Promise<MetaProxyResult<CapabilitiesResult>>;
    /**
     * `POST /v1/chat/completions` through the Proxy (ADR-0025a §D7), non-
     * streaming only this pass (§D8 streaming is deferred, so there is no
     * `chat.completionsStream` here). Namespace-object shape mirrors
     * `MetaLlmClient.chat.completions` (`../meta-llm/client.js`), but the call
     * returns a Proxy result whose `meta` carries the selected-plane routing
     * receipt and is verified against `options.routingIntent.requiredPlane`
     * (§D5 rule 7). See `./forwarding.js` for the header allowlist, idempotency,
     * retry, redirect, and ambient-proxy rules.
     */
    readonly chat: {
        completions: (request: ChatCompletionRequest, options?: MetaProxyChatCallOptions) => Promise<MetaProxyResult<ChatCompletion>>;
        /**
         * `POST /v1/chat/completions` through the Proxy with `stream: true`
         * (ADR-0025a §D8). Returns an async generator of
         * `MetaProxyStreamEnvelope<OpenAiStreamEvent>` — iterate with `for await`.
         * See `./stream/chat-completions-stream.js` for the full streaming
         * contract (reused SSE parser/decoder, `ProxyTimeBudget`, no auto-retry,
         * required-plane verification on the terminal receipt).
         */
        completionsStream: (request: ChatCompletionRequest, options?: MetaProxyChatStreamCallOptions) => AsyncGenerator<MetaProxyStreamEnvelope<OpenAiStreamEvent>, void, void>;
    };
    /**
     * `client.preview.sponsored.chatCompletions` (ADR-0025a §D1 topology,
     * §D9 preview maturity). Sponsored forwarding itself (budget, receipts,
     * atomic spend) is explicitly OUT of scope this pass (§D9 defers to
     * ADR-0025b's lifecycle/state fixes) — this method exists ONLY to
     * fail fast, with zero HTTP I/O, per §D1 ("Such a call returns
     * `UnsupportedCapabilityError` before HTTP I/O") and §D8 ("Sponsored
     * `stream = true` fails locally until an end-to-end stream capability
     * exists"). Streaming and non-streaming sponsored calls both fail this
     * pass; the error message distinguishes the two so a caller who only
     * hit the streaming restriction isn't told sponsor support is entirely
     * absent when non-stream sponsor lands in a later pass.
     */
    readonly preview: {
        sponsored: {
            chatCompletions: (request: ChatCompletionRequest, _options?: MetaProxyChatCallOptions) => Promise<never>;
        };
    };
    /** Assemble the `./forwarding.js` dependency bag from resolved config. */
    private forwardingDeps;
    /**
     * Close local connections and wait only. Never stops the sidecar process
     * (ADR-0025a §D3: "Closing it releases connections only and never stops
     * the sidecar.").
     */
    close(): Promise<void>;
    private resolveCredential;
    private applyAuth;
    private getJson;
}
/**
 * `capabilities()` result shape — the shared `CapabilitySet` (ADR-0019 §D6)
 * plus the Proxy-specific plane evidence ADR-0025a §D4 says `capabilities()`
 * must be able to expose alongside it.
 */
interface CapabilitiesResult {
    product: string;
    productVersion: string;
    protocol: string;
    protocolVersion: string;
    features: Record<string, boolean>;
    limitations: string[];
    authMethods: string[];
    source: "server" | "static-compatibility-table";
    compatibleSdkRange?: string;
    configuredPlane?: string;
    selectedPlane?: string;
}

export { type CapabilitiesResult, type ChatForwardDeps, type ConsentGrantId, DEFAULT_META_PROXY_ORIGIN, DEFAULT_META_PROXY_TOKEN_ENV_VAR, DEFAULT_PROXY_CONNECT_TIMEOUT_MS, type LocalBearerToken, LocalBearerTokenCredentialProvider, type LocalBearerTokenCredentialProviderOptions, type MetaProxyCallOptions, type MetaProxyChatCallOptions, type MetaProxyChatStreamCallOptions, type MetaProxyChatStreamEnvelope, MetaProxyClient, type MetaProxyClientConfig, type MetaProxyResponseMeta, type MetaProxyResult, type MetaProxyRoutingReceipt, type MetaProxyStatus, type MetaProxyStreamEnvelope, type MetaProxyStreamMeta, type MetaProxyTelemetryEvent, type MetaProxyTelemetryHooks, type MetaProxyTransport, type MetaProxyUpstreamReceipt, PROXY_CHAT_FORWARD_HEADER_ALLOWLIST, type ProxyCredential, type ProxyTimeBudget, type ResolvedMetaProxyClientConfig, type ResolvedProxyTimeBudget, type RoutingIntent, type RoutingPlane, type WorkloadCapability, type WorkloadCapabilityClaims, type WorkloadPolicy, __resetMetaProxyNonLoopbackWarnLatch, assertRoutingReceiptMatchesIntent, forwardChatCompletion, forwardChatCompletionStream, isBearerAttachmentAllowed, rejectRedirectResponse, resolveMetaProxyClientConfig, resolveProxyTimeBudget };
