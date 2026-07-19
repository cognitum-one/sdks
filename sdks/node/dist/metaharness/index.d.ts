/**
 * `MetaHarnessClient` construction and configuration (ADR-0026a §D1, §D3).
 *
 * Type-only scaffolding plus construction-time validation for issue #64 /
 * M4 start. Construction performs NO I/O — it "resolves configuration
 * only. [It performs] no npm access, process spawn, repository read,
 * filesystem write, capability probe, login, or prompt" (§D1). See
 * `./client.js` for the fail-closed method stubs this pass ships instead
 * of any real bridge call.
 *
 * Mirrors `MetaProxyClient`'s construction conventions exactly
 * (`../meta-proxy/config.js`): a resolved config object and the same
 * telemetry-hook shape. Unlike Meta Proxy, there is no HTTP loopback
 * origin here at all — the bridge is a child process over stdio
 * (ADR-0026a §D4) — so there is nothing analogous to `origin` to default
 * or validate. The §D1/§D10 "zero I/O" requirement this module upholds
 * instead is structural: `resolveMetaHarnessClientConfig` only reads and
 * defaults plain fields, never touching npm, a process, or a filesystem
 * path.
 *
 * §D3's `distribution`, `workspace_policy`, `process_policy`, and
 * `diagnostic_policy` sub-shapes are owned by ADR-0026b (process,
 * filesystem, and npm/npx supply chain) — that ADR is explicitly out of
 * scope for this pass (§D7 blocker #1: "reviewed 0.4.1 is not published at
 * the registry state"), so they are typed here as opaque records rather
 * than guessed at in detail.
 */
/**
 * Locked OSS distribution identity (ADR-0026b, out of scope here). Opaque —
 * its exact shape (registry, version pin, digest, Node version range, etc.)
 * belongs to ADR-0026b's distribution manager, which cannot exist yet
 * (ADR-0026a §D7 blocker #1).
 */
type MetaHarnessDistribution = Record<string, unknown>;
/** Workspace containment policy (ADR-0026b, out of scope here). Opaque record. */
type MetaHarnessWorkspacePolicy = Record<string, unknown>;
/** Child-process containment policy (ADR-0026b, out of scope here). Opaque record. */
type MetaHarnessProcessPolicy = Record<string, unknown>;
/**
 * Diagnostic redaction/retention policy (ADR-0026a §D5: "Events are local
 * telemetry inputs subject to ADR-0028 ... Diagnostics use opaque file IDs
 * and workspace-relative paths."). Opaque record — the exact shape is
 * bridge-defined and not yet published.
 */
type MetaHarnessDiagnosticPolicy = Record<string, unknown>;
/** Default warm-bridge-handshake budget — matches §D4's default parser limit table exactly. */
declare const DEFAULT_HANDSHAKE_TIMEOUT_MS = 2000;
/** A single telemetry observation emitted around one MetaHarnessClient operation. */
interface MetaHarnessTelemetryEvent {
    operation: string;
    requestId: string;
    durationMs?: number;
}
/**
 * Caller-supplied telemetry hooks (ADR-0028), matching
 * `MetaProxyTelemetryHooks`'s convention (`../meta-proxy/config.js`). Hooks
 * MUST NOT receive secrets.
 */
interface MetaHarnessTelemetryHooks {
    onRequestStart?(event: Pick<MetaHarnessTelemetryEvent, "operation" | "requestId">): void;
    onRequestEnd?(event: MetaHarnessTelemetryEvent): void;
}
/**
 * Construction config for {@link MetaHarnessClient} (ADR-0026a §D3).
 *
 * Every field is resolved with zero I/O (§D1). None of `distribution`,
 * `workspacePolicy`, or `processPolicy` is read from disk, npm, or the
 * environment here — they are plain caller-supplied values, held as-is.
 */
