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

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  CostObservation,
  ExecutionReceipt,
  LineageReference,
  VerificationLevel,
  VerificationResult,
} from "./receipts.js";

const CANONICALIZATION_VERSION = "cognitum-canonical-json-v1";
const LEVEL_ORDER: VerificationLevel[] = [
  "none",
  "shape",
  "digest",
  "cryptographic",
  "anchored",
];
const COST_FINALITIES = new Set([
  "estimate",
  "reserved",
  "committed",
  "provider_reported",
  "invoiced",
]);

function levelIndex(level: VerificationLevel): number {
  return LEVEL_ORDER.indexOf(level);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Deterministic JSON: recursively sorted object keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export function sha256Hex(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

function hmacSha256Hex(key: Uint8Array, bytes: string): string {
  return createHmac("sha256", Buffer.from(key)).update(bytes, "utf8").digest("hex");
}

function constantTimeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function receiptSignablePayload(r: ExecutionReceipt): Record<string, unknown> {
  const { signature: _signature, verification: _verification, ...rest } = r;
  return rest as unknown as Record<string, unknown>;
}

function lineageSignablePayload(l: LineageReference): Record<string, unknown> {
  const { signature: _signature, verification: _verification, ...rest } = l;
  return rest as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface BuildExecutionReceiptInput {
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
export function buildExecutionReceipt(input: BuildExecutionReceiptInput): ExecutionReceipt {
  const checkedAt = input.now ? input.now() : new Date().toISOString();
  const base: Omit<ExecutionReceipt, "signature" | "verification"> = {
    schema: "cognitum.execution-receipt.v1",
    receiptId: input.receiptId,
    product: input.product,
    contractVersion: input.contractVersion,
    subject: {
      requestId: input.requestId,
      operationId: input.operationId,
      tenantHash: input.tenantHash,
    },
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    usage: input.usage,
    costs: input.costs ?? [],
    outcome: input.outcome,
    artifactDigests: input.artifactDigests,
    lineageRoot: input.lineageRoot,
    canonicalization: CANONICALIZATION_VERSION,
    issuer: input.issuer,
    keyId: input.keyId,
  };

  const signature = input.sign ? input.sign(canonicalJson(base)) : undefined;

  const receipt: ExecutionReceipt = {
    ...base,
    signature,
    verification: { level: "none", valid: false, checkedAt },
  };

  const shapeFailure = shapeCheckExecutionReceipt(receipt);
  receipt.verification = shapeFailure
    ? { level: "none", valid: false, checkedAt, failure: shapeFailure }
    : { level: "shape", valid: true, checkedAt };

  return receipt;
}

// ---------------------------------------------------------------------------
// Shape checks (structural completeness only — §D8 `shape`)
// ---------------------------------------------------------------------------

export function shapeCheckExecutionReceipt(r: ExecutionReceipt): string | undefined {
  if (r.schema !== "cognitum.execution-receipt.v1") return "unexpected schema tag";
  if (!r.receiptId) return "receiptId is required";
  if (!r.product) return "product is required";
  if (!r.contractVersion) return "contractVersion is required";
  if (!r.subject?.requestId) return "subject.requestId is required";
  if (!r.startedAt || Number.isNaN(Date.parse(r.startedAt))) {
    return "startedAt must be a parseable timestamp";
  }
  if (r.completedAt) {
    const completed = Date.parse(r.completedAt);
    if (Number.isNaN(completed)) return "completedAt must be a parseable timestamp";
    if (completed < Date.parse(r.startedAt)) return "completedAt precedes startedAt";
  }
  if (!r.outcome) return "outcome is required";
  for (const cost of r.costs ?? []) {
    if (!cost.source) return "cost.source is required";
    if (!Number.isFinite(cost.amount)) return "cost.amount must be a finite number";
    if (!cost.currency) return "cost.currency is required";
    if (!COST_FINALITIES.has(cost.finality)) return `unknown cost.finality: ${cost.finality}`;
  }
  return undefined;
}

export function shapeCheckLineageReference(l: LineageReference): string | undefined {
  if (l.schema !== "cognitum.lineage-reference.v1") return "unexpected schema tag";
  if (!l.subject?.requestId) return "subject.requestId is required";
  if (l.sequence !== undefined && (!Number.isInteger(l.sequence) || l.sequence < 0)) {
    return "sequence must be a non-negative integer";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Verification (§D8 verification levels)
// ---------------------------------------------------------------------------

export interface VerifyReceiptOptions {
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
export function verifyExecutionReceipt(
  receipt: ExecutionReceipt,
  opts: VerifyReceiptOptions,
): VerificationResult {
  const checkedAt = opts.now ? opts.now() : new Date().toISOString();
  const warnings: string[] = [];

  const shapeFailure = shapeCheckExecutionReceipt(receipt);
  if (shapeFailure) {
    return { level: "none", valid: false, checkedAt, failure: shapeFailure };
  }

  let achieved: VerificationLevel = "shape";
  const canonicalBytes = canonicalJson(receiptSignablePayload(receipt));
  const subjectDigest = sha256Hex(canonicalBytes);
  let algorithm: string | undefined;

  if (opts.expectedDigest) {
    if (opts.expectedDigest === subjectDigest) {
      achieved = "digest";
    } else {
      warnings.push("expected digest mismatch");
    }
  }

  if (receipt.signature && receipt.issuer && receipt.keyId) {
    if (!opts.resolveKey) {
      warnings.push("no key resolver supplied; cannot verify signature");
    } else {
      const key = opts.resolveKey(receipt.issuer, receipt.keyId);
      if (!key) {
        warnings.push(`unknown key '${receipt.keyId}' for issuer '${receipt.issuer}'`);
      } else {
        const expectedSig = hmacSha256Hex(key, canonicalBytes);
        if (constantTimeHexEqual(expectedSig, receipt.signature)) {
          achieved = "cryptographic";
          algorithm = "hmac-sha256";
        } else {
          const failure = "signature does not match canonical bytes";
          return { level: "none", valid: false, checkedAt, subjectDigest, failure };
        }
      }
    }
  } else if (levelIndex(opts.minLevel) >= levelIndex("cryptographic")) {
    warnings.push("receipt carries no signature/issuer/keyId claim");
  }

  if (achieved === "cryptographic" && receipt.lineageRoot && opts.checkAnchor) {
    if (opts.checkAnchor(receipt.lineageRoot)) {
      achieved = "anchored";
    } else {
      warnings.push("anchor check did not confirm durable checkpoint");
    }
  }

  const valid = levelIndex(achieved) >= levelIndex(opts.minLevel);
  return {
    level: achieved,
    valid,
    algorithm,
    keyId: receipt.keyId,
    checkedAt,
    subjectDigest,
    warnings: warnings.length ? warnings : undefined,
    failure: valid ? undefined : `minimum level '${opts.minLevel}' not reached (achieved '${achieved}')`,
  };
}

// ---------------------------------------------------------------------------
// Lineage chain (§D9) — structural chain validation
// ---------------------------------------------------------------------------

export interface VerifyLineageChainOptions {
  minLevel: VerificationLevel;
  resolveKey?: (issuer: string, keyId: string) => Uint8Array | undefined;
  maxCheckpointAgeMs?: number;
  now?: () => string;
}

export interface LineageChainVerification {
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
export function verifyLineageChain(
  chain: LineageReference[],
  opts: VerifyLineageChainOptions,
): LineageChainVerification {
  const checkedAt = opts.now ? opts.now() : new Date().toISOString();
  const results: VerificationResult[] = [];

  if (chain.length === 0) {
    return { valid: false, level: "none", results, failure: "lineage chain is empty" };
  }

  const seenRoots = new Set<string>();
  let minAchieved: VerificationLevel = "anchored";
  // The genesis entry (i === 0) has no predecessor to link against, so it
  // can never reach "digest" on its own -- that's not a weak link, it's
  // simply not applicable. It only counts toward the chain's overall level
  // when the chain has exactly one entry (nothing else to fold in).
  let genesisAchieved: VerificationLevel | undefined;

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    const shapeFailure = shapeCheckLineageReference(entry);
    if (shapeFailure) {
      results.push({ level: "none", valid: false, checkedAt, failure: shapeFailure });
      return { valid: false, level: "none", brokenAtIndex: i, results, failure: shapeFailure };
    }

    if (entry.root) {
      if (seenRoots.has(entry.root)) {
        const failure = `cycle detected at index ${i} (root already seen)`;
        results.push({ level: "none", valid: false, checkedAt, failure });
        return { valid: false, level: "none", brokenAtIndex: i, results, failure };
      }
      seenRoots.add(entry.root);
    }

    let achieved: VerificationLevel = "shape";
    const warnings: string[] = [];

    if (i > 0) {
      const prev = chain[i - 1];
      if (!entry.previousCheckpoint || entry.previousCheckpoint !== prev.root) {
        const failure = `entry ${i} previousCheckpoint does not resolve to entry ${i - 1} root`;
        results.push({ level: "none", valid: false, checkedAt, failure });
        return { valid: false, level: "none", brokenAtIndex: i, results, failure };
      }
      if (
        entry.sequence !== undefined &&
        prev.sequence !== undefined &&
        entry.sequence <= prev.sequence
      ) {
        const failure = `entry ${i} sequence (${entry.sequence}) is not strictly increasing`;
        results.push({ level: "none", valid: false, checkedAt, failure });
        return { valid: false, level: "none", brokenAtIndex: i, results, failure };
      }
      achieved = "digest";
    }

    if (entry.checkpointTime) {
      const ts = Date.parse(entry.checkpointTime);
      if (Number.isNaN(ts)) {
        warnings.push("checkpointTime not parseable");
      } else if (opts.maxCheckpointAgeMs !== undefined && Date.now() - ts > opts.maxCheckpointAgeMs) {
        warnings.push("checkpoint is stale");
      }
    }

    if (entry.signature && entry.issuer && entry.keyId) {
      if (!opts.resolveKey) {
        warnings.push("no key resolver supplied; cannot verify signature");
      } else {
        const key = opts.resolveKey(entry.issuer, entry.keyId);
        if (!key) {
          warnings.push(`unknown key '${entry.keyId}'`);
        } else {
          const payload = canonicalJson(lineageSignablePayload(entry));
          const expected = hmacSha256Hex(key, payload);
          if (constantTimeHexEqual(expected, entry.signature)) {
            achieved = "cryptographic";
          } else {
            const failure = `entry ${i} signature does not match canonical bytes`;
            results.push({ level: "none", valid: false, checkedAt, failure });
            return { valid: false, level: "none", brokenAtIndex: i, results, failure };
          }
        }
      }
    }

    results.push({
      level: achieved,
      valid: true,
      checkedAt,
      keyId: entry.keyId,
      warnings: warnings.length ? warnings : undefined,
    });
    if (i === 0) {
      genesisAchieved = achieved;
    } else if (levelIndex(achieved) < levelIndex(minAchieved)) {
      minAchieved = achieved;
    }
  }

  if (chain.length === 1) {
    minAchieved = genesisAchieved ?? "shape";
  }

  const valid = levelIndex(minAchieved) >= levelIndex(opts.minLevel);
  return {
    valid,
    level: minAchieved,
    results,
    failure: valid
      ? undefined
      : `minimum level '${opts.minLevel}' not reached across chain (achieved '${minAchieved}')`,
  };
}
