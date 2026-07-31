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

import type { CostObservation } from "../../agentic/index.js";
import type { Money } from "./money.js";
import { parseMoney } from "./money.js";
import type { ModelTier } from "./routing.js";

/**
 * `resolved_tier` can widen beyond this SDK's known `ModelTier` set as the
 * server evolves — the value is preserved as a plain string rather than
 * dropped or coerced (§D2: "Unknown received values are preserved").
 */
export type ReceiptModelTier = ModelTier | (string & {});

/** Same unknown-preserving treatment as {@link ReceiptModelTier}, for `cache_result`. */
export type ReceiptCacheResult = "hit" | "miss" | "bypass" | (string & {});

/**
 * Only contract-safe detector classes and counts are exposed here (§D4:
 * "Warn and redact expose only contract-safe detector classes and counts.
 * Prompts, matches, secrets, and unredacted content are excluded").
 */
export interface SafetySummary {
  mode?: string;
  detectorClasses?: string[];
  blocked?: boolean;
  /** Unrecognized fields from the server response, preserved verbatim. */
  raw?: Record<string, unknown>;
}

/** ADR-0024b §D3's `MetaLlmReceipt`. */
export interface MetaLlmReceipt {
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

const KNOWN_RECEIPT_KEYS = new Set([
  "request_id",
  "requestId",
  "resolved_tier",
  "resolvedTier",
  "resolved_model",
  "resolvedModel",
  "escalated",
  "cap_degraded",
  "capDegraded",
  "routing_reason",
  "routingReason",
  "price",
  "cache_result",
  "cacheResult",
  "cache_savings",
  "cacheSavings",
  "prompt_cache_savings",
  "promptCacheSavings",
  "fallback_used",
  "fallbackUsed",
  "breaker_counts",
  "breakerCounts",
  "sub_tenant_id",
  "subTenantId",
  "safety_summary",
  "safetySummary",
  "usage",
  "costs",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCostObservation(raw: unknown): CostObservation | undefined {
  if (!isRecord(raw)) return undefined;
  const { source, amount, currency, finality } = raw;
  if (typeof source !== "string" || typeof currency !== "string" || typeof finality !== "string") {
    return undefined;
  }
  // NOTE: `CostObservation.amount` (`../../agentic/receipts.ts`) is a plain
  // `number` from the earlier ADR-0028 stub, not a `Money` — that is an
  // existing gap in `ExecutionReceipt`, out of scope to change here (it is
  // not part of ADR-0024b's `MetaLlmReceipt.costs` field shape decision;
  // reusing the existing type verbatim per the task's own instruction).
  return {
    source,
    amount: typeof amount === "number" ? amount : Number(amount),
    currency,
    finality: finality as CostObservation["finality"],
  };
}

function parseSafetySummary(raw: unknown): SafetySummary | undefined {
  if (!isRecord(raw)) return undefined;
  const known = new Set(["mode", "detector_classes", "detectorClasses", "blocked"]);
  const detectorClassesRaw = raw.detector_classes ?? raw.detectorClasses;
  const rawRemainder: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) rawRemainder[key] = value;
  }
  return {
    mode: typeof raw.mode === "string" ? raw.mode : undefined,
    detectorClasses: Array.isArray(detectorClassesRaw)
      ? detectorClassesRaw.filter((v): v is string => typeof v === "string")
      : undefined,
    blocked: typeof raw.blocked === "boolean" ? raw.blocked : undefined,
    raw: Object.keys(rawRemainder).length > 0 ? rawRemainder : undefined,
  };
}

/**
 * Parse a raw wire `cognitum_receipt` payload into a typed
 * {@link MetaLlmReceipt}. Returns `undefined` for a missing/malformed
 * receipt rather than a shaped empty object (ADR-0024a §D4: "Missing
 * metadata remains missing").
 */
export function parseMetaLlmReceipt(raw: unknown): MetaLlmReceipt | undefined {
  if (!isRecord(raw)) return undefined;
  const requestIdRaw = raw.request_id ?? raw.requestId;
  // A receipt missing `request_id` is anomalous but still preserved rather
  // than discarded wholesale — every other field (including `raw`) is
  // still extracted below, just with `requestId` defaulted to `""` instead
  // of dropping the whole receipt (and, with it, cost/routing evidence the
  // server did send).
  const requestId = typeof requestIdRaw === "string" ? requestIdRaw : "";

  const costsRaw = raw.costs;
  const costs = Array.isArray(costsRaw)
    ? costsRaw.map(parseCostObservation).filter((c): c is CostObservation => c !== undefined)
    : [];

  const rawRemainder: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_RECEIPT_KEYS.has(key)) rawRemainder[key] = value;
  }

  const resolvedTierRaw = raw.resolved_tier ?? raw.resolvedTier;
  const resolvedModelRaw = raw.resolved_model ?? raw.resolvedModel;
  const capDegradedRaw = raw.cap_degraded ?? raw.capDegraded;
  const routingReasonRaw = raw.routing_reason ?? raw.routingReason;
  const cacheResultRaw = raw.cache_result ?? raw.cacheResult;
  const fallbackUsedRaw = raw.fallback_used ?? raw.fallbackUsed;
  const breakerCountsRaw = raw.breaker_counts ?? raw.breakerCounts;
  const subTenantIdRaw = raw.sub_tenant_id ?? raw.subTenantId;

  return {
    requestId,
    resolvedTier: typeof resolvedTierRaw === "string" ? (resolvedTierRaw as ReceiptModelTier) : undefined,
    resolvedModel: typeof resolvedModelRaw === "string" ? resolvedModelRaw : undefined,
    escalated: typeof raw.escalated === "boolean" ? raw.escalated : undefined,
    capDegraded: typeof capDegradedRaw === "boolean" ? capDegradedRaw : undefined,
    routingReason: typeof routingReasonRaw === "string" ? routingReasonRaw : undefined,
    price: parseMoney(raw.price),
    cacheResult: typeof cacheResultRaw === "string" ? (cacheResultRaw as ReceiptCacheResult) : undefined,
    cacheSavings: parseMoney(raw.cache_savings ?? raw.cacheSavings),
    promptCacheSavings: parseMoney(raw.prompt_cache_savings ?? raw.promptCacheSavings),
    fallbackUsed: typeof fallbackUsedRaw === "boolean" ? fallbackUsedRaw : undefined,
    breakerCounts: isRecord(breakerCountsRaw) ? (breakerCountsRaw as Record<string, number>) : undefined,
    subTenantId: typeof subTenantIdRaw === "string" ? subTenantIdRaw : undefined,
    safetySummary: parseSafetySummary(raw.safety_summary ?? raw.safetySummary),
    usage: isRecord(raw.usage) ? raw.usage : undefined,
    costs,
    raw: Object.keys(rawRemainder).length > 0 ? rawRemainder : undefined,
  };
}