interface MetaHarnessConfig {
    distribution?: MetaHarnessDistribution;
    workspacePolicy?: MetaHarnessWorkspacePolicy;
    processPolicy?: MetaHarnessProcessPolicy;
    /** Milliseconds. Budget for locating/validating the locked distribution before bridge acquisition (ADR-0026b). */
    acquisitionTimeoutMs?: number;
    /**
     * Milliseconds. Defaults to {@link DEFAULT_HANDSHAKE_TIMEOUT_MS} (2000),
     * matching §D4's "Warm bridge handshake | 2 seconds" default parser limit.
     */
    handshakeTimeoutMs?: number;
    /** Milliseconds. Per-operation budget once a bridge protocol exists (§D4). */
    operationTimeoutMs?: number;
    diagnosticPolicy?: MetaHarnessDiagnosticPolicy;
    /**
     * Feature-flagged preview capabilities this caller opts into (ADR-0026a
     * §D7: "a released SDK may offer only a feature-flagged, read-only
     * development preview with the exact verified distribution"). Opting in
     * to a name here never grants an operation that is otherwise blocked —
     * every §D2 method still fails closed until its upstream capability
     * exists.
     */
    previewFeatures?: string[];
    telemetry?: MetaHarnessTelemetryHooks;
}
/** Normalized, defaulted construction state held by {@link MetaHarnessClient}. */
interface ResolvedMetaHarnessConfig extends MetaHarnessConfig {
    handshakeTimeoutMs: number;
    previewFeatures: string[];
}
/**
 * Validate and normalize a {@link MetaHarnessConfig}. Pure function, no I/O
 * — construction MUST stay side-effect free (ADR-0026a §D1: "Constructors
 * resolve configuration only. They perform no npm access, process spawn,
 * repository read, filesystem write, capability probe, login, or prompt.").
 */
declare function resolveMetaHarnessClientConfig(config?: MetaHarnessConfig): ResolvedMetaHarnessConfig;

/**
 * Browser-runtime rejection for `MetaHarnessClient` (ADR-0026a §D1, ADR-0029
 * §D2).
 *
 * §D1: "Browser imports fail immediately with `UnsupportedRuntimeError` and
 * perform no loopback or registry I/O." A `MetaHarnessClient` spawns a local
 * child process over stdio (§D4) and reads/writes a local workspace
 * (ADR-0026b) — neither is a browser contract, exactly the same reasoning
 * ADR-0025a §D10 / ADR-0029 §D2 give for excluding Meta Proxy.
 *
 * This is a deliberate byte-for-byte port of `../meta-proxy/browser-guard.js`
 * (PR #96) with the product literal changed — the detection heuristic,
 * comments' structure, and fail-closed contract are identical by design so
 * the two guards stay trivially auditable against each other.
 *
 * This package ships one universal build per subpath (no separate
 * browser/node bundle split in `tsup.config.ts`), so "reject ... at build
 * time" is not wired up via conditional bundler exports here — the runtime
 * guard below is what actually enforces §D1/§D2 regardless of which
 * bundler resolves this module. It is checked as literally the first
 * statement of `MetaHarnessClient`'s constructor (`./client.js`), before
 * `resolveMetaHarnessClientConfig` or anything else runs.
 */
/**
 * `true` when the current global environment looks like a browser (or any
 * non-Node runtime lacking Node's `process.versions.node`) rather than
 * Node.js. Detection is deliberately permissive in the "reject" direction:
 * presence of `window`/`document` is browser evidence; ABSENCE of
 * `process.versions.node` is treated the same way, since a bundler that
 * resolved this Node-only entry for a browser target typically strips or
 * never polyfills that field.
 */
declare function isBrowserLikeRuntime(): boolean;
/**
 * Throws {@link UnsupportedRuntimeError} when {@link isBrowserLikeRuntime}
 * is true. Zero I/O — must run before any npm access, process spawn,
 * repository read, filesystem write, capability probe, login, or prompt.
 */
declare function assertNodeRuntime(operation: string): void;

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

/**
 * `MetaHarnessClient` domain types (ADR-0026a §D3). Pure data shapes — no
 * bridge I/O, no process spawn. See `./client.js` for why every operation
 * that would use these types is currently a fail-closed stub (ADR-0026a
 * §D7: the upstream bridge protocol these types describe does not exist
 * yet).
 *
 * Unknown additive fields and unknown enum variants are preserved verbatim
 * wherever the ADR requires it (§D3: "Types preserve unknown additive
 * response fields and unknown event variants. Unknown security-sensitive
 * enums block the dependent mutation or trust claim."), following the same
 * `raw` preservation convention `../meta-proxy/status.ts`'s `parseStatus`
 * uses.
 */

