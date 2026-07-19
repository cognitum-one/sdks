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

import type { VerificationLevel, VerificationResult } from "../agentic/index.js";

// ---------------------------------------------------------------------------
// RepositorySource — §D3 tagged union
// ---------------------------------------------------------------------------

/** A repository already materialized on local disk (ADR-0026a §D3). */
export interface LocalRepository {
  kind: "local";
  canonicalPath: string;
  expectedTreeDigest?: string;
}

/** A repository resolved from a remote Git URL to one exact commit (ADR-0026a §D3). */
export interface GitRepository {
  kind: "git";
  url: string;
  requestedRef?: string;
  resolvedCommitSha: string;
  credentialReference?: string;
}

/** `RepositorySource = LocalRepository | GitRepository` (ADR-0026a §D3), tagged by `kind`. */
export type RepositorySource = LocalRepository | GitRepository;

// ---------------------------------------------------------------------------
// ScaffoldRequestV1
// ---------------------------------------------------------------------------

export const SCAFFOLD_REQUEST_SCHEMA_V1 = "cognitum.metaharness.scaffold-request.v1" as const;

/** A non-mutating request to plan a new harness scaffold (ADR-0026a §D2, §D3). */
export interface ScaffoldRequestV1 {
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

// ---------------------------------------------------------------------------
// ScaffoldPlan
// ---------------------------------------------------------------------------

export const SCAFFOLD_PLAN_SCHEMA_V1 = "cognitum.metaharness.scaffold-plan.v1" as const;

/**
 * One planned filesystem action (ADR-0026a §D3: "actions: List<FileAction>").
 * The ADR does not enumerate `kind`'s exact values, so unknown additive
 * fields are preserved verbatim under `raw` rather than dropped.
 */
export interface FileAction {
  kind: string;
  path: string;
  contentDigest?: string;
  raw?: Record<string, unknown>;
}

/** Generator product identity captured in a `ScaffoldPlan` (ADR-0026a §D3, §D4 hello). */
export interface GeneratorIdentity {
  product: string;
  packageVersion?: string;
  generatorVersion?: string;
  sourceRevision?: string;
  raw?: Record<string, unknown>;
}

/** Template identity captured in a `ScaffoldPlan` (ADR-0026a §D3). */
export interface TemplateIdentity {
  template: string;
  templateVersion?: string;
  raw?: Record<string, unknown>;
}

/** A deterministic, non-mutating scaffold plan (ADR-0026a §D2, §D3). */
export interface ScaffoldPlan {
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

// ---------------------------------------------------------------------------
// ApplyApproval
// ---------------------------------------------------------------------------

/** Caller approval binding one `scaffold()` call to an unexpired `ScaffoldPlan` (ADR-0026a §D2, §D3). */
export interface ApplyApproval {
  planDigest: string;
  approvedAt: string;
  /** Opaque label, not an identity assertion (ADR-0026a §D3). */
  approvedBy?: string;
}

// ---------------------------------------------------------------------------
// ScaffoldResult
// ---------------------------------------------------------------------------

export const SCAFFOLD_RESULT_SCHEMA_V1 = "cognitum.metaharness.scaffold-result.v1" as const;

/**
 * The one terminal process outcome (ADR-0026a §D5). `cancelled_after_commit`
 * still returns the committed result plus a cancellation flag rather than
 * pretending rollback occurred; `indeterminate_mutation` is high-severity
 * and blocks automatic recovery.
 */
export type ProcessCommitOutcome =
  | "succeeded"
  | "failed"
  | "cancelled_before_commit"
  | "cancelled_after_commit"
  | "indeterminate_mutation";

/** One file materialized by a completed `scaffold()` call (ADR-0026a §D3). */
export interface GeneratedFile {
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
export interface HarnessManifest {
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
export interface ScaffoldResult {
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

// ---------------------------------------------------------------------------
// WitnessVerification
// ---------------------------------------------------------------------------

/**
 * Witness verification result (ADR-0026a §D3, wrapping ADR-0028's five-level
 * `VerificationResult` from `../agentic/index.js` — never duplicated).
 * `WitnessVerification(verification.level="shape", valid=true)` is never
 * logged or serialized as cryptographically verified (§D3).
 */
export interface WitnessVerification {
  verification: VerificationResult;
  witnessSchema?: string;
  manifestDigest?: string;
  entryDigests?: string[];
  /** Unknown additive fields preserved verbatim, per §D3/§D6. */
  rawUnknown?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Catalog descriptors, opaque operation results, and ProcessRun (§D2)
// ---------------------------------------------------------------------------

/** One entry of `listTemplates()` (ADR-0026a §D2: "descriptor lists"). */
export interface TemplateDescriptor {
  id: string;
  raw?: Record<string, unknown>;
}

/** One entry of `listHosts()` (ADR-0026a §D2: "descriptor lists"). */
export interface HostDescriptor {
  id: string;
  raw?: Record<string, unknown>;
}

/**
 * Opaque payload types for operations whose result shape is entirely
 * bridge-defined and unpublished (ADR-0026a §D7 blockers #1-#3). Typed as
 * `unknown` rather than guessed at, matching `MetaProxyUpstreamReceipt`'s
 * convention (`../meta-proxy/envelope.js`).
 */
export type RepositoryAnalysis = unknown;
export type RepositoryScore = unknown;
export type HarnessValidationResult = unknown;
export type HarnessComparisonResult = unknown;

/**
 * Lifecycle states for a locally owned process operation (ADR-0026a §D2,
 * §D5). Non-terminal states mirror `OperationState`
 * (`../agentic/operations.js`); terminal states are §D5's five normative
 * process outcomes verbatim.
 */
export type ProcessRunState =
  | "pending"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled_before_commit"
  | "cancelled_after_commit"
  | "indeterminate_mutation";

/**
 * `ProcessRun<T>` (ADR-0026a §D2): "a locally owned process operation ...
 * It is not a server-owned `OperationHandle`. Closing a client cancels only
 * processes owned by that client." No implementation of this interface
 * ships in this pass — every §D2 method fails closed (`./client.js`) before
 * a bridge process, and therefore a `ProcessRun`, is ever created. The type
 * exists so the declared method signatures below are visible and
 * documented even while blocked.
 */
export interface ProcessRun<T> {
  readonly id: string;
  readonly state: ProcessRunState;
  events(): AsyncIterable<unknown>;
  result(): Promise<T>;
  cancel(reason?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Wire parsing helpers — unknown-field / unknown-enum preservation (§D3, §D6)
// ---------------------------------------------------------------------------

const KNOWN_VERIFICATION_LEVELS: ReadonlySet<string> = new Set([
  "none",
  "shape",
  "digest",
  "cryptographic",
  "anchored",
]);

const KNOWN_MANIFEST_KEYS = new Set([
  "schema",
  "generator",
  "template",
  "template_version",
  "templateVersion",
  "vars",
  "hosts",
  "files",
  "generated_at",
  "generatedAt",
  "meta",
]);

function pick(data: Record<string, unknown>, snake: string, camel: string): unknown {
  return data[snake] ?? data[camel];
}

/**
 * Parse a raw wire manifest object into {@link HarnessManifest}, preserving
 * every field not in the ADR-0026a §D3 known-fields list under `raw` rather
 * than dropping it.
 */
export function parseHarnessManifest(data: Record<string, unknown>): HarnessManifest {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!KNOWN_MANIFEST_KEYS.has(key)) raw[key] = value;
  }
  return {
    schema: String(data.schema ?? ""),
    generator: String(data.generator ?? ""),
    template: String(data.template ?? ""),
    templateVersion: String(pick(data, "template_version", "templateVersion") ?? ""),
    vars: (data.vars as Record<string, unknown> | undefined) ?? {},
    hosts: (data.hosts as string[] | undefined) ?? [],
    files: (data.files as string[] | undefined) ?? [],
    generatedAt: String(pick(data, "generated_at", "generatedAt") ?? ""),
    meta: data.meta as Record<string, unknown> | undefined,
    ...(Object.keys(raw).length > 0 ? { raw } : {}),
  };
}

/**
 * Parse a raw wire witness-verification object into {@link WitnessVerification}.
 *
 * Fails closed on an unrecognized `verification.level` (ADR-0026a §D3/§D6:
 * "Unknown security-sensitive enums block the dependent mutation or trust
 * claim.") — an unknown level is coerced to `"none"`/`valid: false` rather
 * than passed through as a trust claim the rest of this SDK does not
 * recognize.
 */
export function parseWitnessVerification(data: Record<string, unknown>): WitnessVerification {
  const verificationRaw = (data.verification as Record<string, unknown> | undefined) ?? {};
  const reportedLevel = verificationRaw.level;
  const levelKnown =
    typeof reportedLevel === "string" && KNOWN_VERIFICATION_LEVELS.has(reportedLevel);
  const level = (levelKnown ? reportedLevel : "none") as VerificationLevel;
  const warnings = Array.isArray(verificationRaw.warnings)
    ? [...(verificationRaw.warnings as string[])]
    : undefined;
  const verification: VerificationResult = {
    level,
    valid: levelKnown ? Boolean(verificationRaw.valid) : false,
    algorithm: verificationRaw.algorithm as string | undefined,
    keyId: pick(verificationRaw, "key_id", "keyId") as string | undefined,
    checkedAt: String(pick(verificationRaw, "checked_at", "checkedAt") ?? ""),
    subjectDigest: pick(verificationRaw, "subject_digest", "subjectDigest") as string | undefined,
    warnings: levelKnown
      ? warnings
      : [
          ...(warnings ?? []),
          `unknown verification level "${String(reportedLevel)}" fails closed to "none" (ADR-0026a §D3/§D6)`,
        ],
    failure: verificationRaw.failure as string | undefined,
  };

  const KNOWN_TOP_KEYS = new Set([
    "verification",
    "witness_schema",
    "witnessSchema",
    "manifest_digest",
    "manifestDigest",
    "entry_digests",
    "entryDigests",
  ]);
  const rawUnknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!KNOWN_TOP_KEYS.has(key)) rawUnknown[key] = value;
  }

  return {
    verification,
    witnessSchema: pick(data, "witness_schema", "witnessSchema") as string | undefined,
    manifestDigest: pick(data, "manifest_digest", "manifestDigest") as string | undefined,
    entryDigests: pick(data, "entry_digests", "entryDigests") as string[] | undefined,
    ...(Object.keys(rawUnknown).length > 0 ? { rawUnknown } : {}),
  };
}
