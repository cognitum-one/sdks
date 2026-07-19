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
 * `HarnessaaSClient` construction and deployment ownership (ADR-0027a,
 * ADR-0019 §D2). Issue #67/#68 / M5 start.
 *
 * **Scope note (2026-07-19 reconciliation audit, issue #67):** the upstream
 * `cognitum-one/harnessaas` service is genuinely SYNCHRONOUS today — `POST
 * /solve` is one HTTP request/response with no job/poll/SSE/approval
 * contract anywhere in the running service (see
 * `docs/adr/0027a-harnessaas-jobs-events-approvals-and-artifacts.md`'s
 * "2026-07-19 reconciliation audit" context-section note). ADR-0027a's
 * "Decision" section (an async `SolveHandle`/`/v1/solves/*` job resource) is
 * an explicit PROPOSAL for something that does not exist upstream yet — this
 * module intentionally does NOT build against it. This pass covers only
 * construction, `health()`, `solve()`, and `lineage()` against the real,
 * deployed, synchronous route surface (`GET /health`, `POST /solve`, `GET
 * /lineage/:id`).
 *
 * Construction performs NO I/O (ADR-0019 §D3), mirroring
 * `MetaLlmClient`/`MetaProxyClient`/`MetaHarnessClient`'s construction
 * conventions exactly (`../meta-llm/config.js`).
 */

/** A single telemetry observation emitted around one HarnessaaSClient operation. */
interface HarnessaaSTelemetryEvent {
    operation: string;
    requestId: string;
    httpStatus?: number;
    durationMs?: number;
    retryAfterMs?: number;
}
/**
 * Caller-supplied telemetry hooks (ADR-0028). Hooks MUST NOT receive
 * secrets; callers wire redaction via `SecretRedactor` from
 * `../agentic/index.js` before logging anything derived from these events.
 */
interface HarnessaaSTelemetryHooks {
    onRequestStart?(event: Pick<HarnessaaSTelemetryEvent, "operation" | "requestId">): void;
    onRequestEnd?(event: HarnessaaSTelemetryEvent): void;
}
/**
 * Fetch-compatible transport hook, injectable for tests. Defaults to
 * `globalThis.fetch`.
 */
type HarnessaaSTransport = typeof fetch;
/** Construction config for {@link HarnessaaSClient} (ADR-0027a, ADR-0019 §D1). */
interface HarnessaaSClientConfig {
    /**
     * Explicit HTTPS origin. No built-in default here — the same rule as
     * `MetaLlmClientConfig.baseUrl` (ADR-0024a §D1) applies: a production URL
     * becomes a default only after publication in a contract bundle, which
     * does not exist for HarnessaaS yet (ADR-0027a §D11 blocker #1).
     */
    baseUrl: string;
    /**
     * Opt out of the HTTPS-origin requirement for local development and
     * tests only (e.g. a local `harnessaas serve --mock` on
     * `http://127.0.0.1`). Never set this against a real deployment.
     */
    allowInsecureHttp?: boolean;
    credentialProvider?: CredentialProvider;
    transport?: HarnessaaSTransport;
    defaultRequestContext?: Partial<RequestContext>;
    budgetPolicy?: BudgetPolicy;
    /**
     * Static compatibility-table entry consulted by `capabilities()`. No
     * runtime capabilities endpoint is published for HarnessaaS yet.
     */
    capabilitiesSnapshot?: CapabilitySet;
    telemetry?: HarnessaaSTelemetryHooks;
}
/** Normalized, defaulted construction state held by {@link HarnessaaSClient}. */
interface ResolvedHarnessaaSClientConfig extends HarnessaaSClientConfig {
    baseUrl: string;
}
/**
 * Validate and normalize a {@link HarnessaaSClientConfig}. Pure function, no
 * I/O — construction MUST stay side-effect free (ADR-0019 §D3).
 */
declare function resolveHarnessaaSClientConfig(config: HarnessaaSClientConfig): ResolvedHarnessaaSClientConfig;

/** Result and metadata envelope for HarnessaaSClient operations (ADR-0027a). */
/** Per-response metadata carried alongside every {@link HarnessaaSResult}. */
interface HarnessaaSResponseMeta {
    requestId: string;
    httpStatus: number;
    retryAfterMs?: number;
}
/** Envelope wrapping every HarnessaaSClient operation result. */
interface HarnessaaSResult<T> {
    data: T;
    meta: HarnessaaSResponseMeta;
}

/**
 * Discovery wire type: health (ADR-0027a, issue #67/#68 / M5 start).
 *
 * Verified against `cognitum-one/harnessaas@908e4a99:src/server.ts:286-304`.
 * `/health` is served WITHOUT authentication (no `authenticate()` call in the
 * route handler) — matching `MetaLlmClient.health()`'s "process-level
 * response only, never identity or readiness" contract exactly.
 *
 * IMPORTANT (2026-07-19 reconciliation audit, issue #67): the service also
 * answers on `/healthz` and `/status`, but `src/server.ts:290-292`'s own
 * comment documents that Cloud Run's frontend (GFE) RESERVES `/healthz` and
 * answers it with the platform's own 404 to EXTERNAL callers — so `/healthz`
 * is NOT reliably reachable from outside the container, even though the
 * README's local `curl -s localhost:8080/healthz` example works (it never
 * crosses a real Cloud Run frontend). `/health` and `/status` are the
 * externally-reachable aliases. This client therefore calls `GET /health`
 * as the canonical route.
 */
/**
 * `health()` response. No OpenAPI/JSON-Schema contract is published for this
 * shape yet (ADR-0027a §D11 blocker #1), so only the fields verified
 * directly against `src/server.ts:293-303` are typed; everything else
 * (`genome`, `sandbox_caps`, ...) is preserved in `raw`.
 */
interface HarnessaaSHealth {
    status: string;
    /** `"mock"` ($0, no network) or `"live"`. */
    mode?: string;
    backend?: string;
    /** Always `"per-account"` at HEAD — tenancy is per-tenant, not global. */
    tenancy?: string;
    /** `"firestore"` (shared/consistent across instances) or `"memory"` (per-instance). */
    storeBackend?: string;
    /** Always `true` at HEAD — lineage is per-tenant; a global chain is no longer verified here. */
    lineageChainOk?: boolean;
    /** Unrecognized fields (`genome`, `sandbox_caps`, ...) from the server response, preserved verbatim. */
    raw?: Record<string, unknown>;
}
/** Parse a raw `GET /health` JSON body into {@link HarnessaaSHealth}. */
declare function parseHarnessaaSHealth(value: unknown): HarnessaaSHealth;

/**
 * Wire types for the real, deployed, SYNCHRONOUS HarnessaaS surface (issue
 * #67/#68 / M5 start).
 *
 * Verified directly against `cognitum-one/harnessaas@908e4a99`
 * (`src/types.ts:557-573,728-799,786-870`, README.md's documented
 * `POST /solve` example) — not against ADR-0027a's D3 `SolveSubmissionV1`/
 * `SolveJob` proposal, which does not correspond to any deployed route yet.
 *
 * Field names are idiomatic camelCase (this SDK's convention); `toSolveRequestWire`
 * below owns the camelCase -> snake_case wire mapping explicitly, rather than
 * `JSON.stringify`-ing the camelCase object directly.
 *
 * Deliberately OUT of scope this pass: the vertical-specific compound
 * request fields (`finding`/`scanner_command` for `security-remediation`,
 * `migration`/`build_command` for `dependency-migration`,
 * `test_generation`/`coverage_command` for `test-generation`) — these
 * require modeling `SecurityFinding`/`MigrationDirective`/`TestGenDirective`
 * shapes not needed for the core `code-repair` slice this pass covers. A
 * `vertical` other than `code-repair` sent through {@link HarnessaaSSolveRequest}
 * without its required compound field is rejected by the server with a 400,
 * per `src/server.ts`'s per-vertical validation — this client does not
 * replicate that validation locally.
 */
/** `SolveRequest.vertical` (ADR-0011). Defaults server-side to `"code-repair"`. */
type HarnessaaSVertical = "code-repair" | "security-remediation" | "dependency-migration" | "test-generation";
/**
 * A single solve request (`src/types.ts:572-624`'s `SolveRequest`, core
 * `code-repair` fields only this pass — see module doc comment).
 */
interface HarnessaaSSolveRequest {
    /** Repo identifier — a git URL. A local filesystem path is rejected by the API (issue #56). */
    repo: string;
    /** The customer's OWN test command, e.g. `"pytest -k test_thing"`. */
    testCommand: string;
    /** Natural-language description of the issue to repair. */
    issue: string;
    /**
     * Cost x quality slider, 0..1. Soft signal only — `src/cascade.ts` does
     * NOT read it; escalation occurs only on an empty artifact
     * (ADR-0027a Context: "A typed no-op would mislead callers about cost
     * and quality"). Sent through as given; this client does not claim it
     * has any routing effect.
     */
    w?: number;
    /** Which vertical this request rides. Defaults server-side to `"code-repair"`. */
    vertical?: HarnessaaSVertical;
}
/** Serialize {@link HarnessaaSSolveRequest} to the real wire shape (snake_case `test_command`). */
declare function toSolveRequestWire(request: HarnessaaSSolveRequest): Record<string, unknown>;
/**
 * `CostReceipt` (`src/types.ts:728-761`). Core fields modeled directly;
 * the vertical-specific `field_coverage`/`compliance_scope` manifests are
 * folded into `raw` rather than typed this pass (out of scope — see
 * module doc comment).
 */
interface HarnessaaSCostReceipt {
    requestId: string;
    /** The model that produced the FINAL/winning patch. */
    model: string;
    /** Repair mode used, e.g. `"empty-patch-cascade"`. */
    mode: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    /** Compact human-readable route, e.g. `"base -> frontier"`. */
    route: string;
    escalated: boolean;
    /** meta-llm `usage_ledger` reference id per rung. Present only for gateway-backed solves. */
    ledgerRefs?: string[];
    /** Number of rungs served from the gateway's response cache. Present only when > 0. */
    cacheHits?: number;
    /** Total prompt-prefix cache-read tokens summed across rungs. Present only when > 0. */
    cachedReadTokens?: number;
    /** Number of rungs dispatched through meta-llm's batch API. Present only when > 0. */
    batched?: number;
    /** Unrecognized/vertical-specific fields (e.g. `field_coverage`, `compliance_scope`), preserved verbatim. */
    raw?: Record<string, unknown>;
}
/**
 * Conformance attestation (`src/types.ts:786-799`). `usedOracleDuringSolve`
 * MUST be `false` for a leaderboard/grading-clean solve — enforced
 * architecturally server-side, not by this client.
 */
interface HarnessaaSConformanceAttestation {
    usedOracleDuringSolve: false;
    /** Human-readable statement of what was (and was not) visible to the solver. */
    statement: string;
    /** SHA-256 over the solve inputs the model was actually allowed to see. */
    visibleInputsDigest: string;
}
/** The full response from a solve (`src/types.ts:862-870`'s `SolveResponse`). */
interface HarnessaaSSolveResponse {
    requestId: string;
    /** The unified-diff patch, or empty string if no fix was found. */
    patch: string;
    /** `true` iff the customer's `test_command` passed AFTER applying the patch. */
    resolved: boolean;
    costReceipt: HarnessaaSCostReceipt;
    /** Pointer to retrieve the lineage record via `lineage(requestId)`. */
    lineageRef: string;
    conformance: HarnessaaSConformanceAttestation;
}
/** Parse a raw JSON `CostReceipt` body into {@link HarnessaaSCostReceipt}. */
declare function parseCostReceipt(value: unknown): HarnessaaSCostReceipt;
/** Parse a raw JSON `ConformanceAttestation` body into {@link HarnessaaSConformanceAttestation}. */
declare function parseConformanceAttestation(value: unknown): HarnessaaSConformanceAttestation;
/** Parse a raw `POST /solve` JSON body into {@link HarnessaaSSolveResponse}. */
declare function parseSolveResponse(value: unknown): HarnessaaSSolveResponse;
/**
 * A single lineage entry (`src/types.ts:799-825`'s `LineageRecord`). Kept
 * permissive (`raw` passthrough for genome/route/vertical-specific fields)
 * rather than a full 1:1 model — no OpenAPI/JSON-Schema contract is
 * published for this shape yet (ADR-0027a §D11 blocker #1).
 */
interface HarnessaaSLineageRecord {
    requestId: string;
    accountId?: string;
    /** ISO timestamp. */
    ts: string;
    /** Hash chain: hash of the PREVIOUS record, for tamper-evidence. */
    prevHash: string;
    /** SHA-256 of this record's canonical content (excluding `hash` itself). */
    hash: string;
    /** Unrecognized/nested fields (`genome`, `route`, `conformance`, `vertical`, ...), preserved verbatim. */
    raw: Record<string, unknown>;
}
/** `GET /lineage/:id` response (`src/server.ts`'s `{ request_id, records }` shape). */
interface HarnessaaSLineageResult {
    requestId: string;
    records: HarnessaaSLineageRecord[];
}
/** Parse a raw `GET /lineage/:id` JSON body into {@link HarnessaaSLineageResult}. */
declare function parseLineageResult(value: unknown): HarnessaaSLineageResult;

/**
 * HTTP-status -> `AgenticErrorKind` mapping for HarnessaaS. Verified against
 * the REAL error paths in `cognitum-one/harnessaas@908e4a99`:
 *
 * - 401 `missing_api_key`/`invalid_api_key` (`src/auth.ts:280-303`) — opaque
 *   on purpose (anti-enumeration): malformed/unknown/inactive/expired all
 *   collapse to the same message.
 * - 403 `insufficient_scope` (`src/auth.ts` `authorizeGenome`) and
 *   `scope_required` (`src/server.ts` security-remediation gate) — a key
 *   with no completion scope at all, or missing the dedicated
 *   `completions:security` scope.
 * - 403 (egress) `EgressDeniedError` (`src/server.ts`, ADR-0040) — the
 *   requested allowlist-egress policy can't be built on this runtime; the
 *   service fails CLOSED rather than degrade to open egress.
 * - 400 — invalid JSON body, missing `repo`/`test_command`/`issue`, a
 *   non-git `repo` path (`repo_not_permitted`, issue #56), or a
 *   vertical-specific missing field.
 * - 404 — unmatched route, or (for `lineage`) a `request_id` not owned by
 *   the caller's tenant (cross-tenant reads collapse to the same 404,
 *   anti-enumeration).
 * - 422 `safety_blocked` — the inbound PII/safety pre-flight refused the
 *   request BEFORE any spend (`PiiBlockedError`).
 * - 500 — an uncaught exception; the service has no explicit 429/502/503
 *   emission in its own route code (no in-app rate limiter was found), so
 *   those statuses (if seen at all) originate from infrastructure in front
 *   of the app (Cloud Run / load balancer), not from `harnessaas` itself.
 *   Mapped here defensively for forward compatibility only.
 */

/** Minimal response shape this mapper needs — satisfied by `fetch`'s `Response`. */
interface HttpErrorResponse {
    status: number;
    headers: {
        get(name: string): string | null;
    };
    text(): Promise<string>;
}
declare function mapHarnessaaSHttpError(response: HttpErrorResponse, operation: string, requestId: string): Promise<AgenticError>;

/**
 * `HarnessaaSClient` (ADR-0027a, ADR-0019 §D2). Issue #67/#68 / M5 start.
 *
 * **Scope (2026-07-19 reconciliation audit, issue #67):** this pass covers
 * ONLY the real, deployed, SYNCHRONOUS surface of `cognitum-one/harnessaas` —
 * construction (zero I/O), `health()`, `solve()`, and `lineage()`. It
 * deliberately does NOT build against ADR-0027a's "Decision" section (an
 * async `SolveHandle`/job/poll/SSE/approval/cancel/artifact contract under
 * `/v1/solves/*`) — that is an explicit PROPOSAL for something that does not
 * exist in the running service yet (`docs/adr/0027a-*.md`'s reconciliation
 * note; `src/server.ts:367-501` at `908e4a99` is one HTTP request in, one
 * `SolveResponse` out, full stop). Also explicitly out of scope this pass:
 * the webhook admin routes, the MicroLoRA flywheel API (`/microlora/*` —
 * confirmed a SEPARATE future decision by the same reconciliation audit,
 * not folded into this ADR), and the authenticated `/api/v1/*` IBO-console
 * relay (unrelated to the SDK-facing solve/lineage contract).
 *
 * **Auth:** a `cog_`-prefixed API key, sent as `X-API-Key` (preferred) or
 * `Authorization: Bearer` (verified at `src/auth.ts:1-24,256-264`) — the
 * SAME shape Meta LLM uses, so `StaticApiKeyCredentialProvider` works as-is
 * (its default `scheme` is already `"X-API-Key"`).
 *
 * **Retry safety (ADR-0023, the Meta Proxy PR #93 lesson):** `solve()` is
 * genuinely non-idempotent from this client's point of view — no
 * `Idempotency-Key` handling of any kind exists anywhere in the upstream
 * service (verified: no reference to "idempoten" in `src/` outside the
 * unrelated webhook-delivery-dedupe module) and there is no in-app rate
 * limiter, so a lost response after a 429/502/503/5xx/transport failure
 * cannot be distinguished from "the sandbox clone/model call/test run
 * already started spending." Automatically retrying would risk exactly the
 * duplicate-spend/duplicate-execution failure mode independent review found
 * in Meta Proxy's non-streaming forwarding (ADR-0025a, PR #93, commit
 * `eb553f7`). `solve()` therefore makes exactly ONE HTTP attempt for every
 * outcome except a verified 401 challenge (auth happens server-side BEFORE
 * any spend — `src/server.ts` calls `authenticate()` as the very first thing
 * in the `POST /solve` handler — so a single credential-refresh-and-retry
 * there is provably zero-spend-safe, unlike a 429/502/503). `lineage()` is a
 * plain `GET` (a safe read per ADR-0023 §D3) and gets a bounded 429/502/503
 * retry; `health()` is a single unauthenticated `GET` with no retry loop,
 * matching `MetaLlmClient.health()`'s pattern.
 */

/** Options accepted by every operation method. */
interface HarnessaaSCallOptions {
    requestContext?: Partial<RequestContext>;
}
/**
 * Client for the real, deployed, synchronous HarnessaaS surface (ADR-0027a).
 * Construction performs no I/O (ADR-0019 §D3). Never composes Meta LLM, Meta
 * Proxy, or MetaHarness (ADR-0019 §D4) — this is HarnessaaS's own
 * bounded-context client, full stop.
 */
declare class HarnessaaSClient {
    private readonly config;
    constructor(config: HarnessaaSClientConfig);
    /** Read-only view of the effective configuration. */
    getConfig(): ResolvedHarnessaaSClientConfig;
    /**
     * Versioned behavior safe for this caller, from the static compatibility
     * snapshot (no I/O — no runtime capabilities endpoint is published for
     * HarnessaaS yet). Unknown server versions receive the intersection of
     * proven-safe capabilities, never the union (ADR-0019 §D6).
     */
    capabilities(): CapabilitySet;
    /**
     * `GET /health` — process health only, no identity/readiness semantics.
     * Unauthenticated on the real service (`src/server.ts:293-303` never
     * calls `authenticate()` for this route) — never acquires a credential,
     * even when one is configured. Single HTTP attempt, no retry loop,
     * matching `MetaLlmClient.health()`.
     *
     * Calls `GET /health`, NOT `/healthz` — see `./discovery.js`'s module
     * doc comment for why `/healthz` is unreliable from outside the container
     * on Cloud Run.
     */
    health(options?: HarnessaaSCallOptions): Promise<HarnessaaSResult<HarnessaaSHealth>>;
    /**
     * `POST /solve` — genuinely synchronous: one HTTP request, one full
     * `SolveResponse` back inline. See this module's doc comment for why this
     * makes exactly one HTTP attempt for every outcome except a verified 401
     * (safe to refresh-and-retry once, since auth is checked before any
     * spend) — 429/502/503/5xx/transport failures are NEVER retried
     * automatically.
     *
     * This pass does not perform local ADR-0022 §D5 scope preflight: unlike
     * Meta LLM/Meta Proxy's single required-scope-string convention, the real
     * server-side authorization is a tier-ladder CAP over multiple
     * alternative scopes (any of `completions:low`/`mid`/`high` lets a solve
     * proceed, just at a capped tier — `src/auth.ts`'s `authorizeGenome`),
     * which this client does not replicate client-side. The server remains
     * authoritative; a 403 (`insufficient_scope` or, for
     * `vertical: "security-remediation"`, `scope_required`) surfaces as a
     * `permission_denied` `AgenticError` — see `./http-errors.js`.
     */
    solve(request: HarnessaaSSolveRequest, options?: HarnessaaSCallOptions): Promise<HarnessaaSResult<HarnessaaSSolveResponse>>;
    /**
     * `GET /lineage/:id` — a safe read (ADR-0023 §D3), so bounded 429/502/503
     * retry is appropriate here, unlike `solve()`. A `request_id` from
     * another tenant collapses to the same 404 as an absent one
     * (`src/server.ts`'s cross-tenant deny — anti-enumeration), matching
     * ADR-0019 §D6's "foreign resources map to the same `NotFoundError` as
     * absent resources."
     */
    lineage(requestId: string, options?: HarnessaaSCallOptions): Promise<HarnessaaSResult<HarnessaaSLineageResult>>;
    /**
     * Close local connections and wait only. Never cancels a remote solve
     * (there is no remote job to cancel — `POST /solve` has already returned
     * by the time this client hands back a result).
     */
    close(): Promise<void>;
    private requireCredential;
    private applyAuth;
    /** One GET attempt. Never retries by itself — callers own that (see `lineage()`/`health()`). */
    private sendGetOnce;
    /** One POST attempt. Never retries by itself — the caller (`solve()`) owns that. */
    private sendPostOnce;
}

export { type HarnessaaSCallOptions, HarnessaaSClient, type HarnessaaSClientConfig, type HarnessaaSConformanceAttestation, type HarnessaaSCostReceipt, type HarnessaaSHealth, type HarnessaaSLineageRecord, type HarnessaaSLineageResult, type HarnessaaSResponseMeta, type HarnessaaSResult, type HarnessaaSSolveRequest, type HarnessaaSSolveResponse, type HarnessaaSTelemetryEvent, type HarnessaaSTelemetryHooks, type HarnessaaSTransport, type HarnessaaSVertical, type ResolvedHarnessaaSClientConfig, mapHarnessaaSHttpError, parseConformanceAttestation, parseCostReceipt, parseHarnessaaSHealth, parseLineageResult, parseSolveResponse, resolveHarnessaaSClientConfig, toSolveRequestWire };