/** A repository already materialized on local disk (ADR-0026a §D3). */
interface LocalRepository {
    kind: "local";
    canonicalPath: string;
    expectedTreeDigest?: string;
}
/** A repository resolved from a remote Git URL to one exact commit (ADR-0026a §D3). */
interface GitRepository {
    kind: "git";
    url: string;
    requestedRef?: string;
    resolvedCommitSha: string;
    credentialReference?: string;
}
/** `RepositorySource = LocalRepository | GitRepository` (ADR-0026a §D3), tagged by `kind`. */
type RepositorySource = LocalRepository | GitRepository;
declare const SCAFFOLD_REQUEST_SCHEMA_V1: "cognitum.metaharness.scaffold-request.v1";
/** A non-mutating request to plan a new harness scaffold (ADR-0026a §D2, §D3). */
interface ScaffoldRequestV1 {
    schema: typeof SCAFFOLD_REQUEST_SCHEMA_V1;
    name: string;
    template: string;
    primaryHost?: string;
    hosts: string[];
    description?: string;
    target: string;
    /**
     * ADR-0026a §D3 names this field without further specifying its shape;
     * the upstream OSS generator's exact `darwin` semantics belong to the
     * bridge contract (ADR-0026b, blocked per §D7). Typed as `unknown` rather
     * than guessed at — same convention as `MetaProxyUpstreamReceipt`
     * (`../meta-proxy/envelope.js`).
     */
    darwin: unknown;
    repositorySource?: RepositorySource;
}
declare const SCAFFOLD_PLAN_SCHEMA_V1: "cognitum.metaharness.scaffold-plan.v1";
/**
 * One planned filesystem action (ADR-0026a §D3: "actions: List<FileAction>").
 * The ADR does not enumerate `kind`'s exact values, so unknown additive
 * fields are preserved verbatim under `raw` rather than dropped.
 */
interface FileAction {
    kind: string;
    path: string;
    contentDigest?: string;
    raw?: Record<string, unknown>;
}
/** Generator product identity captured in a `ScaffoldPlan` (ADR-0026a §D3, §D4 hello). */
interface GeneratorIdentity {
    product: string;
    packageVersion?: string;
    generatorVersion?: string;
    sourceRevision?: string;
    raw?: Record<string, unknown>;
}
/** Template identity captured in a `ScaffoldPlan` (ADR-0026a §D3). */
interface TemplateIdentity {
    template: string;
    templateVersion?: string;
    raw?: Record<string, unknown>;
}
/** A deterministic, non-mutating scaffold plan (ADR-0026a §D2, §D3). */
interface ScaffoldPlan {
    schema: typeof SCAFFOLD_PLAN_SCHEMA_V1;
    planId: string;
    planDigest: string;
    createdAt: string;
    expiresAt: string;
    generatorIdentity: GeneratorIdentity;
    templateIdentity: TemplateIdentity;
    repositoryCommit?: string;
    canonicalTarget: string;
    targetBeforeDigest: string;
    requestDigest: string;
    actions: FileAction[];
    unresolvedVariables: string[];
    warnings: string[];
    destructive: boolean;
    estimatedFiles: number;
    estimatedBytes: number;
    /** Unknown additive fields preserved verbatim (ADR-0026a §D3). */
    raw?: Record<string, unknown>;
}
/** Caller approval binding one `scaffold()` call to an unexpired `ScaffoldPlan` (ADR-0026a §D2, §D3). */
interface ApplyApproval {
    planDigest: string;
    approvedAt: string;
    /** Opaque label, not an identity assertion (ADR-0026a §D3). */
    approvedBy?: string;
}
declare const SCAFFOLD_RESULT_SCHEMA_V1: "cognitum.metaharness.scaffold-result.v1";
/**
 * The one terminal process outcome (ADR-0026a §D5). `cancelled_after_commit`
 * still returns the committed result plus a cancellation flag rather than
 * pretending rollback occurred; `indeterminate_mutation` is high-severity
 * and blocks automatic recovery.
 */
type ProcessCommitOutcome = "succeeded" | "failed" | "cancelled_before_commit" | "cancelled_after_commit" | "indeterminate_mutation";
/** One file materialized by a completed `scaffold()` call (ADR-0026a §D3). */
interface GeneratedFile {
    path: string;
    contentDigest?: string;
    raw?: Record<string, unknown>;
}
/**
 * The upstream harness manifest, fields preserved verbatim (ADR-0026a §D3:
 * "The actual manifest fields are preserved: `schema`, `generator`,
 * `template`, `template_version`, `vars`, `hosts`, `files`, `generated_at`,
 * and optional `meta`."). Package version, generator version, template
 * version, bridge protocol, and source revision are independent — the SDK
 * never infers one from another.
 */
