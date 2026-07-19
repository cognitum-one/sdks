"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/meta-llm/index.ts
var meta_llm_exports = {};
__export(meta_llm_exports, {
  ChatCompletionsStreamAccumulator: () => ChatCompletionsStreamAccumulator,
  InvalidUsageQueryError: () => InvalidUsageQueryError,
  MetaLlmClient: () => MetaLlmClient,
  UnsendableRoutingControlsError: () => UnsendableRoutingControlsError,
  assertSendableRoutingControls: () => assertSendableRoutingControls,
  assertValidUsageQuery: () => assertValidUsageQuery,
  decodeOpenAiSseEvent: () => decodeOpenAiSseEvent,
  parseMetaLlmReceipt: () => parseMetaLlmReceipt,
  parseMoney: () => parseMoney,
  parseUsageSummary: () => parseUsageSummary,
  resolveMetaLlmClientConfig: () => resolveMetaLlmClientConfig
});
module.exports = __toCommonJS(meta_llm_exports);

// src/meta-llm/config.ts
var warnedInsecureHttp = false;
function extractHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "::1") return true;
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  return match.slice(1).every((octet) => Number(octet) >= 0 && Number(octet) <= 255) && Number(match[1]) === 127;
}
function warnInsecureHttpOnce(baseUrl) {
  if (warnedInsecureHttp) return;
  warnedInsecureHttp = true;
  console.warn(
    `[cognitum-sdk/meta-llm] HTTP (non-TLS) transport is ENABLED via allowInsecureHttp for loopback baseUrl "${baseUrl}". Never use this in production \u2014 see ADR-0022 \xA7D3.`
  );
}
function resolveMetaLlmClientConfig(config) {
  if (!config.baseUrl) {
    throw new TypeError("MetaLlmClientConfig.baseUrl is required");
  }
  const trimmed = config.baseUrl.replace(/\/+$/, "");
  const isHttps = /^https:\/\//i.test(trimmed);
  if (!isHttps) {
    if (!config.allowInsecureHttp) {
      throw new TypeError(
        `MetaLlmClientConfig.baseUrl must be an explicit HTTPS origin (ADR-0024a \xA7D1); got "${config.baseUrl}". Set allowInsecureHttp: true for local development only.`
      );
    }
    const host = extractHost(trimmed);
    if (!host || !isLoopbackHost(host)) {
      throw new TypeError(
        `MetaLlmClientConfig.allowInsecureHttp is only permitted for literal IPv4/IPv6 loopback base URLs (ADR-0022 \xA7D3); got "${config.baseUrl}". Hostname resolution to loopback (e.g. "localhost") is insufficient.`
      );
    }
    warnInsecureHttpOnce(trimmed);
  }
  return { ...config, baseUrl: trimmed };
}

// src/meta-llm/types/routing.ts
var MODEL_TIERS = /* @__PURE__ */ new Set(["low", "mid", "high"]);
var FALLBACK_POLICIES = /* @__PURE__ */ new Set(["fail_fast", "best_effort"]);
var ESCALATION_STRATEGIES = /* @__PURE__ */ new Set([
  "stream_oneshot",
  "post_hoc",
  "buffered",
  "inflight"
]);
var CACHE_MODES = /* @__PURE__ */ new Set(["disabled", "exact", "semantic"]);
var SAFETY_MODES = /* @__PURE__ */ new Set(["block", "warn", "redact"]);
var UnsendableRoutingControlsError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsendableRoutingControlsError";
  }
};
function assertSendableModelSelector(selector) {
  switch (selector.kind) {
    case "auto":
      return;
    case "tier":
      if (!MODEL_TIERS.has(selector.tier)) {
        throw new UnsendableRoutingControlsError(
          `unrecognized ModelTier in ModelSelector.tier: ${JSON.stringify(selector.tier)}`
        );
      }
      return;
    case "contract_declared_alias":
      if (typeof selector.alias !== "string" || selector.alias.length === 0) {
        throw new UnsendableRoutingControlsError(
          "ModelSelector.contract_declared_alias requires a non-empty alias string"
        );
      }
      return;
    default: {
      const unrecognized = selector;
      throw new UnsendableRoutingControlsError(`unrecognized ModelSelector.kind: ${JSON.stringify(unrecognized.kind)}`);
    }
  }
}
function assertSendableRoutingControls(controls) {
  if (!controls) return;
  if (controls.model !== void 0) assertSendableModelSelector(controls.model);
  if (controls.minTier !== void 0 && !MODEL_TIERS.has(controls.minTier)) {
    throw new UnsendableRoutingControlsError(`unrecognized ModelTier for minTier: ${JSON.stringify(controls.minTier)}`);
  }
  if (controls.maxTier !== void 0 && !MODEL_TIERS.has(controls.maxTier)) {
    throw new UnsendableRoutingControlsError(`unrecognized ModelTier for maxTier: ${JSON.stringify(controls.maxTier)}`);
  }
  if (controls.fallbackPolicy !== void 0 && !FALLBACK_POLICIES.has(controls.fallbackPolicy)) {
    throw new UnsendableRoutingControlsError(
      `unrecognized FallbackPolicy: ${JSON.stringify(controls.fallbackPolicy)}`
    );
  }
  if (controls.escalation !== void 0 && !ESCALATION_STRATEGIES.has(controls.escalation)) {
    throw new UnsendableRoutingControlsError(
      `unrecognized EscalationStrategy: ${JSON.stringify(controls.escalation)}`
    );
  }
  if (controls.cache !== void 0 && !CACHE_MODES.has(controls.cache)) {
    throw new UnsendableRoutingControlsError(`unrecognized CacheMode: ${JSON.stringify(controls.cache)}`);
  }
  if (controls.safety !== void 0 && !SAFETY_MODES.has(controls.safety)) {
    throw new UnsendableRoutingControlsError(`unrecognized SafetyMode: ${JSON.stringify(controls.safety)}`);
  }
}

// src/meta-llm/types/money.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseMoney(raw) {
  if (!isRecord(raw)) return void 0;
  const amountRaw = raw.amount;
  const currency = raw.currency ?? raw.currency_code ?? raw.currencyCode;
  if ((typeof amountRaw === "string" || typeof amountRaw === "number") && typeof currency === "string") {
    return { amount: String(amountRaw), currency };
  }
  return void 0;
}

