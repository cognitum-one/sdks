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

export { type CapabilitiesResult, DEFAULT_META_PROXY_ORIGIN, type MetaProxyCallOptions, MetaProxyClient, type MetaProxyClientConfig, type MetaProxyResponseMeta, type MetaProxyResult, type MetaProxyRoutingReceipt, type MetaProxyStatus, type MetaProxyTelemetryEvent, type MetaProxyTelemetryHooks, type MetaProxyTransport, type MetaProxyUpstreamReceipt, type ResolvedMetaProxyClientConfig, type RoutingPlane, type WorkloadPolicy, __resetMetaProxyNonLoopbackWarnLatch, resolveMetaProxyClientConfig };