interface HarnessManifest {
    schema: string;
    generator: string;
    template: string;
    templateVersion: string;
    vars: Record<string, unknown>;
    hosts: string[];
    files: string[];
    generatedAt: string;
    meta?: Record<string, unknown>;
    /** Unknown additive fields preserved verbatim (ADR-0026a §D3). */
    raw?: Record<string, unknown>;
}
/** The result of a completed, committed (or cancelled) `scaffold()` call (ADR-0026a §D2, §D3). */
interface ScaffoldResult {
    schema: typeof SCAFFOLD_RESULT_SCHEMA_V1;
    planDigest: string;
    manifest: HarnessManifest;
    files: GeneratedFile[];
    targetAfterDigest: string;
    unresolvedVariables: string[];
    commitOutcome: ProcessCommitOutcome;
    verification: WitnessVerification;
    /** Unknown additive fields preserved verbatim (ADR-0026a §D3). */
    raw?: Record<string, unknown>;
}
/**
 * Witness verification result (ADR-0026a §D3, wrapping ADR-0028's five-level
 * `VerificationResult` from `../agentic/index.js` — never duplicated).
 * `WitnessVerification(verification.level="shape", valid=true)` is never
 * logged or serialized as cryptographically verified (§D3).
 */
interface WitnessVerification {
    verification: VerificationResult;
    witnessSchema?: string;
    manifestDigest?: string;
    entryDigests?: string[];
    /** Unknown additive fields preserved verbatim, per §D3/§D6. */
    rawUnknown?: Record<string, unknown>;
}
/** One entry of `listTemplates()` (ADR-0026a §D2: "descriptor lists"). */
interface TemplateDescriptor {
    id: string;
    raw?: Record<string, unknown>;
}
/** One entry of `listHosts()` (ADR-0026a §D2: "descriptor lists"). */
interface HostDescriptor {
    id: string;
    raw?: Record<string, unknown>;
}
/**
 * Opaque payload types for operations whose result shape is entirely
 * bridge-defined and unpublished (ADR-0026a §D7 blockers #1-#3). Typed as
 * `unknown` rather than guessed at, matching `MetaProxyUpstreamReceipt`'s
 * convention (`../meta-proxy/envelope.js`).
 */
type RepositoryAnalysis = unknown;
type RepositoryScore = unknown;
type HarnessValidationResult = unknown;
type HarnessComparisonResult = unknown;
/**
 * Lifecycle states for a locally owned process operation (ADR-0026a §D2,
 * §D5). Non-terminal states mirror `OperationState`
 * (`../agentic/operations.js`); terminal states are §D5's five normative
 * process outcomes verbatim.
 */
type ProcessRunState = "pending" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled_before_commit" | "cancelled_after_commit" | "indeterminate_mutation";
/**
 * `ProcessRun<T>` (ADR-0026a §D2): "a locally owned process operation ...
 * It is not a server-owned `OperationHandle`. Closing a client cancels only
 * processes owned by that client." No implementation of this interface
 * ships in this pass — every §D2 method fails closed (`./client.js`) before
 * a bridge process, and therefore a `ProcessRun`, is ever created. The type
 * exists so the declared method signatures below are visible and
 * documented even while blocked.
 */
interface ProcessRun<T> {
    readonly id: string;
    readonly state: ProcessRunState;
    events(): AsyncIterable<unknown>;
    result(): Promise<T>;
    cancel(reason?: string): Promise<void>;
}
/**
 * Parse a raw wire manifest object into {@link HarnessManifest}, preserving
 * every field not in the ADR-0026a §D3 known-fields list under `raw` rather
 * than dropping it.
 */
declare function parseHarnessManifest(data: Record<string, unknown>): HarnessManifest;
/**
 * Parse a raw wire witness-verification object into {@link WitnessVerification}.
 *
 * Fails closed on an unrecognized `verification.level` (ADR-0026a §D3/§D6:
 * "Unknown security-sensitive enums block the dependent mutation or trust
 * claim.") — an unknown level is coerced to `"none"`/`valid: false` rather
 * than passed through as a trust claim the rest of this SDK does not
 * recognize.
 */