// src/meta-llm/types/receipt.ts
var KNOWN_RECEIPT_KEYS = /* @__PURE__ */ new Set([
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
  "costs"
]);
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseCostObservation(raw) {
  if (!isRecord2(raw)) return void 0;
  const { source, amount, currency, finality } = raw;
  if (typeof source !== "string" || typeof currency !== "string" || typeof finality !== "string") {
    return void 0;
  }
  return {
    source,
    amount: typeof amount === "number" ? amount : Number(amount),
    currency,
    finality
  };
}
function parseSafetySummary(raw) {
  if (!isRecord2(raw)) return void 0;
  const known = /* @__PURE__ */ new Set(["mode", "detector_classes", "detectorClasses", "blocked"]);
  const detectorClassesRaw = raw.detector_classes ?? raw.detectorClasses;
  const rawRemainder = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) rawRemainder[key] = value;
  }
  return {
    mode: typeof raw.mode === "string" ? raw.mode : void 0,
    detectorClasses: Array.isArray(detectorClassesRaw) ? detectorClassesRaw.filter((v) => typeof v === "string") : void 0,
    blocked: typeof raw.blocked === "boolean" ? raw.blocked : void 0,
    raw: Object.keys(rawRemainder).length > 0 ? rawRemainder : void 0
  };
}
function parseMetaLlmReceipt(raw) {
  if (!isRecord2(raw)) return void 0;
  const requestIdRaw = raw.request_id ?? raw.requestId;
  const requestId = typeof requestIdRaw === "string" ? requestIdRaw : "";
  const costsRaw = raw.costs;
  const costs = Array.isArray(costsRaw) ? costsRaw.map(parseCostObservation).filter((c) => c !== void 0) : [];
  const rawRemainder = {};
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
    resolvedTier: typeof resolvedTierRaw === "string" ? resolvedTierRaw : void 0,
    resolvedModel: typeof resolvedModelRaw === "string" ? resolvedModelRaw : void 0,
    escalated: typeof raw.escalated === "boolean" ? raw.escalated : void 0,
    capDegraded: typeof capDegradedRaw === "boolean" ? capDegradedRaw : void 0,
    routingReason: typeof routingReasonRaw === "string" ? routingReasonRaw : void 0,
    price: parseMoney(raw.price),
    cacheResult: typeof cacheResultRaw === "string" ? cacheResultRaw : void 0,
    cacheSavings: parseMoney(raw.cache_savings ?? raw.cacheSavings),
    promptCacheSavings: parseMoney(raw.prompt_cache_savings ?? raw.promptCacheSavings),
    fallbackUsed: typeof fallbackUsedRaw === "boolean" ? fallbackUsedRaw : void 0,
    breakerCounts: isRecord2(breakerCountsRaw) ? breakerCountsRaw : void 0,
    subTenantId: typeof subTenantIdRaw === "string" ? subTenantIdRaw : void 0,
    safetySummary: parseSafetySummary(raw.safety_summary ?? raw.safetySummary),
    usage: isRecord2(raw.usage) ? raw.usage : void 0,
    costs,
    raw: Object.keys(rawRemainder).length > 0 ? rawRemainder : void 0
  };
}

// src/meta-llm/types/usage.ts
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var YYYY_MM = /^\d{4}-(0[1-9]|1[0-2])$/;
var InvalidUsageQueryError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidUsageQueryError";
  }
};
function assertValidUsageQuery(query) {
  if (!YYYY_MM.test(query.from)) {
    throw new InvalidUsageQueryError(`UsageQuery.from must match YYYY-MM; got ${JSON.stringify(query.from)}`);
  }
  if (!YYYY_MM.test(query.to)) {
    throw new InvalidUsageQueryError(`UsageQuery.to must match YYYY-MM; got ${JSON.stringify(query.to)}`);
  }
  if (query.from > query.to) {
    throw new InvalidUsageQueryError(
      `UsageQuery.from (${JSON.stringify(query.from)}) must not be after .to (${JSON.stringify(query.to)})`
    );
  }
}
function parseCacheStats(raw) {
  if (!isRecord3(raw)) return void 0;
  const known = /* @__PURE__ */ new Set(["hit_rate", "hitRate", "savings"]);
  const rawRemainder = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) rawRemainder[key] = value;
  }
  const hitRateRaw = raw.hit_rate ?? raw.hitRate;
  return {
    hitRate: typeof hitRateRaw === "number" ? hitRateRaw : void 0,
    savings: parseMoneyImport(raw.savings),
    raw: Object.keys(rawRemainder).length > 0 ? rawRemainder : void 0
  };
}
function parseUsageTotals(raw) {
  if (!isRecord3(raw)) return {};
  const known = /* @__PURE__ */ new Set([
    "requests",
    "prompt_tokens",
    "promptTokens",
    "completion_tokens",
    "completionTokens",
    "total_tokens",
    "totalTokens",
    "cost"
  ]);
  const rawRemainder = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) rawRemainder[key] = value;
  }
  return {
    requests: typeof raw.requests === "number" ? raw.requests : void 0,
    promptTokens: typeof (raw.prompt_tokens ?? raw.promptTokens) === "number" ? raw.prompt_tokens ?? raw.promptTokens : void 0,
    completionTokens: typeof (raw.completion_tokens ?? raw.completionTokens) === "number" ? raw.completion_tokens ?? raw.completionTokens : void 0,
    totalTokens: typeof (raw.total_tokens ?? raw.totalTokens) === "number" ? raw.total_tokens ?? raw.totalTokens : void 0,
    cost: parseMoneyImport(raw.cost),
    raw: Object.keys(rawRemainder).length > 0 ? rawRemainder : void 0
  };
}
function parseBudgetView(raw) {
  if (!isRecord3(raw)) return void 0;
  const known = /* @__PURE__ */ new Set([
    "serving",
    "hard_limit",
    "hardLimit",
    "committed",
    "reserved",
    "headroom",
    "status",
    "resets_at",
    "resetsAt"
  ]);
  const rawRemainder = {};
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
    status: typeof raw.status === "string" ? raw.status : void 0,
    resetsAt: typeof resetsAtRaw === "string" ? resetsAtRaw : void 0,
    raw: Object.keys(rawRemainder).length > 0 ? rawRemainder : void 0
  };
}
function parseBreakdownEntry(raw) {
  if (!isRecord3(raw)) return {};
  const known = /* @__PURE__ */ new Set(["requests", "cost"]);
  const rawRemainder = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) rawRemainder[key] = value;
  }
  return {
    requests: typeof raw.requests === "number" ? raw.requests : void 0,
    cost: parseMoneyImport(raw.cost),
    raw: Object.keys(rawRemainder).length > 0 ? rawRemainder : void 0
  };
}
function parseBreakdownMap(raw) {
  if (!isRecord3(raw)) return void 0;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = parseBreakdownEntry(value);
  }
  return out;
}
function parsePeriodEntries(raw) {
  if (!Array.isArray(raw)) return void 0;
  return raw.filter((item) => isRecord3(item) && typeof item.period === "string").map((item) => ({ period: item.period, ...parseBreakdownEntry(item) }));
}
function parseMoneyImport(raw) {
  if (!isRecord3(raw)) return void 0;
  const amountRaw = raw.amount;
  const currency = raw.currency ?? raw.currency_code ?? raw.currencyCode;
  if ((typeof amountRaw === "string" || typeof amountRaw === "number") && typeof currency === "string") {
    return { amount: String(amountRaw), currency };
  }
  return void 0;
}
var KNOWN_USAGE_KEYS = /* @__PURE__ */ new Set([
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
  "budget"
]);
function parseUsageSummary(raw) {
  if (!isRecord3(raw)) return { totals: {} };
  const rawRemainder = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_USAGE_KEYS.has(key)) rawRemainder[key] = value;
  }
  const escalationRateRaw = raw.escalation_rate ?? raw.escalationRate;
  const fallbackRateRaw = raw.fallback_rate ?? raw.fallbackRate;
  const emptyBilledRateRaw = raw.empty_billed_rate ?? raw.emptyBilledRate;
  const tierMixRaw = raw.tier_mix ?? raw.tierMix;
  return {
    totals: parseUsageTotals(raw.totals),
    tierMix: isRecord3(tierMixRaw) ? tierMixRaw : void 0,
    escalationRate: typeof escalationRateRaw === "number" ? escalationRateRaw : void 0,
    cache: parseCacheStats(raw.cache),
    fallbackRate: typeof fallbackRateRaw === "number" ? fallbackRateRaw : void 0,
    emptyBilledRate: typeof emptyBilledRateRaw === "number" ? emptyBilledRateRaw : void 0,
    byModel: parseBreakdownMap(raw.by_model ?? raw.byModel),
    byProvider: parseBreakdownMap(raw.by_provider ?? raw.byProvider),
    byPeriod: parsePeriodEntries(raw.by_period ?? raw.byPeriod),
    budget: parseBudgetView(raw.budget),
    raw: Object.keys(rawRemainder).length > 0 ? rawRemainder : void 0
  };
}

