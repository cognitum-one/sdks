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
export type HarnessaaSVertical =
  | "code-repair"
  | "security-remediation"
  | "dependency-migration"
  | "test-generation";

/**
 * A single solve request (`src/types.ts:572-624`'s `SolveRequest`, core
 * `code-repair` fields only this pass — see module doc comment).
 */
export interface HarnessaaSSolveRequest {
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
export function toSolveRequestWire(request: HarnessaaSSolveRequest): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    repo: request.repo,
    test_command: request.testCommand,
    issue: request.issue,
  };
  if (request.w !== undefined) wire.w = request.w;
  if (request.vertical !== undefined) wire.vertical = request.vertical;
  return wire;
}

/**
 * `CostReceipt` (`src/types.ts:728-761`). Core fields modeled directly;
 * the vertical-specific `field_coverage`/`compliance_scope` manifests are
 * folded into `raw` rather than typed this pass (out of scope — see
 * module doc comment).
 */
export interface HarnessaaSCostReceipt {
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
export interface HarnessaaSConformanceAttestation {
  usedOracleDuringSolve: false;
  /** Human-readable statement of what was (and was not) visible to the solver. */
  statement: string;
  /** SHA-256 over the solve inputs the model was actually allowed to see. */
  visibleInputsDigest: string;
}

/** The full response from a solve (`src/types.ts:862-870`'s `SolveResponse`). */
export interface HarnessaaSSolveResponse {
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
export function parseCostReceipt(value: unknown): HarnessaaSCostReceipt {
  const raw = (value ?? {}) as Record<string, unknown>;
  const known = new Set([
    "request_id",
    "model",
    "mode",
    "tokens_in",
    "tokens_out",
    "cost_usd",
    "route",
    "escalated",
    "ledger_refs",
    "cache_hits",
    "cached_read_tokens",
    "batched",
  ]);
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) rest[key] = raw[key];
  }
  return {
    requestId: String(raw.request_id ?? ""),
    model: String(raw.model ?? ""),
    mode: String(raw.mode ?? ""),
    tokensIn: Number(raw.tokens_in ?? 0),
    tokensOut: Number(raw.tokens_out ?? 0),
    costUsd: Number(raw.cost_usd ?? 0),
    route: String(raw.route ?? ""),
    escalated: Boolean(raw.escalated),
    ledgerRefs: Array.isArray(raw.ledger_refs) ? (raw.ledger_refs as string[]) : undefined,
    cacheHits: typeof raw.cache_hits === "number" ? raw.cache_hits : undefined,
    cachedReadTokens: typeof raw.cached_read_tokens === "number" ? raw.cached_read_tokens : undefined,
    batched: typeof raw.batched === "number" ? raw.batched : undefined,
    raw: Object.keys(rest).length > 0 ? rest : undefined,
  };
}

/** Parse a raw JSON `ConformanceAttestation` body into {@link HarnessaaSConformanceAttestation}. */
export function parseConformanceAttestation(value: unknown): HarnessaaSConformanceAttestation {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    usedOracleDuringSolve: false,
    statement: String(raw.statement ?? ""),
    visibleInputsDigest: String(raw.visibleInputsDigest ?? raw.visible_inputs_digest ?? ""),
  };
}

/** Parse a raw `POST /solve` JSON body into {@link HarnessaaSSolveResponse}. */
export function parseSolveResponse(value: unknown): HarnessaaSSolveResponse {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    requestId: String(raw.request_id ?? ""),
    patch: String(raw.patch ?? ""),
    resolved: Boolean(raw.resolved),
    costReceipt: parseCostReceipt(raw.cost_receipt),
    lineageRef: String(raw.lineage_ref ?? ""),
    conformance: parseConformanceAttestation(raw.conformance),
  };
}

/**
 * A single lineage entry (`src/types.ts:799-825`'s `LineageRecord`). Kept
 * permissive (`raw` passthrough for genome/route/vertical-specific fields)
 * rather than a full 1:1 model — no OpenAPI/JSON-Schema contract is
 * published for this shape yet (ADR-0027a §D11 blocker #1).
 */
export interface HarnessaaSLineageRecord {
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
export interface HarnessaaSLineageResult {
  requestId: string;
  records: HarnessaaSLineageRecord[];
}

function parseLineageRecord(value: unknown): HarnessaaSLineageRecord {
  const raw = (value ?? {}) as Record<string, unknown>;
  const known = new Set(["request_id", "account_id", "ts", "prev_hash", "hash"]);
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) rest[key] = raw[key];
  }
  return {
    requestId: String(raw.request_id ?? ""),
    accountId: typeof raw.account_id === "string" ? raw.account_id : undefined,
    ts: String(raw.ts ?? ""),
    prevHash: String(raw.prev_hash ?? ""),
    hash: String(raw.hash ?? ""),
    raw: rest,
  };
}

/** Parse a raw `GET /lineage/:id` JSON body into {@link HarnessaaSLineageResult}. */
export function parseLineageResult(value: unknown): HarnessaaSLineageResult {
  const raw = (value ?? {}) as Record<string, unknown>;
  const records = Array.isArray(raw.records) ? raw.records.map(parseLineageRecord) : [];
  return {
    requestId: String(raw.request_id ?? ""),
    records,
  };
}
