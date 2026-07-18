/**
 * ADR-0024b §D3's `UsageSummary`/`BudgetView`, plus the bounded query the
 * read-only `client.usage()` method (`../client.ts`) accepts.
 *
 * Usage is strictly authenticated-account scoped (§D3) — every query is
 * bound to the caller's own credential; there is no cross-tenant or
 * cross-account parameter anywhere in {@link UsageQuery}. An empty
 * `UsageSummary` is not reinterpreted as "no usage anywhere" vs "this
 * account genuinely has none" (§D3) — `client.usage()` returns whatever
 * the server reports as-is, with no speculative fallback logic layered on
 * top.
 */

import type { Money } from "./money.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface CacheStats {
  hitRate?: number;
  savings?: Money;
  raw?: Record<string, unknown>;
}

export interface UsageTotals {
  requests?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: Money;
  raw?: Record<string, unknown>;
}

/**
 * Plan degradation and reset information are preserved as reported (§D4) —
 * this SDK never recomputes `status`/`headroom` from the other fields.
 */
export interface BudgetView {
  serving?: Money;
  hardLimit?: Money;
  committed?: Money;
  reserved?: Money;
  headroom?: Money;
  status?: string;
  resetsAt?: string;
  raw?: Record<string, unknown>;
}

export interface UsageBreakdownEntry {
  requests?: number;
  cost?: Money;
  raw?: Record<string, unknown>;
}

export interface UsagePeriodEntry extends UsageBreakdownEntry {
  period: string;
}

/** ADR-0024b §D3's `UsageSummary`. */
export interface UsageSummary {
  totals: UsageTotals;
  tierMix?: Record<string, number>;
  escalationRate?: number;
  cache?: CacheStats;
  fallbackRate?: number;
  emptyBilledRate?: number;
  byModel?: Record<string, UsageBreakdownEntry>;
  byProvider?: Record<string, UsageBreakdownEntry>;
  byPeriod?: UsagePeriodEntry[];
  budget?: BudgetView;
  /** Fields present on the wire this decoder does not recognize, preserved verbatim (never dropped). */
  raw?: Record<string, unknown>;
}

/** Bounded `YYYY-MM` query window plus optional grouping (ADR-0024b §D3). */
export interface UsageQuery {
  /** Inclusive `YYYY-MM` start of the query range. */
  from: string;
  /** Inclusive `YYYY-MM` end of the query range. */
  to: string;
  model?: string;
  provider?: string;
  groupBy?: "model" | "provider" | "period";
}

const YYYY_MM = /^\d{4}-(0[1-9]|1[0-2])$/;

export class InvalidUsageQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUsageQueryError";
  }
}

/** Validates the bounded `YYYY-MM` range required by §D3 before any request is sent. */
export function assertValidUsageQuery(query: UsageQuery): void {
  if (!YYYY_MM.test(query.from)) {
    throw new InvalidUsageQueryError(`UsageQuery.from must match YYYY-MM; got ${JSON.stringify(query.from)}`);
  }
  if (!YYYY_MM.test(query.to)) {
    throw new InvalidUsageQueryError(`UsageQuery.to must match YYYY-MM; got ${JSON.stringify(query.to)}`);
  }
  if (query.from > query.to) {
    throw new InvalidUsageQueryError(
      `UsageQuery.from (${JSON.stringify(query.from)}) must not be after .to (${JSON.stringify(query.to)})`,
    );
  }
}

function parseCacheStats(raw: unknown): CacheStats | undefined {
  if (!isRecord(raw)) return undefined;
  const known = new Set(["hit_rate", "hitRate", "savings"]);
  const rawRemainder: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) rawRemainder[key] = value;
  }
  const hitRateRaw = raw.hit_rate ?? raw.hitRate;
  return {
    hitRate: typeof hitRateRaw === "number" ? hitRateRaw : undefined,
    savings: parseMoneyImport(raw.savings),
    raw: Object.keys(rawRemainder).length > 0 ? rawRemainder : undefined,
  };
}

function parseUsageTotals(raw: unknown): UsageTotals {
  if (!isRecord(raw)) return {};
  const known = new Set([
    "requests",
    "prompt_tokens",
    "promptTokens",
    "completion_tokens",
    "completionTokens",
    "total_tokens",
    "totalTokens",
    "cost",
  ]);
  const rawRemainder: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) rawRemainder[key] = value;
  }
  return {
    requests: typeof raw.requests === "number" ? raw.requests : undefined,
    promptTokens: typeof (raw.prompt_tokens ?? raw.promptTokens) === "number" ? (raw.prompt_tokens as number) ?? (raw.promptTokens as number) : undefined,
    completionTokens:
      typeof (raw.completion_tokens ?? raw.completionTokens) === "number"
        ? (raw.completion_tokens as number) ?? (raw.completionTokens as number)
        : undefined,
    totalTokens:
      typeof (raw.total_tokens ?? raw.totalTokens) === "number"
        ? (raw.total_tokens as number) ?? (raw.totalTokens as number)
        : undefined,
    cost: parseMoneyImport(raw.cost),
    raw: Object.keys(rawRemainder).length > 0 ? rawRemainder : undefined,
  };
}