// src/agentic/errors.ts
var AgenticError = class extends Error {
  kind;
  product;
  operation;
  status;
  code;
  requestId;
  correlationId;
  protocolVersion;
  retryable;
  retryAfterMs;
  attemptCount;
  details;
  constructor(kind, message, fields) {
    super(message, { cause: fields?.cause });
    this.name = "AgenticError";
    this.kind = kind;
    this.product = fields?.product;
    this.operation = fields?.operation;
    this.status = fields?.status;
    this.code = fields?.code;
    this.requestId = fields?.requestId;
    this.correlationId = fields?.correlationId;
    this.protocolVersion = fields?.protocolVersion;
    this.retryable = fields?.retryable ?? false;
    this.retryAfterMs = fields?.retryAfterMs;
    this.attemptCount = fields?.attemptCount;
    this.details = fields?.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
var PermissionDeniedError = class extends AgenticError {
  requiredScope;
  grantedScopes;
  constructor(product, operation, requiredScope, grantedScopes, message) {
    super(
      "permission_denied",
      message ?? `operation "${operation}" on ${product} requires scope "${requiredScope}", but the credential's known granted scopes (${grantedScopes.length > 0 ? grantedScopes.join(", ") : "none"}) do not include it (ADR-0022 \xA7D5 scope preflight)`,
      { product, operation, retryable: false }
    );
    this.name = "PermissionDeniedError";
    this.requiredScope = requiredScope;
    this.grantedScopes = grantedScopes;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
var DEFAULT_RETRY_POLICY = {
  baseMs: 500,
  capMs: 3e4,
  maxAttempts: 4,
  retrySleepBudgetMs: 6e4
};
function equalJitterDelayMs(attempt, policy = DEFAULT_RETRY_POLICY, serverHintMs = 0, jitterMs = 0) {
  const expo = policy.baseMs * 2 ** attempt;
  const clampedJitter = Math.min(Math.max(jitterMs, 0), policy.baseMs);
  const computed = expo + clampedJitter;
  const floor = Math.max(serverHintMs, computed);
  return Math.min(policy.capMs, floor);
}

// src/agentic/credentials.ts
var REDACT_INSPECT = /* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom");
var RedactedSecret = class {
  #value;
  constructor(value) {
    this.#value = value;
  }
  /** Explicit, auditable access to the underlying secret. */
  reveal() {
    return this.#value;
  }
  toString() {
    return "[REDACTED]";
  }
  toJSON() {
    return "[REDACTED]";
  }
  [REDACT_INSPECT]() {
    return "RedactedSecret([REDACTED])";
  }
};

// src/agentic/static-api-key-provider.ts
var import_node_crypto = require("crypto");

// src/agentic/oauth-token-provider.ts
var import_node_crypto2 = require("crypto");

// src/agentic/scope-preflight.ts
function assertScopeGranted(product, operation, requiredScope, credential) {
  const granted = credential.grantedScopes;
  if (granted === void 0) {
    return;
  }
  if (!granted.includes(requiredScope)) {
    throw new PermissionDeniedError(product, operation, requiredScope, granted);
  }
}

// src/agentic/receipt-verification.ts
var import_node_crypto3 = require("crypto");
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}
function canonicalJson(value) {
  return JSON.stringify(sortKeysDeep(value));
}
function sha256Hex(bytes) {
  return (0, import_node_crypto3.createHash)("sha256").update(bytes, "utf8").digest("hex");
}

// src/meta-llm/http-errors.ts
var PRODUCT = "meta-llm";
function nonEmpty(value, fallback) {
  return value.length > 0 ? value : fallback;
}
async function mapMetaLlmHttpError(response, operation, requestId) {
  const status = response.status;
  const bodyText = await response.text().catch(() => "");
  const fields = { product: PRODUCT, operation, status, requestId };
  switch (status) {
    // Never retried (ADR-0024a §D6).
    case 400:
      return new AgenticError("validation", nonEmpty(bodyText, "invalid request"), {
        ...fields,
        retryable: false
      });
    case 401:
      return new AgenticError("authentication", nonEmpty(bodyText, "authentication failed"), {
        ...fields,
        retryable: false
      });
    case 403:
      return new AgenticError("permission_denied", nonEmpty(bodyText, "permission denied"), {
        ...fields,
        retryable: false
      });
    case 404:
      return new AgenticError("not_found", nonEmpty(bodyText, "not found"), {
        ...fields,
        retryable: false
      });
    case 409:
      return new AgenticError(
        "conflict",
        nonEmpty(bodyText, "state conflict or idempotency mismatch"),
        { ...fields, retryable: false }
      );
    case 402:
      return new AgenticError(
        "budget_exceeded",
        nonEmpty(bodyText, "budget or upgrade required"),
        { ...fields, retryable: false }
      );
    case 422:
      return new AgenticError(
        "safety_blocked",
        nonEmpty(bodyText, "safety or semantic validation failed"),
        { ...fields, retryable: false }
      );
    // Bounded retry only when the caller proves replay safety (an
    // idempotent-with-key operation) — the retry loop in `./nonstream.js`
    // is what actually gates this; `retryable: true` here only reflects
    // the status's own classification.
    case 429: {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1e3 : void 0;
      return new AgenticError("rate_limited", nonEmpty(bodyText, "rate limited"), {
        ...fields,
        retryable: true,
        retryAfterMs
      });
    }
    case 502:
    case 503:
      return new AgenticError("transport", nonEmpty(bodyText, `upstream error ${status}`), {
        ...fields,
        retryable: true
      });
    default:
      return new AgenticError("protocol", nonEmpty(bodyText, `unexpected status ${status}`), {
        ...fields,
        retryable: false
      });
  }
}

// src/meta-llm/idempotency.ts
var CONTRACT_MAJOR = 1;
function canonicalRequestSha256(body) {
  return sha256Hex(canonicalJson(body));
}
function buildIdempotencyBinding(operation, path, credential, tenant, canonicalRequestSha256Value, idempotencyKey) {
  const authenticatedPrincipal = credential.authority.principal ?? credential.authority.providerFingerprint;
  const tenantContext = tenant?.tenantId ?? credential.authority.tenant;
  const delegatedSubtenantContext = tenant?.delegatedSubtenantId ?? credential.authority.delegatedSubtenant;
  return {
    authenticatedPrincipal,
    tenantContext,
    delegatedSubtenantContext,
    httpMethod: "POST",
    // ADR-0023 §D5: "the contract operation ID plus normalized path
    // parameters [...] canonically sorted, percent-encoded query pairs".
    // Neither route has path parameters or a query string, so this
    // reduces to exactly `"{operation} {path}"`.
    normalizedRouteIdentity: `${operation} ${path}`,
    canonicalRequestSha256: canonicalRequestSha256Value,
    idempotencyKey,
    contractMajor: CONTRACT_MAJOR
  };
}

// src/meta-llm/nonstream.ts
var PRODUCT2 = "meta-llm";
var INFERENCE_SCOPE = "meta-llm.inference";
var OPERATION_REQUIRED_SCOPE = {
  "chat.completions": INFERENCE_SCOPE,
  "chat.completionsStream": INFERENCE_SCOPE,
  "messages.create": INFERENCE_SCOPE,
  "messages.countTokens": INFERENCE_SCOPE,
  completions: INFERENCE_SCOPE,
  responses: INFERENCE_SCOPE,
  embeddings: INFERENCE_SCOPE
};
function newRequestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
function applyAuth(headers, credential) {
  if (credential.scheme.toLowerCase() === "bearer") {
    headers.Authorization = `Bearer ${credential.secret.reveal()}`;
  } else {
    headers[credential.scheme] = credential.secret.reveal();
  }
}
async function requireCredential(deps, operation) {
  const provider = deps.credentialProvider;
  if (!provider) {
    throw new AgenticError(
      "authentication",
      `MetaLlmClient.${operation} requires a credentialProvider`,
      { product: PRODUCT2, operation, retryable: false }
    );
  }
  const requiredScope = OPERATION_REQUIRED_SCOPE[operation] ?? INFERENCE_SCOPE;
  const credential = await provider.acquire({
    product: PRODUCT2,
    normalizedOrigin: deps.baseUrl,
    audience: deps.baseUrl,
    requiredScopes: [requiredScope],
    operation,
    interactiveAllowed: false
  });
  assertScopeGranted(PRODUCT2, operation, requiredScope, credential);
  return credential;
}
function isCredentialLocallyExpired(credential, now = Date.now) {
  if (credential.expiresAt === void 0) {
    return false;
  }
  const expiresAtMs = Date.parse(credential.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= now();
}
async function sendPostOnce(deps, path, operation, body, credential, idempotencyKey) {
  const requestId = newRequestId();
  deps.telemetry?.onRequestStart?.({ operation, requestId });
  const startedAt = Date.now();
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Cognitum-Request-Id": requestId,
    // ADR-0024a §D7 / ADR-0005: the caller-attested idempotency key,
    // stable across every retry of one logical call.
    "Idempotency-Key": idempotencyKey
  };
  applyAuth(headers, credential);
  const url = `${deps.baseUrl}${path}`;
  let response;
  try {
    response = await deps.transport(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
  } catch (cause) {
    deps.telemetry?.onRequestEnd?.({ operation, requestId, durationMs: Date.now() - startedAt });
    throw new AgenticError("transport", `${operation} request failed: ${cause}`, {
      product: PRODUCT2,
      operation,
      requestId,
      retryable: true,
      cause
    });
  }
  const durationMs = Date.now() - startedAt;
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1e3 : void 0;
  const idempotentReplayHeader = response.headers.get("x-cognitum-idempotent-replay");
  const idempotentReplay = idempotentReplayHeader !== null ? idempotentReplayHeader.toLowerCase() === "true" : void 0;
  deps.telemetry?.onRequestEnd?.({
    operation,
    requestId,
    httpStatus: response.status,
    durationMs,
    retryAfterMs,
    idempotentReplay
  });
  if (!response.ok) {
    const err = await mapMetaLlmHttpError(response, operation, requestId);
    if (err.retryAfterMs === void 0) {
      err.retryAfterMs = retryAfterMs;
    }
    throw err;
  }
  const rawJson = await response.json();
  const data = rawJson;
  const receipt = rawJson !== null && typeof rawJson === "object" && !Array.isArray(rawJson) ? parseMetaLlmReceipt(rawJson.cognitum_receipt) : void 0;
  const meta = {
    requestId: response.headers.get("x-cognitum-request-id") ?? requestId,
    httpStatus: response.status,
    protocolVersion: response.headers.get("x-cognitum-protocol-version") ?? void 0,
    retryAfterMs,
    idempotentReplay,
    receipt
  };
  return { data, meta };
}
async function postJsonIdempotent(deps, path, operation, body) {
  const bodyRoutingControls = body?.routingControls;
  try {
    assertSendableRoutingControls(bodyRoutingControls);
  } catch (cause) {
    throw new AgenticError("validation", `${operation} routingControls rejected: ${cause.message}`, {
      product: PRODUCT2,
      operation,
      retryable: false,
      cause
    });
  }
  let credential = await requireCredential(deps, operation);
  const idempotencyKey = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : newRequestId();
  const canonicalSha256 = canonicalRequestSha256(body);
  const tenant = deps.defaultRequestContext?.tenant;
  const retryPolicy = DEFAULT_RETRY_POLICY;
  let attempt = 0;
  let sleepBudgetUsedMs = 0;
  let refreshedOnce = false;
  for (; ; ) {
    const binding = buildIdempotencyBinding(
      operation,
      path,
      credential,
      tenant,
      canonicalSha256,
      idempotencyKey
    );
    try {
      return await sendPostOnce(deps, path, operation, body, credential, idempotencyKey);
    } catch (cause) {
      const err = cause;
      if (err.status === 409 && err.details === void 0) {
        err.details = {
          idempotencyKey: binding.idempotencyKey,
          normalizedRouteIdentity: binding.normalizedRouteIdentity,
          contractMajor: binding.contractMajor
        };
      }
      if (err.status === 401 && !refreshedOnce) {
        refreshedOnce = true;
        await deps.credentialProvider?.invalidate("401 challenge from meta-llm");
        credential = await requireCredential(deps, operation);
        continue;
      }
      const isBoundedRetryable = err.status === 429 || err.status === 502 || err.status === 503;
      if (isBoundedRetryable && attempt + 1 < retryPolicy.maxAttempts) {
        const serverHintMs = err.retryAfterMs ?? 0;
        const jitterMs = Math.random() * retryPolicy.baseMs;
        const delayMs = equalJitterDelayMs(attempt, retryPolicy, serverHintMs, jitterMs);
        if (sleepBudgetUsedMs + delayMs > retryPolicy.retrySleepBudgetMs) {
          throw err;
        }
        sleepBudgetUsedMs += delayMs;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        attempt += 1;
        if (isCredentialLocallyExpired(credential)) {
          credential = await requireCredential(deps, operation);
        }
        continue;
      }
      throw err;
    }
  }
}

// src/sse/parser.ts
var DEFAULT_MAX_LINE_BYTES = 64 * 1024;
var DEFAULT_MAX_EVENT_BYTES = 256 * 1024;
var DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
var DEFAULT_MAX_MALFORMED_EVENTS = 50;
var SseParseError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "SseParseError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
var LF = 10;
var CR = 13;
var SseParser = class {
  maxLineBytes;
  maxEventBytes;
  maxBufferedBytes;
  maxMalformedEvents;
  buffer = new Uint8Array(0);
  lineDecoder = new TextDecoder("utf-8", { fatal: false });
  fieldEncoder = new TextEncoder();
  eventType;
  dataLines = [];
  dataBytesLen = 0;
  eventId;
  retryMs;
  poisoned = false;
  malformedCount = 0;
  constructor(options) {
    this.maxLineBytes = options?.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.maxEventBytes = options?.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    this.maxBufferedBytes = options?.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.maxMalformedEvents = options?.maxMalformedEvents ?? DEFAULT_MAX_MALFORMED_EVENTS;
  }
  /**
   * Feed the next chunk of raw bytes (any size, any split point — including
   * mid-UTF-8-codepoint). Returns zero or more fully-dispatched events, in
   * order. Throws {@link SseParseError} if a hard limit is exceeded.
   */
  feed(chunk) {
    this.appendToBuffer(chunk);
    const events = [];
    for (; ; ) {
      const line = this.takeLine(false);
      if (line === void 0) break;
      const event = this.processLine(line);
      if (event) events.push(event);
    }
    return events;
  }
  /**
   * Signal end of stream (no more bytes will ever arrive). Resolves the one
   * ambiguity `feed()` cannot: a trailing lone CR with nothing after it is
   * held back by `feed()` because a following LF (making it CRLF) might
   * still arrive — at true EOF that ambiguity is resolved (no more bytes
   * are coming, so a trailing CR IS a terminator), and this may therefore
   * flush one final event. Any OTHER undispatched partial event/line
   * (i.e. real data with no terminator at all) is dropped, matching the
   * SSE spec: dispatch only happens on a blank line, and a stream that
   * closes mid-event never sends one. This does NOT throw — whether an
   * incomplete stream is an error is protocol-specific (e.g. "did we see
   * `[DONE]`?"), which is the caller's decision, not this generic parser's.
   */
  finish() {
    const events = [];
    for (; ; ) {
      const line = this.takeLine(true);
      if (line === void 0) break;
      const event = this.processLine(line);
      if (event) events.push(event);
    }
    return {
      events,
      hadUndispatchedData: this.dataLines.length > 0 || this.buffer.length > 0,
      malformedEventCount: this.malformedCount
    };
  }
  appendToBuffer(chunk) {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    if (this.buffer.length > this.maxBufferedBytes) {
      throw new SseParseError(
        "buffer_overflow",
        `SSE parser buffered ${this.buffer.length} bytes without a line terminator (limit ${this.maxBufferedBytes})`
      );
    }
  }
  /**
   * Removes and returns the next complete line's raw bytes (terminator
   * excluded), or `undefined` if no complete line is available yet.
   * Accepts LF, CRLF, and lone CR (SSE/HTML spec line-terminator rule).
   *
   * A trailing CR with no following byte yet is ambiguous — it might be
   * the first half of a CRLF pair whose LF just hasn't arrived, or it
   * might be a lone-CR terminator. `feed()` calls this with `atEof=false`
   * and withholds judgement until a following byte (or true end of
   * stream) disambiguates it, so a CRLF pair split exactly at the CR/LF
   * boundary across two `feed()` calls is handled correctly. `finish()`
   * calls this with `atEof=true`, resolving that same trailing CR as a
   * valid terminator since no more bytes will ever arrive.
   */
  takeLine(atEof) {
    for (let i = 0; i < this.buffer.length; i += 1) {
      const byte = this.buffer[i];
      if (byte === LF) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        return line;
      }
      if (byte === CR) {
        if (i + 1 < this.buffer.length) {
          const consumed = this.buffer[i + 1] === LF ? i + 2 : i + 1;
          const line = this.buffer.slice(0, i);
          this.buffer = this.buffer.slice(consumed);
          return line;
        }
        if (atEof) {
          const line = this.buffer.slice(0, i);
          this.buffer = this.buffer.slice(i + 1);
          return line;
        }
        return void 0;
      }
    }
    return void 0;
  }
  noteMalformed() {
    this.malformedCount += 1;
    if (this.malformedCount > this.maxMalformedEvents) {
      throw new SseParseError(
        "too_many_malformed_events",
        `SSE parser exceeded ${this.maxMalformedEvents} malformed/oversized lines or events`
      );
    }
  }
  processLine(lineBytes) {
    if (lineBytes.length > this.maxLineBytes) {
      this.noteMalformed();
      return void 0;
    }
    const line = this.lineDecoder.decode(lineBytes);
    if (line.length === 0) {
      return this.dispatch();
    }
    if (line.startsWith(":")) {
      return void 0;
    }
    const colonIdx = line.indexOf(":");
    let field;
    let value;
    if (colonIdx === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colonIdx);
      value = line.slice(colonIdx + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    switch (field) {
      case "event":
        this.eventType = value;
        break;
      case "data": {
        const additional = this.fieldEncoder.encode(value).length + (this.dataLines.length > 0 ? 1 : 0);
        if (!this.poisoned && this.dataBytesLen + additional > this.maxEventBytes) {
          this.poisoned = true;
          this.noteMalformed();
        }
        if (!this.poisoned) {
          this.dataLines.push(value);
          this.dataBytesLen += additional;
        }
        break;
      }
      case "id":
        if (!value.includes("\0")) this.eventId = value;
        break;
      case "retry":
        if (/^[0-9]+$/.test(value)) this.retryMs = Number(value);
        break;
      default:
        break;
    }
    return void 0;
  }
  dispatch() {
    const hadData = this.dataLines.length > 0;
    const event = hadData && !this.poisoned ? { event: this.eventType, data: this.dataLines.join("\n"), id: this.eventId, retry: this.retryMs } : void 0;
    this.eventType = void 0;
    this.dataLines = [];
    this.dataBytesLen = 0;
    this.eventId = void 0;
    this.retryMs = void 0;
    this.poisoned = false;
    return event;
  }
};

// src/meta-llm/stream/openai-events.ts
var KNOWN_TOP_LEVEL_KEYS = /* @__PURE__ */ new Set([
  "id",
  "object",
  "created",
  "model",
  "choices",
  "usage",
  "cognitum_receipt",
  "system_fingerprint",
  "error"
]);
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function decodeOpenAiSseEvent(raw) {
  const trimmed = raw.data.trim();
  if (trimmed === "[DONE]") {
    return { events: [{ type: "done" }] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.data);
  } catch {
    return { events: [{ type: "unknown", raw: raw.data }] };
  }
  if (!isRecord4(parsed)) {
    return { events: [{ type: "unknown", raw: parsed }] };
  }
  const events = [];
  if (isRecord4(parsed.error)) {
    const e = parsed.error;
    events.push({
      type: "error",
      error: {
        message: typeof e.message === "string" ? e.message : "unknown error",
        type: typeof e.type === "string" ? e.type : void 0,
        code: typeof e.code === "string" ? e.code : void 0,
        param: typeof e.param === "string" ? e.param : void 0
      }
    });
  }
  if (Array.isArray(parsed.choices)) {
    for (const choiceRaw of parsed.choices) {
      if (!isRecord4(choiceRaw)) continue;
      const index = typeof choiceRaw.index === "number" ? choiceRaw.index : 0;
      const delta = isRecord4(choiceRaw.delta) ? choiceRaw.delta : {};
      if (typeof delta.role === "string") {
        events.push({ type: "role", index, role: delta.role });
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        events.push({ type: "content_delta", index, delta: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const toolCallRaw of delta.tool_calls) {
          if (!isRecord4(toolCallRaw)) continue;
          const fn = isRecord4(toolCallRaw.function) ? toolCallRaw.function : {};
          events.push({
            type: "tool_call_delta",
            index,
            toolCallIndex: typeof toolCallRaw.index === "number" ? toolCallRaw.index : 0,
            id: typeof toolCallRaw.id === "string" ? toolCallRaw.id : void 0,
            functionName: typeof fn.name === "string" ? fn.name : void 0,
            argumentsDelta: typeof fn.arguments === "string" ? fn.arguments : void 0
          });
        }
      }
      if (typeof choiceRaw.finish_reason === "string") {
        events.push({ type: "finish_reason", index, finishReason: choiceRaw.finish_reason });
      }
    }
  }
  if (isRecord4(parsed.usage)) {
    const u = parsed.usage;
    events.push({
      type: "usage",
      usage: {
        promptTokens: Number(u.prompt_tokens ?? 0),
        completionTokens: Number(u.completion_tokens ?? 0),
        totalTokens: Number(u.total_tokens ?? 0)
      }
    });
  }
  if (parsed.cognitum_receipt !== void 0) {
    const receipt = parseMetaLlmReceipt(parsed.cognitum_receipt);
    if (receipt) events.push({ type: "receipt", receipt });
  }
  if (events.length === 0) {
    events.push({ type: "unknown", raw: parsed });
  }
  const unknownFields = {};
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) unknownFields[key] = parsed[key];
  }
  return { events, unknownFields: Object.keys(unknownFields).length > 0 ? unknownFields : void 0 };
}

// src/meta-llm/stream/chat-completions-stream.ts
var PRODUCT3 = "meta-llm";
var OPERATION = "chat.completionsStream";
async function* chatCompletionsStreamImpl(deps, request, requestContext) {
  const timeBudget = requestContext?.timeBudget;
  const cancellation = requestContext?.cancellation;
  const requestId = requestContext?.requestId ?? newRequestId();
  const abortController = new AbortController();
  const response = await openStreamWithPreByteRetry(deps, request, requestId, abortController.signal);
  if (!response.body) {
    throw new AgenticError("protocol", `${OPERATION} response had no readable body`, {
      product: PRODUCT3,
      operation: OPERATION,
      requestId,
      retryable: false,
      code: "no_response_body"
    });
  }
  yield* readSseBody(response.body, requestId, timeBudget, cancellation, abortController);
}
async function openStreamWithPreByteRetry(deps, request, requestId, signal) {
  let credential = await requireCredential(deps, OPERATION);
  const body = JSON.stringify({ ...request, stream: true });
  const retryPolicy = DEFAULT_RETRY_POLICY;
  let attempt = 0;
  let sleepBudgetUsedMs = 0;
  let refreshedOnce = false;
  for (; ; ) {
    const headers = {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "X-Cognitum-Request-Id": requestId
    };
    applyAuth(headers, credential);
    const url = `${deps.baseUrl}/v1/chat/completions`;
    let response;
    try {
      response = await deps.transport(url, { method: "POST", headers, body, signal });
    } catch (cause) {
      throw new AgenticError("transport", `${OPERATION} request failed: ${cause}`, {
        product: PRODUCT3,
        operation: OPERATION,
        requestId,
        retryable: true,
        cause
      });
    }
    if (response.ok) return response;
    const err = await mapMetaLlmHttpError(response, OPERATION, requestId);
    if (err.status === 401 && !refreshedOnce) {
      refreshedOnce = true;
      await deps.credentialProvider?.invalidate("401 challenge from meta-llm");
      credential = await requireCredential(deps, OPERATION);
      continue;
    }
    const isBoundedRetryable = err.status === 429 || err.status === 502 || err.status === 503;
    if (isBoundedRetryable && attempt + 1 < retryPolicy.maxAttempts) {
      const serverHintMs = err.retryAfterMs ?? 0;
      const jitterMs = Math.random() * retryPolicy.baseMs;
      const delayMs = equalJitterDelayMs(attempt, retryPolicy, serverHintMs, jitterMs);
      if (sleepBudgetUsedMs + delayMs > retryPolicy.retrySleepBudgetMs) throw err;
      sleepBudgetUsedMs += delayMs;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
      continue;
    }
    throw err;
  }
}
function deadlineError(operation, requestId, code, message, sequence) {
  return new AgenticError("deadline_exceeded", message, {
    product: PRODUCT3,
    operation,
    requestId,
    retryable: false,
    code,
    details: { partial: true, eventsReceived: sequence }
  });
}
function buildEnvelopes(rawEvent, requestId, nextSequence) {
  const { events, unknownFields } = decodeOpenAiSseEvent(rawEvent);
  return events.map((event) => ({
    event,
    sequence: nextSequence(),
    receivedAt: (/* @__PURE__ */ new Date()).toISOString(),
    requestId,
    rawEventName: rawEvent.event,
    unknownFields
  }));
}
function remainingBudgetMs(now, streamStartedAt, lastByteAt, receivedFirstByte, timeBudget) {
  if (!timeBudget) return void 0;
  const candidates = [];
  if (timeBudget.requestDeadlineMs !== void 0) {
    candidates.push(Math.max(0, timeBudget.requestDeadlineMs - (now - streamStartedAt)));
  }
  const idleLimit = receivedFirstByte ? timeBudget.idleTimeoutMs : timeBudget.firstByteTimeoutMs;
  if (idleLimit !== void 0) {
    candidates.push(Math.max(0, idleLimit - (now - lastByteAt)));
  }
  return candidates.length > 0 ? Math.min(...candidates) : void 0;
}
function raceReadAgainstBudget(reader, remainingMs) {
  const readPromise = reader.read();
  if (remainingMs === void 0) return readPromise;
  readPromise.catch(() => {
  });
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), remainingMs);
  });
  return Promise.race([readPromise, timeoutPromise]).finally(() => clearTimeout(timer));
}
async function* readSseBody(body, requestId, timeBudget, cancellation, abortController) {
  const reader = body.getReader();
  const parser = new SseParser();
  let sequence = 0;
  let sawTerminal = false;
  const streamStartedAt = Date.now();
  let lastByteAt = streamStartedAt;
  let receivedFirstByte = false;
  try {
    for (; ; ) {
      if (cancellation?.isCancelled) {
        throw new AgenticError("cancelled", `${OPERATION} was cancelled locally`, {
          product: PRODUCT3,
          operation: OPERATION,
          requestId,
          retryable: false,
          code: "local_cancellation",
          details: { partial: true, eventsReceived: sequence }
        });
      }
      const now = Date.now();
      if (timeBudget?.requestDeadlineMs !== void 0 && now - streamStartedAt > timeBudget.requestDeadlineMs) {
        throw deadlineError(
          OPERATION,
          requestId,
          "request_deadline_exceeded",
          `${OPERATION} exceeded requestDeadlineMs (${timeBudget.requestDeadlineMs}ms)`,
          sequence
        );
      }
      const idleLimit = receivedFirstByte ? timeBudget?.idleTimeoutMs : timeBudget?.firstByteTimeoutMs;
      if (idleLimit !== void 0 && now - lastByteAt > idleLimit) {
        throw deadlineError(
          OPERATION,
          requestId,
          receivedFirstByte ? "idle_timeout" : "first_byte_timeout",
          `${OPERATION} exceeded ${receivedFirstByte ? "idleTimeoutMs" : "firstByteTimeoutMs"} (${idleLimit}ms)`,
          sequence
        );
      }
      const remainingMs = remainingBudgetMs(now, streamStartedAt, lastByteAt, receivedFirstByte, timeBudget);
      let readResult;
      try {
        const raced = await raceReadAgainstBudget(reader, remainingMs);
        if (raced === "timeout") {
          abortController.abort();
          continue;
        }
        readResult = raced;
      } catch (cause) {
        throw new AgenticError("transport", `${OPERATION} stream read failed: ${cause}`, {
          product: PRODUCT3,
          operation: OPERATION,
          requestId,
          retryable: false,
          code: "stream_disconnected",
          details: { partial: true, eventsReceived: sequence },
          cause
        });
      }
      if (readResult.done) break;
      receivedFirstByte = true;
      lastByteAt = Date.now();
      let rawEvents;
      try {
        rawEvents = parser.feed(readResult.value);
      } catch (cause) {
        throw new AgenticError("protocol", `${OPERATION} SSE parse failure: ${cause}`, {
          product: PRODUCT3,
          operation: OPERATION,
          requestId,
          retryable: false,
          code: "sse_parse_error",
          details: { partial: true, eventsReceived: sequence },
          cause
        });
      }
      for (const rawEvent of rawEvents) {
        for (const envelope of buildEnvelopes(rawEvent, requestId, () => sequence += 1)) {
          if (envelope.event.type === "done" || envelope.event.type === "finish_reason") sawTerminal = true;
          yield envelope;
        }
      }
    }
    let finishResult;
    try {
      finishResult = parser.finish();
    } catch (cause) {
      throw new AgenticError("protocol", `${OPERATION} SSE parse failure at end of stream: ${cause}`, {
        product: PRODUCT3,
        operation: OPERATION,
        requestId,
        retryable: false,
        code: "sse_parse_error",
        details: { partial: true, eventsReceived: sequence },
        cause
      });
    }
    for (const rawEvent of finishResult.events) {
      for (const envelope of buildEnvelopes(rawEvent, requestId, () => sequence += 1)) {
        if (envelope.event.type === "done" || envelope.event.type === "finish_reason") sawTerminal = true;
        yield envelope;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!sawTerminal) {
    throw new AgenticError("protocol", `${OPERATION} stream ended without ever observing a terminal event`, {
      product: PRODUCT3,
      operation: OPERATION,
      requestId,
      retryable: false,
      code: "stream_ended_without_terminal_event",
      details: { partial: true, eventsReceived: sequence }
    });
  }
}

// src/meta-llm/client.ts
var DEFAULT_CAPABILITY_VERSION = "0.0.0";
var PRODUCT4 = "meta-llm";
function newRequestId2() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
var MetaLlmClient = class {
  config;
  constructor(config) {
    this.config = resolveMetaLlmClientConfig(config);
  }
  // ---------------------------------------------------------------------
  // D2: health, models, whoami, capabilities, ready — implemented this pass
  // ---------------------------------------------------------------------
  /** Process-level health only — never identity or readiness (ADR-0024a §D1). */
  async health(options) {
    return this.getJson("/v1/health", "health", options, {
      requireCredential: false
    });
  }
  /** `/v1/models`. May not list every alias the resolver accepts (ADR-0024a Context). */
  async models(options) {
    return this.getJson("/v1/models", "models", options, {
      requireCredential: true
    });
  }
  /** Authenticated account and credential type only (ADR-0024a §D1). */
  async whoami(options) {
    return this.getJson("/v1/whoami", "whoami", options, {
      requireCredential: true
    });
  }
  /**
   * `GET /v1/usage` (ADR-0024b §D1's `client.usage`, D11 migration step 1).
   * Strictly authenticated-account scoped — every query is bound to the
   * caller's own credential; there is no parameter that can select another
   * account's usage. Uses the contract's bounded `YYYY-MM` range plus
   * optional `model`/`provider`/`groupBy` grouping (§D3). An empty result
   * is returned exactly as reported — never reinterpreted as "no usage
   * anywhere" vs. "this account genuinely has none" (§D3: no speculative
   * fallback logic is layered on top).
   */
  async usage(query, options) {
    try {
      assertValidUsageQuery(query);
    } catch (cause) {
      throw new AgenticError("validation", `usage query rejected: ${cause.message}`, {
        product: PRODUCT4,
        operation: "usage",
        retryable: false,
        cause
      });
    }
    const params = new URLSearchParams({ from: query.from, to: query.to });
    if (query.model) params.set("model", query.model);
    if (query.provider) params.set("provider", query.provider);
    if (query.groupBy) params.set("group_by", query.groupBy);
    const { data, meta } = await this.getJson(`/v1/usage?${params.toString()}`, "usage", options, {
      requireCredential: true
    });
    return { data: parseUsageSummary(data), meta };
  }
  /**
   * Versioned behavior safe for this caller, from the static compatibility
   * snapshot (no I/O — ADR-0024a §D9 gate #3 is not yet published). Unknown
   * server versions receive the intersection of proven-safe capabilities,
   * never the union (ADR-0019 §D6).
   */
  capabilities() {
    return this.config.capabilitiesSnapshot ?? {
      product: PRODUCT4,
      productVersion: DEFAULT_CAPABILITY_VERSION,
      protocol: "cognitum.meta-llm.http",
      protocolVersion: "1.0",
      features: {},
      limitations: ["no capabilities_snapshot configured"],
      authMethods: [],
      source: "static-compatibility-table"
    };
  }
  /**
   * Dependency readiness for a named feature. Fails closed: no readiness
   * endpoint is published yet (ADR-0024a §D1: "when published").
   */
  async ready(feature) {
    throw new AgenticError(
      "unsupported_capability",
      `ready("${feature}") is unsupported: no readiness endpoint is published for meta-llm yet`,
      { product: PRODUCT4, operation: "ready", retryable: false }
    );
  }
  // ---------------------------------------------------------------------
  // D3: protocol-specific wire types only this pass — placeholders below
  // ---------------------------------------------------------------------
  chat = {
    /**
     * `POST /v1/chat/completions` (OpenAI-style). Real HTTP call logic
     * (issue #58 / M2 continuation): idempotency-key generation, bounded
     * 429/502/503 retry, and a single 401-refresh — see `./nonstream.js`.
     * Streaming (`request.stream = true`) is not validated against here —
     * this pass only implements the nonstream path (§D5 is a follow-up
     * issue).
     */
    completions: (request, options) => postJsonIdempotent(
      this.nonstreamDeps(options),
      "/v1/chat/completions",
      "chat.completions",
      request
    ),
    /**
     * `POST /v1/chat/completions` with `stream: true` (ADR-0024a §D5).
     * Issue #58 / M2 continuation — the first protocol wired onto the
     * generic SSE parser (`../sse/parser.js`); Anthropic Messages and
     * Responses streaming are deferred follow-ups that reuse the same
     * parser. Returns an async generator — iterate with `for await`; it
     * completes normally only after the OpenAI wire terminal condition
     * (`[DONE]` or a `finish_reason`) is observed, otherwise it throws a
     * typed `AgenticError` describing why (see `./stream/chat-completions-stream.js`).
     */
    completionsStream: (request, options) => chatCompletionsStreamImpl(this.nonstreamDeps(options), request, options?.requestContext)
  };
  /**
   * `POST /v1/completions` (legacy OpenAI completions). Real HTTP call
   * logic (issue #58 / M2 continuation) — this is a "direct nonstream
   * call whose accepted contract declares safe replay" per ADR-0024a §D7,
   * the same class as `chat.completions`/`messages.create`, so it reuses
   * `postJsonIdempotent` from `./nonstream.js` verbatim (idempotency-key
   * generation, bounded 429/502/503 retry, single 401-refresh).
   */
  completions(request, options) {
    return postJsonIdempotent(
      this.nonstreamDeps(options),
      "/v1/completions",
      "completions",
      request
    );
  }
  messages = {
    /**
     * `POST /v1/messages` (Anthropic-style). Real HTTP call logic (issue
     * #58 / M2 continuation) — see `chat.completions`'s doc comment and
     * `./nonstream.js` for the shared idempotency/retry logic.
     */
    create: (request, options) => postJsonIdempotent(
      this.nonstreamDeps(options),
      "/v1/messages",
      "messages.create",
      request
    ),
    /**
     * `POST /v1/messages/count_tokens`. Same "direct nonstream call"
     * class as `messages.create` (ADR-0024a §D7) — reuses
     * `postJsonIdempotent` verbatim.
     */
    countTokens: (request, options) => postJsonIdempotent(
      this.nonstreamDeps(options),
      "/v1/messages/count_tokens",
      "messages.countTokens",
      request
    )
  };
  /**
   * `POST /v1/responses`. Current server is stateless: callers resend
   * conversation input. `previousResponseId` is preview and MUST NOT be
   * described as recovery (ADR-0024a §D3) — this method does not restore
   * or synthesize any prior conversation state; it only sends `request`
   * as given. Real HTTP call logic (issue #58 / M2 continuation) reuses
   * `postJsonIdempotent` verbatim, same as `chat.completions`.
   */
  responses(request, options) {
    return postJsonIdempotent(
      this.nonstreamDeps(options),
      "/v1/responses",
      "responses",
      request
    );
  }
  /**
   * `POST /v1/embeddings`. Real HTTP call logic (issue #58 / M2
   * continuation) reuses `postJsonIdempotent` verbatim — infrastructure is
   * identical to the other direct nonstream operations even though
   * embeddings has its own separate maturity gate criteria in ADR-0024a
   * §D2 ("input limits, dimensions, usage, errors and auth published").
   */
  embeddings(request, options) {
    return postJsonIdempotent(
      this.nonstreamDeps(options),
      "/v1/embeddings",
      "embeddings",
      request
    );
  }
  /**
   * Close local connections and wait only. Never cancels a remote
   * operation, stops a pod, releases a reservation, or revokes a
   * credential (ADR-0024a §D1).
   */
  async close() {
  }
  // ---------------------------------------------------------------------
  // Internal HTTP glue shared by health/whoami/models, chat.completions,
  // and messages.create
  // ---------------------------------------------------------------------
  /** Build the dependency bag `postJsonIdempotent` (`./nonstream.js`) needs. */
  nonstreamDeps(options) {
    const tenant = options?.requestContext?.tenant ?? this.config.defaultRequestContext?.tenant;
    return {
      baseUrl: this.config.baseUrl,
      transport: this.config.transport ?? fetch,
      credentialProvider: this.config.credentialProvider,
      defaultRequestContext: tenant ? { tenant } : this.config.defaultRequestContext,
      telemetry: this.config.telemetry
    };
  }
  async resolveCredential(operation, requiredScopes) {
    const provider = this.config.credentialProvider;
    if (!provider) return void 0;
    return provider.acquire({
      product: PRODUCT4,
      normalizedOrigin: this.config.baseUrl,
      audience: this.config.baseUrl,
      requiredScopes,
      operation,
      interactiveAllowed: false
    });
  }
  applyAuth(headers, credential) {
    if (!credential) return;
    if (credential.scheme.toLowerCase() === "bearer") {
      headers.Authorization = `Bearer ${credential.secret.reveal()}`;
    } else {
      headers[credential.scheme] = credential.secret.reveal();
    }
  }
  async getJson(path, operation, options, opts) {
    const requestId = options?.requestContext?.requestId ?? this.config.defaultRequestContext?.requestId ?? newRequestId2();
    this.config.telemetry?.onRequestStart?.({ operation, requestId });
    const startedAt = Date.now();
    let credential;
    if (opts.requireCredential) {
      credential = await this.resolveCredential(operation, ["meta-llm.read"]).catch((cause) => {
        throw new AgenticError("authentication", `failed to acquire credential: ${cause}`, {
          product: PRODUCT4,
          operation,
          requestId,
          retryable: false,
          cause
        });
      });
      if (!credential) {
        throw new AgenticError(
          "authentication",
          `MetaLlmClient.${operation} requires a credential_provider`,
          { product: PRODUCT4, operation, requestId, retryable: false }
        );
      }
      assertScopeGranted(PRODUCT4, operation, "meta-llm.read", credential);
    }
    const headers = {
      Accept: "application/json",
      "X-Cognitum-Request-Id": requestId
    };
    this.applyAuth(headers, credential);
    const transport = this.config.transport ?? fetch;
    const url = `${this.config.baseUrl}${path}`;
    let response;
    try {
      response = await transport(url, { method: "GET", headers });
    } catch (cause) {
      this.config.telemetry?.onRequestEnd?.({
        operation,
        requestId,
        durationMs: Date.now() - startedAt
      });
      throw new AgenticError("transport", `${operation} request failed: ${cause}`, {
        product: PRODUCT4,
        operation,
        requestId,
        retryable: true,
        cause
      });
    }
    const durationMs = Date.now() - startedAt;
    this.config.telemetry?.onRequestEnd?.({
      operation,
      requestId,
      httpStatus: response.status,
      durationMs
    });
    if (!response.ok) {
      throw await mapMetaLlmHttpError(response, operation, requestId);
    }
    const data = await response.json();
    const meta = {
      requestId: response.headers.get("x-cognitum-request-id") ?? requestId,
      httpStatus: response.status,
      protocolVersion: response.headers.get("x-cognitum-protocol-version") ?? void 0
    };
    return { data, meta };
  }
};

// src/meta-llm/stream/envelope.ts
var ChatCompletionsStreamAccumulator = class {
  role;
  contentByIndex = /* @__PURE__ */ new Map();
  toolCallsByIndex = /* @__PURE__ */ new Map();
  finishReasonByIndex = /* @__PURE__ */ new Map();
  usage;
  receipt;
  done = false;
  absorb(envelope) {
    const event = envelope.event;
    switch (event.type) {
      case "role":
        this.role = event.role;
        break;
      case "content_delta":
        this.contentByIndex.set(event.index, (this.contentByIndex.get(event.index) ?? "") + event.delta);
        break;
      case "tool_call_delta": {
        let byIndex = this.toolCallsByIndex.get(event.index);
        if (!byIndex) {
          byIndex = /* @__PURE__ */ new Map();
          this.toolCallsByIndex.set(event.index, byIndex);
        }
        const existing = byIndex.get(event.toolCallIndex) ?? { arguments: "" };
        if (event.id) existing.id = event.id;
        if (event.functionName) existing.name = event.functionName;
        if (event.argumentsDelta) existing.arguments += event.argumentsDelta;
        byIndex.set(event.toolCallIndex, existing);
        break;
      }
      case "finish_reason":
        this.finishReasonByIndex.set(event.index, event.finishReason);
        break;
      case "usage":
        this.usage = event.usage;
        break;
      case "receipt":
        this.receipt = event.receipt;
        break;
      case "done":
        this.done = true;
        break;
      default:
        break;
    }
  }
  snapshot() {
    const contentByChoice = {};
    for (const [index, content] of this.contentByIndex) contentByChoice[index] = content;
    const toolCallsByChoice = {};
    for (const [index, byIndex] of this.toolCallsByIndex) {
      toolCallsByChoice[index] = Array.from(byIndex.values());
    }
    const finishReasonByChoice = {};
    for (const [index, reason] of this.finishReasonByIndex) finishReasonByChoice[index] = reason;
    return {
      role: this.role,
      contentByChoice,
      toolCallsByChoice,
      finishReasonByChoice,
      usage: this.usage,
      receipt: this.receipt,
      completed: this.done
    };
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ChatCompletionsStreamAccumulator,
  InvalidUsageQueryError,
  MetaLlmClient,
  UnsendableRoutingControlsError,
  assertSendableRoutingControls,
  assertValidUsageQuery,
  decodeOpenAiSseEvent,
  parseMetaLlmReceipt,
  parseMoney,
  parseUsageSummary,
  resolveMetaLlmClientConfig
});
//# sourceMappingURL=index.cjs.map