declare function parseWitnessVerification(data: Record<string, unknown>): WitnessVerification;

/**
 * `MetaHarnessClient` (ADR-0026a). Issue #64 / M4 start.
 *
 * This pass implements exactly §D1 (construction — zero I/O, browser guard)
 * and the §D2 public method SIGNATURES, every one of which is a fail-closed
 * stub that throws {@link UnsupportedCapabilityError} BEFORE any process,
 * network, or filesystem access.
 *
 * §D7 states the reason directly: the OSS `metaharness` package has no
 * published `bridge --stdio` protocol (or any versioned machine contract)
 * this client could talk to yet. Seven concrete blockers are listed:
 *
 *   1. reviewed 0.4.1 is not published at the registry state;
 *   2. no versioned JSONL bridge covers the SDK operations;
 *   3. package/generator/template versions disagree and output/cancel is
 *      nonuniform;
 *   4. `from-repo` is mutable and unresolved variables do not fail by
 *      default;
 *   5. witness docs, runtime shape, verification, and publish claims
 *      disagree;
 *   6. wrapper result/dependency is stale and private CLI collides/
 *      process-exits;
 *   7. external-template and full-eject flags overstate implemented
 *      behavior.
 *
 * Until these close, "a released SDK may offer only a feature-flagged,
 * read-only development preview" (§D7) — which is not yet the case here:
 * every operational method fails closed, full stop. This mirrors how
 * `MetaProxyClient`'s M3-start pass (`../meta-proxy/client.js`) declared
 * ONLY `status`/`capabilities` as real methods and omitted everything else
 * — except here essentially the ENTIRE §D2 surface is blocked (even
 * `capabilities()` itself: there is no bridge `hello` handshake to answer
 * it), so every method is declared as a stub rather than omitted, per this
 * ADR's explicit instruction that the shape be visible while blocked.
 *
 * Construction mirrors `MetaProxyClient`'s conventions exactly
 * (`../meta-proxy/client.js`): a resolved config object and the same
 * telemetry-hook shape, with the browser-runtime guard
 * (`./browser-guard.js`, ported byte-for-byte from Meta Proxy's PR #96)
 * checked first, before config resolution.
 *
 * Explicitly out of scope this pass (do not attempt): any real npm package
 * acquisition/version checking (ADR-0026b), any actual child-process spawn
 * or JSON-Lines bridge communication, any real scaffold/analyze/score/
 * witness-verify logic, and the optional `MetaHarnessProxyLifecycleProvider`
 * adapter (needs ADR-0025b, not started).
 */

/** Optional per-call request context, matching the shared agentic convention. */
interface MetaHarnessCallOptions {
    requestContext?: Record<string, unknown>;
}
/**
 * Client for the OSS MetaHarness local generator/verifier, backed by a
 * versioned JSON Lines process bridge that does not exist upstream yet
 * (ADR-0026a). `MetaHarnessClient` never composes Meta LLM, Meta Proxy,
 * HarnessaaS, or the private commercial `@cognitum-one/metaharness` CLI
 * (§D1) — it is the OSS generator's bounded-context client, full stop.
 *
 * Every method is `blocked` maturity this pass (ADR-0026a §D7: "Until
 * blockers 1 through 7 close, a released SDK may offer only a feature-
 * flagged, read-only development preview"). Construction never starts,
 * installs, authenticates, probes, or reconfigures a process (§D1).
 */