function parseBudgetView(raw: unknown): BudgetView | undefined {
  if (!isRecord(raw)) return undefined;
  const known = new Set([
    "serving",
    "hard_limit",
    "hardLimit",
    "committed",
    "reserved",
    "headroom",
    "status",
    "resets_at",
    "resetsAt",
  ]);
  const rawRemainder: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) rawRemainder[key] = value;
  }
  const resetsAtRaw = raw.resets_at ?? raw.resetsAt;
  return {
    serving: parseMoneyImport(raw.serving),
    hardLimit: parseMoneyImport(raw.hard_limit ?? raw.hardLimit),
    committed: parseMoneyImport(raw.committed),
    reserved: parseMoneyImport(raw.reserved),
    headroom: parseMoneyImport(raw.headroom),
    status: typeof raw.status === "string" ? raw.status : undefined,
    resetsAt: typeof resetsAtRaw === "string" ? resetsAtRaw : undefined,
    raw: Object.keys(rawRemainder).length > 0 ? rawRemainder : undefined,
  };
}

function parseBreakdownEntry(raw: unknown): UsageBreakdownEntry {
  if (!isRecord(raw)) return {};
  const known = new Set(["requests", "cost"]);
  const rawRemainder: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) rawRemainder[key] = value;
  }
  return {
    requests: typeof raw.requests === "number" ? raw.requests : undefined,
    cost: parseMoneyImport(raw.cost),
    raw: Object.keys(rawRemainder).length > 0 ? rawRemainder : undefined,
  };
}

function parseBreakdownMap(raw: unknown): Record<string, UsageBreakdownEntry> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, UsageBreakdownEntry> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = parseBreakdownEntry(value);
  }
  return out;
}

function parsePeriodEntries(raw: unknown): UsagePeriodEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.period === "string")
    .map((item) => ({ period: item.period as string, ...parseBreakdownEntry(item) }));
}

// Re-declared locally to avoid a second import line churning the diff if
// `./money.js`'s export surface changes; keeps this module's parse helpers
// self-contained.
function parseMoneyImport(raw: unknown): Money | undefined {
  if (!isRecord(raw)) return undefined;
  const amountRaw = raw.amount;
  const currency = raw.currency ?? raw.currency_code ?? raw.currencyCode;
  if ((typeof amountRaw === "string" || typeof amountRaw === "number") && typeof currency === "string") {
    return { amount: String(amountRaw), currency };
  }
  return undefined;
}

const KNOWN_USAGE_KEYS = new Set([
  "totals",
  "tier_mix",
  "tierMix",
  "escalation_rate",
  "escalationRate",
  "cache",
  "fallback_rate",
  "fallbackRate",
  "empty_billed_rate",
  "emptyBilledRate",
  "by_model",
  "byModel",
  "by_provider",
  "byProvider",
  "by_period",
  "byPeriod",
  "budget",
]);

/**
 * Parse a raw `/v1/usage` JSON body into a typed {@link UsageSummary}.
 * Never throws — an entirely empty/malformed body decodes to an
 * `UsageSummary` with empty `totals` rather than an error, since an empty
 * result is itself meaningful account-scoped evidence (§D3), not a parse
 * failure.
 */
export function parseUsageSummary(raw: unknown): UsageSummary {
  if (!isRecord(raw)) return { totals: {} };

  const rawRemainder: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_USAGE_KEYS.has(key)) rawRemainder[key] = value;
  }

  const escalationRateRaw = raw.escalation_rate ?? raw.escalationRate;
  const fallbackRateRaw = raw.fallback_rate ?? raw.fallbackRate;
  const emptyBilledRateRaw = raw.empty_billed_rate ?? raw.emptyBilledRate;
  const tierMixRaw = raw.tier_mix ?? raw.tierMix;

  return {
    totals: parseUsageTotals(raw.totals),
    tierMix: isRecord(tierMixRaw) ? (tierMixRaw as Record<string, number>) : undefined,
    escalationRate: typeof escalationRateRaw === "number" ? escalationRateRaw : undefined,
    cache: parseCacheStats(raw.cache),
    fallbackRate: typeof fallbackRateRaw === "number" ? fallbackRateRaw : undefined,
    emptyBilledRate: typeof emptyBilledRateRaw === "number" ? emptyBilledRateRaw : undefined,
    byModel: parseBreakdownMap(raw.by_model ?? raw.byModel),
    byProvider: parseBreakdownMap(raw.by_provider ?? raw.byProvider),
    byPeriod: parsePeriodEntries(raw.by_period ?? raw.byPeriod),
    budget: parseBudgetView(raw.budget),
    raw: Object.keys(rawRemainder).length > 0 ? rawRemainder : undefined,
  };
}
