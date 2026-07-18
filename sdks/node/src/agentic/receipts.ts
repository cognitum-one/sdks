/**
 * ExecutionReceipt / LineageReference type-only stubs (ADR-0028 §D7, §D9).
 * Tracking issue #56 builds these out further (verification, canonical
 * bytes, signature checks). This pass only freezes the field shapes.
 */

/** Ordered guarantee levels for any artifact/witness/receipt/lineage check (ADR-0028 §D8). */
export type VerificationLevel =
  | "none"
  | "shape"
  | "digest"
  | "cryptographic"
  | "anchored";

/** Tagged verification outcome. `valid=true` at `shape` MUST NOT satisfy a `cryptographic` requirement. */
export interface VerificationResult {
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
export type CostFinality =
  | "estimate"
  | "reserved"
  | "committed"
  | "provider_reported"
  | "invoiced";

/** A single labeled cost observation (ADR-0022 §D6 distinct-fields rule). */
export interface CostObservation {
  source: string;
  amount: number;
  currency: string;
  finality: CostFinality;
}

/** Verifiable common receipt envelope, v1 (ADR-0028 §D7). Type-only stub — issue #56. */
export interface ExecutionReceipt {
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
export interface LineageReference {
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