declare class MetaHarnessClient {
    private readonly config;
    constructor(config?: MetaHarnessConfig);
    /** Read-only view of the effective configuration. */
    getConfig(): ResolvedMetaHarnessConfig;
    /**
     * Versioned behavior safe for this caller (ADR-0026a §D2). Blocked this
     * pass: there is no bridge `hello` handshake (§D4) to answer it, so even
     * capability discovery fails closed rather than guessing.
     */
    capabilities(_options?: MetaHarnessCallOptions): Promise<CapabilitySet>;
    /** Catalog of source-defined templates (ADR-0026a §D2, Context: "20 source-defined templates"). */
    listTemplates(_options?: MetaHarnessCallOptions): Promise<TemplateDescriptor[]>;
    /** Catalog of source-defined hosts (ADR-0026a §D2, Context: "nine source-defined hosts"). */
    listHosts(_options?: MetaHarnessCallOptions): Promise<HostDescriptor[]>;
    /** Immutable analysis of a repository (ADR-0026a §D2, §D7). */
    analyzeRepository(_source: RepositorySource, _options?: MetaHarnessCallOptions): Promise<ProcessRun<RepositoryAnalysis>>;
    /** Immutable scoring of a repository (ADR-0026a §D2, §D7). */
    scoreRepository(_source: RepositorySource, _options?: MetaHarnessCallOptions): Promise<ProcessRun<RepositoryScore>>;
    /**
     * Non-mutating scaffold planning (ADR-0026a §D2: "`planScaffold` is
     * non-mutating"). Still blocked — planning requires the same unpublished
     * bridge as every other operation.
     */
    planScaffold(_request: ScaffoldRequestV1, _options?: MetaHarnessCallOptions): Promise<ProcessRun<ScaffoldPlan>>;
    /**
     * Apply a still-valid `ScaffoldPlan` with matching `ApplyApproval`
     * (ADR-0026a §D2). No `force`, no plan-and-apply convenience — the ADR
     * explicitly forbids eroding the plan/apply review boundary. Blocked
     * pending ADR-0026b's commit/cancel/recovery gates in addition to the
     * bridge itself.
     */
    scaffold(_plan: ScaffoldPlan, _approval: ApplyApproval, _options?: MetaHarnessCallOptions): Promise<ProcessRun<ScaffoldResult>>;
    /** Inspect an existing harness manifest (ADR-0026a §D2, §D3). */
    inspectManifest(_target: RepositorySource, _options?: MetaHarnessCallOptions): Promise<ProcessRun<HarnessManifest>>;
    /** Validate an existing harness against its manifest (ADR-0026a §D2). */
    validateHarness(_target: RepositorySource, _options?: MetaHarnessCallOptions): Promise<ProcessRun<HarnessValidationResult>>;
    /** Compare two harnesses (ADR-0026a §D2). */
    compareHarnesses(_a: RepositorySource, _b: RepositorySource, _options?: MetaHarnessCallOptions): Promise<ProcessRun<HarnessComparisonResult>>;
    /**
     * Verify a witness at the requested level (ADR-0026a §D2, §D6). Blocked
     * for every level — even `shape`, the weakest, requires the bridge/kernel
     * this pass does not have (§D7 blocker #5).
     */
    verifyWitness(_workspaceOrWitness: RepositorySource | WitnessVerification, _options?: MetaHarnessCallOptions): Promise<ProcessRun<WitnessVerification>>;
    /**
     * Cancel only processes owned by this client (ADR-0026a §D2: "Closing a
     * client cancels only processes owned by that client. It does not cancel
     * a HarnessaaS job, stop Meta Proxy, or kill a separately launched
     * MetaHarness CLI."). A real no-op this pass: no bridge process is ever
     * spawned by any method above, so there is nothing to release.
     */
    close(): Promise<void>;
}

export { type ApplyApproval, DEFAULT_HANDSHAKE_TIMEOUT_MS, type FileAction, type GeneratedFile, type GeneratorIdentity, type GitRepository, type HarnessComparisonResult, type HarnessManifest, type HarnessValidationResult, type HostDescriptor, type LocalRepository, type MetaHarnessCallOptions, MetaHarnessClient, type MetaHarnessConfig, type MetaHarnessDiagnosticPolicy, type MetaHarnessDistribution, type MetaHarnessProcessPolicy, type MetaHarnessTelemetryEvent, type MetaHarnessTelemetryHooks, type MetaHarnessWorkspacePolicy, type ProcessCommitOutcome, type ProcessRun, type ProcessRunState, type RepositoryAnalysis, type RepositoryScore, type RepositorySource, type ResolvedMetaHarnessConfig, SCAFFOLD_PLAN_SCHEMA_V1, SCAFFOLD_REQUEST_SCHEMA_V1, SCAFFOLD_RESULT_SCHEMA_V1, type ScaffoldPlan, type ScaffoldRequestV1, type ScaffoldResult, type TemplateDescriptor, type TemplateIdentity, type WitnessVerification, assertNodeRuntime, isBrowserLikeRuntime, parseHarnessManifest, parseWitnessVerification, resolveMetaHarnessClientConfig };
