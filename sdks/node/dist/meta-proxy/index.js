// src/meta-proxy/config.ts
var DEFAULT_META_PROXY_ORIGIN = "http://127.0.0.1:11435";
var warnedNonLoopback = false;
function __resetMetaProxyNonLoopbackWarnLatch() {
  warnedNonLoopback = false;
}
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
function isBearerAttachmentAllowed(origin, allowNonLoopback) {
  if (allowNonLoopback) return true;
  const host = extractHost(origin);
  return host !== null && isLoopbackHost(host);
}
function warnNonLoopbackOnce(origin) {
  if (warnedNonLoopback) return;
  warnedNonLoopback = true;
  console.warn(
    `[cognitum-sdk/meta-proxy] Non-loopback origin "${origin}" is ENABLED via allowNonLoopback. This is DANGEROUS PREVIEW (ADR-0025a \xA7D10) \u2014 the current Proxy has no separate TLS, remote identity, firewall, or restricted-CORS contract for this mode. Never use this in production.`
  );
}
function resolveMetaProxyClientConfig(config = {}) {
  const rawOrigin = config.origin ?? DEFAULT_META_PROXY_ORIGIN;
  if (!rawOrigin) {
    throw new TypeError("MetaProxyClientConfig.origin must not be empty when provided");
  }
  const trimmed = rawOrigin.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new TypeError(
      `MetaProxyClientConfig.origin must be an http(s) URL; got "${config.origin}"`
    );
  }
  const host = extractHost(trimmed);
  if (!host || !isLoopbackHost(host)) {
    if (!config.allowNonLoopback) {
      throw new TypeError(
        `MetaProxyClientConfig.origin must be a literal IPv4/IPv6 loopback address (ADR-0025a \xA7D10); got "${config.origin}". Hostname resolution to loopback (e.g. "localhost") is insufficient. Set allowNonLoopback: true only for the dangerous-preview remote case described in \xA7D10.`
      );
    }
    warnNonLoopbackOnce(trimmed);
  }
  return { ...config, origin: trimmed };
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
var UnsupportedCapabilityError = class extends AgenticError {
  capability;
  constructor(product, operation, capability, message) {
    super(
      "unsupported_capability",
      message ?? `capability "${capability}" is unsupported or unknown for ${product}/${operation}`,
      { product, operation, retryable: false }
    );
    this.name = "UnsupportedCapabilityError";
    this.capability = capability;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
var ConsentRequiredError = class extends AgenticError {
  requiredKind;
  constructor(product, operation, requiredKind, message) {
    super(
      "consent_required",
      message ?? `operation "${operation}" on ${product} requires an unexpired ADR-0022 consent grant of kind "${requiredKind}" \u2014 credential presence alone is not consent`,
      { product, operation, retryable: false }
    );
    this.name = "ConsentRequiredError";
    this.requiredKind = requiredKind;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
var UnsupportedRuntimeError = class extends AgenticError {
  runtime;
  constructor(product, operation, runtime, message) {
    super(
      "configuration",
      message ?? `${product} does not support the "${runtime}" runtime (ADR-0029 \xA7D2) \u2014 construction refused before reading a credential or opening a socket`,
      { product, operation, retryable: false }
    );
    this.name = "UnsupportedRuntimeError";
    this.runtime = runtime;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};

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
import { createHash } from "crypto";

// src/agentic/receipt-verification.ts
import { createHash as createHash2, createHmac, timingSafeEqual } from "crypto";

// src/meta-proxy/routing.ts
var PRODUCT = "meta-proxy";
function assertRoutingReceiptMatchesIntent(intent, receipt) {
  const required = intent?.requiredPlane;
  if (!required) return;
  if (!receipt) {
    throw new AgenticError(
      "protocol",
      `RoutingIntent.requiredPlane "${required}" cannot be verified: the Proxy response carried no routing receipt (ADR-0025a \xA7D4: every inference must return selected-plane evidence)`,
      {
        product: PRODUCT,
        operation: "chat.completions",
        retryable: false,
        details: { requiredPlane: required }
      }
    );
  }
  if (receipt.selectedPlane !== required) {
    throw new AgenticError(
      "protocol",
      `Proxy selected plane "${receipt.selectedPlane}" but RoutingIntent.requiredPlane was "${required}" \u2014 a required-plane mismatch is a protocol violation even when output succeeds (ADR-0025a \xA7D5 rule 7)`,
      {
        product: PRODUCT,
        operation: "chat.completions",
        requestId: receipt.requestId,
        retryable: false,
        details: {
          requiredPlane: required,
          selectedPlane: receipt.selectedPlane,
          configuredPlane: receipt.configuredPlane
        }
      }
    );
  }
}

// src/meta-proxy/consent.ts
var PRODUCT2 = "meta-proxy";
var CLOUD_ROUTING_CONSENT_KIND = "cloud_fallback";
function intentTouchesPlane(intent, plane) {
  return intent.requiredPlane === plane || intent.allowedPlanes.includes(plane);
}
function isConsentGrantValid(grant, kind, product, origin, now = /* @__PURE__ */ new Date()) {
  if (grant.kind !== kind) return false;
  if (grant.product !== product) return false;
  if (grant.origin !== origin) return false;
  if (grant.expiresAt !== void 0 && new Date(grant.expiresAt).getTime() <= now.getTime()) {
    return false;
  }
  return true;
}
function hasValidConsentGrant(grants, kind, product, origin, now) {
  return grants.some((grant) => isConsentGrantValid(grant, kind, product, origin, now));
}
function assertConsentForRoutingIntent(intent, grants, origin, operation, now) {
  if (!intent) return;
  if (!intentTouchesPlane(intent, "cognitum_cloud")) return;
  if (hasValidConsentGrant(grants, CLOUD_ROUTING_CONSENT_KIND, PRODUCT2, origin, now)) return;
  throw new ConsentRequiredError(
    PRODUCT2,
    operation,
    CLOUD_ROUTING_CONSENT_KIND,
    `${operation}'s RoutingIntent allows or requires the "cognitum_cloud" plane, but no unexpired ADR-0022 "${CLOUD_ROUTING_CONSENT_KIND}" consent grant is present for origin "${origin}" (ADR-0025a \xA7D9: credential presence is not consent \u2014 headless clients return ConsentRequiredError rather than prompt).`
  );
}

// src/meta-proxy/browser-guard.ts
var PRODUCT3 = "meta-proxy";
function isBrowserLikeRuntime() {
  const g = globalThis;
  if (typeof g.window !== "undefined") return true;
  if (typeof g.document !== "undefined") return true;
  const proc = g.process;
  if (typeof proc === "undefined") return true;
  if (typeof proc.versions === "undefined") return true;
  if (typeof proc.versions.node === "undefined") return true;
  return false;
}
function assertNodeRuntime(operation) {
  if (!isBrowserLikeRuntime()) return;
  throw new UnsupportedRuntimeError(
    PRODUCT3,
    operation,
    "browser",
    `MetaProxyClient cannot be constructed in a browser-like runtime (ADR-0025a \xA7D10, ADR-0029 \xA7D2): its loopback token, local consent, process ownership, and CORS behavior are not a browser contract. Construction is refused before reading a credential or opening a loopback socket.`
  );
}

// src/meta-proxy/auth.ts
import { createHash as createHash3 } from "crypto";
var PRODUCT4 = "meta-proxy";
var DEFAULT_META_PROXY_TOKEN_ENV_VAR = "COGNITUM_META_PROXY_TOKEN";
function resolveToken(options) {
  if (options.token && options.token.length > 0) {
    return options.token;
  }
  const envVar = options.envVar ?? DEFAULT_META_PROXY_TOKEN_ENV_VAR;
  const env = options.env ?? (typeof process !== "undefined" ? process.env : {});
  const fromEnv = env[envVar];
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  throw new AgenticError(
    "configuration",
    `local proxy bearer is required \u2014 pass token or set ${envVar}`,
    { product: PRODUCT4 }
  );
}
function fingerprintOf(token) {
  return createHash3("sha256").update(`${PRODUCT4}:${token}`).digest("hex").slice(0, 16);
}
var LocalBearerTokenCredentialProvider = class {
  #secret;
  #normalizedOrigin;
  #audience;
  #fingerprint;
  #invalidated = false;
  constructor(options) {
    const token = resolveToken(options);
    this.#secret = new RedactedSecret(token);
    this.#normalizedOrigin = options.normalizedOrigin;
    this.#audience = options.audience ?? options.normalizedOrigin;
    this.#fingerprint = fingerprintOf(token);
  }
  /** Non-secret stable provider identity, safe to log. */
  identity() {
    return `local-bearer-token:${PRODUCT4}:${this.#fingerprint}`;
  }
  async describeAuthority(request) {
    this.assertMatch(request);
    return this.authority();
  }
  async acquire(request) {
    this.assertMatch(request);
    if (this.#invalidated) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} has been invalidated`,
        { product: PRODUCT4, operation: request.operation }
      );
    }
    return {
      scheme: "bearer",
      secret: this.#secret,
      audience: this.#audience,
      source: this.identity(),
      authority: this.authority()
    };
  }
  async invalidate(_reason) {
    this.#invalidated = true;
  }
  authority() {
    return {
      providerFingerprint: this.#fingerprint,
      product: PRODUCT4,
      normalizedOrigin: this.#normalizedOrigin,
      audience: this.#audience
    };
  }
  /** Fail-closed match check (ADR-0022 §D1/§D3). Exact string equality only. */
  assertMatch(request) {
    if (request.product !== PRODUCT4) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} is bound to product "${PRODUCT4}", refusing request for product "${request.product}"`,
        { product: PRODUCT4, operation: request.operation }
      );
    }
    if (request.normalizedOrigin !== this.#normalizedOrigin) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} is bound to origin "${this.#normalizedOrigin}", refusing request for origin "${request.normalizedOrigin}" (ADR-0022 \xA7D3: a redirect to another origin is not followed with credentials)`,
        { product: PRODUCT4, operation: request.operation }
      );
    }
    if (request.audience !== this.#audience) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} is bound to audience "${this.#audience}", refusing request for audience "${request.audience}"`,
        { product: PRODUCT4, operation: request.operation }
      );
    }
  }
};

// src/meta-proxy/http-errors.ts
var PRODUCT5 = "meta-proxy";
function nonEmpty(value, fallback) {
  return value.length > 0 ? value : fallback;
}
async function mapMetaProxyHttpError(response, operation, requestId) {
  const status = response.status;
  const bodyText = await response.text().catch(() => "");
  const fields = { product: PRODUCT5, operation, status, requestId };
  switch (status) {
    case 400:
      return new AgenticError("validation", nonEmpty(bodyText, "invalid request"), {
        ...fields,
        retryable: false
      });
    case 401:
      return new AgenticError(
        "authentication",
        nonEmpty(bodyText, "local Proxy authentication failed"),
        { ...fields, retryable: false }
      );
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

// src/meta-proxy/forwarding.ts
var PRODUCT6 = "meta-proxy";
var CHAT_PATH = "/v1/chat/completions";
var OPERATION = "chat.completions";
var INFERENCE_SCOPE = "meta-proxy.inference";
var PROXY_CHAT_FORWARD_HEADER_ALLOWLIST = [
  "Idempotency-Key",
  "X-Request-ID",
  "traceparent",
  "tracestate",
  "X-Cognitum-Fallback-Policy",
  "X-Cognitum-Min-Tier",
  "X-Cognitum-Max-Tier",
  "X-Cognitum-Escalation",
  "X-Cognitum-Cache",
  "X-Cognitum-Safety",
  "X-Cognitum-Sub-Tenant",
  "anthropic-version",
  "anthropic-beta"
];
var ALLOWLIST_LOWER = new Set(
  PROXY_CHAT_FORWARD_HEADER_ALLOWLIST.map((h) => h.toLowerCase())
);
function newRequestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
function newIdempotencyKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : newRequestId();
}
function rejectRedirectResponse(response, operation, requestId) {
  const isRedirect = response.type === "opaqueredirect" || response.status >= 300 && response.status < 400;
  if (!isRedirect) return;
  throw new AgenticError(
    "protocol",
    `${operation} received a redirect (status ${response.status}) \u2014 redirects are rejected, not followed (ADR-0025a \xA7D6/\xA7D10)`,
    { product: PRODUCT6, operation, status: response.status, requestId, retryable: false }
  );
}
function filterForwardHeaders(bag) {
  const forwarded = {};
  let idempotencyKey;
  if (!bag) return { forwarded };
  for (const [key, value] of Object.entries(bag)) {
    const lower = key.toLowerCase();
    if (!ALLOWLIST_LOWER.has(lower)) continue;
    if (lower === "idempotency-key") {
      idempotencyKey = value;
      continue;
    }
    forwarded[key] = value;
  }
  return { forwarded, idempotencyKey };
}
function applyBearer(deps, headers, credential) {
  if (!isBearerAttachmentAllowed(deps.origin, deps.allowNonLoopback)) {
    throw new AgenticError(
      "protocol",
      `refusing to attach the local bearer to non-loopback origin "${deps.origin}" (ADR-0025a \xA7D6/\xA7D10: the bearer is sent only to literal loopback)`,
      { product: PRODUCT6, operation: OPERATION, retryable: false }
    );
  }
  headers.Authorization = `Bearer ${credential.secret.reveal()}`;
}
async function requireCredential(deps) {
  const provider = deps.credentialProvider;
  if (!provider) {
    throw new AgenticError(
      "authentication",
      `MetaProxyClient.${OPERATION} requires a localCredentialProvider (ADR-0025a \xA7D6)`,
      { product: PRODUCT6, operation: OPERATION, retryable: false }
    );
  }
  return provider.acquire({
    product: PRODUCT6,
    normalizedOrigin: deps.origin,
    audience: deps.origin,
    requiredScopes: [INFERENCE_SCOPE],
    operation: OPERATION,
    interactiveAllowed: false
  });
}
function pick(data, snake, camel) {
  return data[snake] ?? data[camel];
}
function parseRoutingReceipt(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
  const r = value;
  return {
    requestId: String(pick(r, "request_id", "requestId") ?? ""),
    configuredPlane: String(pick(r, "configured_plane", "configuredPlane") ?? ""),
    selectedPlane: String(pick(r, "selected_plane", "selectedPlane") ?? ""),
    routingReason: pick(r, "routing_reason", "routingReason"),
    automatic: Boolean(r.automatic),
    workloadPolicy: pick(r, "workload_policy", "workloadPolicy"),
    consentEvidenceId: pick(r, "consent_evidence_id", "consentEvidenceId"),
    upstreamReceipt: pick(r, "upstream_receipt", "upstreamReceipt"),
    localUsage: pick(r, "local_usage", "localUsage"),
    degraded: Boolean(r.degraded),
    warnings: r.warnings
  };
}
async function sendOnce(deps, body, credential, idempotencyKey, forwarded) {
  const requestId = newRequestId();
  deps.telemetry?.onRequestStart?.({ operation: OPERATION, requestId });
  const startedAt = Date.now();
  const headers = {
    // Allowlisted caller headers first, so SDK-owned headers below always win.
    ...forwarded,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Cognitum-Request-Id": requestId,
    "Idempotency-Key": idempotencyKey
  };
  applyBearer(deps, headers, credential);
  const url = `${deps.origin}${CHAT_PATH}`;
  let response;
  try {
    response = await deps.transport(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // Never follow redirects (ADR-0025a §D6/§D10). No proxy/dispatcher/agent
      // option is passed — ambient HTTP_PROXY/HTTPS_PROXY/NO_PROXY are ignored.
      redirect: "manual"
    });
  } catch (cause) {
    deps.telemetry?.onRequestEnd?.({ operation: OPERATION, requestId, durationMs: Date.now() - startedAt });
    throw new AgenticError("transport", `${OPERATION} request failed: ${cause}`, {
      product: PRODUCT6,
      operation: OPERATION,
      requestId,
      retryable: true,
      cause
    });
  }
  const durationMs = Date.now() - startedAt;
  const retryAfterHeader = response.headers.get("retry-after");
  deps.telemetry?.onRequestEnd?.({
    operation: OPERATION,
    requestId,
    httpStatus: response.status,
    durationMs,
    retryAfterMs: retryAfterHeader ? Number(retryAfterHeader) * 1e3 : void 0
  });
  rejectRedirectResponse(response, OPERATION, requestId);
  if (!response.ok) {
    const err = await mapMetaProxyHttpError(response, OPERATION, requestId);
    if (err.retryAfterMs === void 0 && retryAfterHeader) {
      err.retryAfterMs = Number(retryAfterHeader) * 1e3;
    }
    throw err;
  }
  const rawJson = await response.json();
  const routingReceipt = parseRoutingReceipt(
    pick(rawJson, "cognitum_routing_receipt", "cognitumRoutingReceipt")
  );
  const upstreamReceipt = pick(rawJson, "cognitum_upstream_receipt", "cognitumUpstreamReceipt");
  const meta = {
    requestId: response.headers.get("x-cognitum-request-id") ?? requestId,
    productVersion: response.headers.get("x-cognitum-product-version") ?? void 0,
    protocolVersion: response.headers.get("x-cognitum-protocol-version") ?? void 0,
    httpStatus: response.status,
    retryAfter: retryAfterHeader ? Number(retryAfterHeader) : void 0,
    routingReceipt,
    upstreamReceipt
  };
  return { data: rawJson, meta };
}
async function forwardChatCompletion(deps, request, options) {
  assertConsentForRoutingIntent(
    options?.routingIntent,
    deps.consentGrants ?? [],
    deps.origin,
    OPERATION
  );
  const { forwarded, idempotencyKey: callerKey } = filterForwardHeaders(options?.forwardHeaders);
  const idempotencyKey = callerKey ?? newIdempotencyKey();
  let credential = await requireCredential(deps);
  let refreshedOnce = false;
  for (; ; ) {
    let result;
    try {
      result = await sendOnce(deps, request, credential, idempotencyKey, forwarded);
    } catch (cause) {
      const err = cause;
      if (err.status === 401 && !refreshedOnce) {
        refreshedOnce = true;
        await deps.credentialProvider?.invalidate("401 challenge from meta-proxy");
        credential = await requireCredential(deps);
        continue;
      }
      throw err;
    }
    assertRoutingReceiptMatchesIntent(options?.routingIntent, result.meta.routingReceipt);
    return result;
  }
}

// src/meta-proxy/time-budget.ts
var DEFAULT_PROXY_CONNECT_TIMEOUT_MS = 1e4;
function resolveProxyTimeBudget(budget) {
  return {
    connectTimeoutMs: budget?.connectTimeoutMs ?? DEFAULT_PROXY_CONNECT_TIMEOUT_MS,
    firstByteTimeoutMs: budget?.firstByteTimeoutMs,
    idleStreamTimeoutMs: budget?.idleStreamTimeoutMs,
    overallDeadlineMs: budget?.overallDeadlineMs
  };
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
function isRecord3(value) {
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
  if (!isRecord3(parsed)) {
    return { events: [{ type: "unknown", raw: parsed }] };
  }
  const events = [];
  if (isRecord3(parsed.error)) {
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
      if (!isRecord3(choiceRaw)) continue;
      const index = typeof choiceRaw.index === "number" ? choiceRaw.index : 0;
      const delta = isRecord3(choiceRaw.delta) ? choiceRaw.delta : {};
      if (typeof delta.role === "string") {
        events.push({ type: "role", index, role: delta.role });
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        events.push({ type: "content_delta", index, delta: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const toolCallRaw of delta.tool_calls) {
          if (!isRecord3(toolCallRaw)) continue;
          const fn = isRecord3(toolCallRaw.function) ? toolCallRaw.function : {};
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
  if (isRecord3(parsed.usage)) {
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

// src/meta-proxy/stream/chat-completions-stream.ts
var PRODUCT7 = "meta-proxy";
var CHAT_PATH2 = "/v1/chat/completions";
var OPERATION2 = "chat.completionsStream";
function deadlineError(requestId, code, message, sequence) {
  return new AgenticError("deadline_exceeded", message, {
    product: PRODUCT7,
    operation: OPERATION2,
    requestId,
    retryable: false,
    code,
    details: { partial: true, eventsReceived: sequence }
  });
}
function raceAgainstTimeout(promise, ms) {
  if (ms === void 0) return promise;
  promise.catch(() => {
  });
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}
async function openStreamWithPreByteRetry(deps, request, requestId, idempotencyKey, forwarded, budget, overallStartedAt) {
  let credential = await requireCredential(deps);
  const body = JSON.stringify({ ...request, stream: true });
  let refreshedOnce = false;
  for (; ; ) {
    const now = Date.now();
    if (budget.overallDeadlineMs !== void 0 && now - overallStartedAt > budget.overallDeadlineMs) {
      throw deadlineError(
        requestId,
        "overall_deadline_exceeded",
        `${OPERATION2} exceeded overallDeadlineMs (${budget.overallDeadlineMs}ms) before a response was received`,
        0
      );
    }
    const overallRemaining = budget.overallDeadlineMs !== void 0 ? Math.max(0, budget.overallDeadlineMs - (now - overallStartedAt)) : void 0;
    const connectRemaining = overallRemaining !== void 0 ? Math.min(budget.connectTimeoutMs, overallRemaining) : budget.connectTimeoutMs;
    const headers = {
      ...forwarded,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "X-Cognitum-Request-Id": requestId,
      "Idempotency-Key": idempotencyKey
    };
    applyBearer(deps, headers, credential);
    const url = `${deps.origin}${CHAT_PATH2}`;
    const abortController = new AbortController();
    let response;
    try {
      const raced = await raceAgainstTimeout(
        deps.transport(url, { method: "POST", headers, body, redirect: "manual", signal: abortController.signal }),
        connectRemaining
      );
      if (raced === "timeout") {
        abortController.abort();
        const overallExceeded = budget.overallDeadlineMs !== void 0 && Date.now() - overallStartedAt > budget.overallDeadlineMs;
        throw deadlineError(
          requestId,
          overallExceeded ? "overall_deadline_exceeded" : "connect_timeout",
          overallExceeded ? `${OPERATION2} exceeded overallDeadlineMs (${budget.overallDeadlineMs}ms) before a response was received` : `${OPERATION2} exceeded connectTimeoutMs (${budget.connectTimeoutMs}ms) waiting for a response`,
          0
        );
      }
      response = raced;
    } catch (cause) {
      if (cause instanceof AgenticError) throw cause;
      throw new AgenticError("transport", `${OPERATION2} request failed: ${cause}`, {
        product: PRODUCT7,
        operation: OPERATION2,
        requestId,
        retryable: true,
        cause
      });
    }
    rejectRedirectResponse(response, OPERATION2, requestId);
    if (response.ok) return { response, abortController };
    const err = await mapMetaProxyHttpError(response, OPERATION2, requestId);
    const retryAfterHeader = response.headers.get("retry-after");
    if (err.retryAfterMs === void 0 && retryAfterHeader) {
      err.retryAfterMs = Number(retryAfterHeader) * 1e3;
    }
    if (err.status === 401 && !refreshedOnce) {
      refreshedOnce = true;
      await deps.credentialProvider?.invalidate("401 challenge from meta-proxy");
      credential = await requireCredential(deps);
      continue;
    }
    throw err;
  }
}
function decodeProxyChunk(rawEvent) {
  const decoded = decodeOpenAiSseEvent(rawEvent);
  const routingReceipt = parseRoutingReceipt(decoded.unknownFields?.cognitum_routing_receipt);
  const upstreamReceipt = decoded.unknownFields?.cognitum_upstream_receipt;
  return { ...decoded, routingReceipt, upstreamReceipt };
}
function remainingPostByteBudgetMs(now, overallStartedAt, lastByteAt, receivedFirstByte, budget) {
  const candidates = [];
  if (budget.overallDeadlineMs !== void 0) {
    candidates.push(Math.max(0, budget.overallDeadlineMs - (now - overallStartedAt)));
  }
  const idleLimit = receivedFirstByte ? budget.idleStreamTimeoutMs : budget.firstByteTimeoutMs;
  if (idleLimit !== void 0) {
    candidates.push(Math.max(0, idleLimit - (now - lastByteAt)));
  }
  return candidates.length > 0 ? Math.min(...candidates) : void 0;
}
async function* readProxySseBody(body, requestId, headers, budget, overallStartedAt, cancellation, abortController, routingIntent) {
  const reader = body.getReader();
  const parser = new SseParser();
  let sequence = 0;
  let sawNativeTerminal = false;
  const lastByteAtBox = { value: overallStartedAt };
  let receivedFirstByte = false;
  let latestRoutingReceipt;
  let latestUpstreamReceipt;
  const proxyMetaBase = {
    productVersion: headers.get("x-cognitum-product-version") ?? void 0,
    protocolVersion: headers.get("x-cognitum-protocol-version") ?? void 0
  };
  function buildEnvelopes(rawEvent) {
    const decoded = decodeProxyChunk(rawEvent);
    if (decoded.routingReceipt) latestRoutingReceipt = decoded.routingReceipt;
    if (decoded.upstreamReceipt !== void 0) latestUpstreamReceipt = decoded.upstreamReceipt;
    return decoded.events.map((event) => {
      sequence += 1;
      return {
        event,
        sequence,
        receivedAt: (/* @__PURE__ */ new Date()).toISOString(),
        requestId,
        rawEventName: rawEvent.event,
        unknownFields: decoded.unknownFields,
        proxyMeta: {
          ...proxyMetaBase,
          routingReceipt: latestRoutingReceipt,
          upstreamReceipt: latestUpstreamReceipt
        }
      };
    });
  }
  try {
    for (; ; ) {
      if (cancellation?.isCancelled) {
        throw new AgenticError("cancelled", `${OPERATION2} was cancelled locally`, {
          product: PRODUCT7,
          operation: OPERATION2,
          requestId,
          retryable: false,
          code: "local_cancellation",
          details: { partial: true, eventsReceived: sequence }
        });
      }
      const now = Date.now();
      if (budget.overallDeadlineMs !== void 0 && now - overallStartedAt > budget.overallDeadlineMs) {
        throw deadlineError(
          requestId,
          "overall_deadline_exceeded",
          `${OPERATION2} exceeded overallDeadlineMs (${budget.overallDeadlineMs}ms)`,
          sequence
        );
      }
      const idleLimit = receivedFirstByte ? budget.idleStreamTimeoutMs : budget.firstByteTimeoutMs;
      if (idleLimit !== void 0 && now - lastByteAtBox.value > idleLimit) {
        throw deadlineError(
          requestId,
          receivedFirstByte ? "idle_stream_timeout" : "first_byte_timeout",
          `${OPERATION2} exceeded ${receivedFirstByte ? "idleStreamTimeoutMs" : "firstByteTimeoutMs"} (${idleLimit}ms)`,
          sequence
        );
      }
      const remainingMs = remainingPostByteBudgetMs(
        now,
        overallStartedAt,
        lastByteAtBox.value,
        receivedFirstByte,
        budget
      );
      let readResult;
      try {
        const raced = await raceAgainstTimeout(reader.read(), remainingMs);
        if (raced === "timeout") {
          abortController.abort();
          continue;
        }
        readResult = raced;
      } catch (cause) {
        throw new AgenticError("transport", `${OPERATION2} stream read failed: ${cause}`, {
          product: PRODUCT7,
          operation: OPERATION2,
          requestId,
          retryable: false,
          code: "stream_disconnected",
          details: { partial: true, eventsReceived: sequence },
          cause
        });
      }
      if (readResult.done) break;
      receivedFirstByte = true;
      lastByteAtBox.value = Date.now();
      let rawEvents;
      try {
        rawEvents = parser.feed(readResult.value);
      } catch (cause) {
        throw new AgenticError("protocol", `${OPERATION2} SSE parse failure: ${cause}`, {
          product: PRODUCT7,
          operation: OPERATION2,
          requestId,
          retryable: false,
          code: "sse_parse_error",
          details: { partial: true, eventsReceived: sequence },
          cause
        });
      }
      for (const rawEvent of rawEvents) {
        for (const envelope of buildEnvelopes(rawEvent)) {
          if (envelope.event.type === "done" || envelope.event.type === "finish_reason" || envelope.event.type === "error") {
            sawNativeTerminal = true;
          }
          yield envelope;
        }
      }
    }
    let finishResult;
    try {
      finishResult = parser.finish();
    } catch (cause) {
      throw new AgenticError("protocol", `${OPERATION2} SSE parse failure at end of stream: ${cause}`, {
        product: PRODUCT7,
        operation: OPERATION2,
        requestId,
        retryable: false,
        code: "sse_parse_error",
        details: { partial: true, eventsReceived: sequence },
        cause
      });
    }
    for (const rawEvent of finishResult.events) {
      for (const envelope of buildEnvelopes(rawEvent)) {
        if (envelope.event.type === "done" || envelope.event.type === "finish_reason" || envelope.event.type === "error") {
          sawNativeTerminal = true;
        }
        yield envelope;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!sawNativeTerminal) {
    throw new AgenticError("protocol", `${OPERATION2} stream ended without ever observing a terminal event`, {
      product: PRODUCT7,
      operation: OPERATION2,
      requestId,
      retryable: false,
      code: "stream_ended_without_terminal_event",
      details: { partial: true, eventsReceived: sequence }
    });
  }
  assertRoutingReceiptMatchesIntent(routingIntent, latestRoutingReceipt);
}
async function* forwardChatCompletionStream(deps, request, options) {
  assertConsentForRoutingIntent(
    options?.routingIntent,
    deps.consentGrants ?? [],
    deps.origin,
    OPERATION2
  );
  const { forwarded, idempotencyKey: callerKey } = filterForwardHeaders(options?.forwardHeaders);
  const idempotencyKey = callerKey ?? newIdempotencyKey();
  const requestId = options?.requestContext?.requestId ?? newRequestId();
  const budget = resolveProxyTimeBudget(options?.timeBudget);
  const overallStartedAt = Date.now();
  const { response, abortController } = await openStreamWithPreByteRetry(
    deps,
    request,
    requestId,
    idempotencyKey,
    forwarded,
    budget,
    overallStartedAt
  );
  if (!response.body) {
    throw new AgenticError("protocol", `${OPERATION2} response had no readable body`, {
      product: PRODUCT7,
      operation: OPERATION2,
      requestId,
      retryable: false,
      code: "no_response_body"
    });
  }
  yield* readProxySseBody(
    response.body,
    requestId,
    response.headers,
    budget,
    overallStartedAt,
    options?.cancellation,
    abortController,
    options?.routingIntent
  );
}

// src/meta-proxy/client.ts
var PRODUCT8 = "meta-proxy";
var DEFAULT_CAPABILITY_VERSION = "0.0.0";
var KNOWN_STATUS_KEYS = /* @__PURE__ */ new Set([
  "product_version",
  "productVersion",
  "protocol_version",
  "protocolVersion",
  "compatible_sdk_range",
  "compatibleSdkRange",
  "process_state",
  "processState",
  "bind",
  "configured_plane",
  "configuredPlane",
  "selected_plane",
  "selectedPlane",
  "routing_reason",
  "routingReason",
  "automatic_usage_state",
  "automaticUsageState",
  "utilization",
  "reset_at",
  "resetAt",
  "workload_policy",
  "workloadPolicy",
  "sponsored_available",
  "sponsoredAvailable",
  "cloud_credential_source",
  "cloudCredentialSource",
  "limitations",
  "request_id",
  "requestId"
]);
function newRequestId2() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
function pick2(data, snake, camel) {
  return data[snake] ?? data[camel];
}
function parseStatus(data) {
  const raw = {};
  for (const [key, value] of Object.entries(data)) {
    if (!KNOWN_STATUS_KEYS.has(key)) raw[key] = value;
  }
  return {
    productVersion: String(pick2(data, "product_version", "productVersion") ?? ""),
    protocolVersion: pick2(data, "protocol_version", "protocolVersion"),
    compatibleSdkRange: pick2(data, "compatible_sdk_range", "compatibleSdkRange"),
    processState: String(pick2(data, "process_state", "processState") ?? "unknown"),
    bind: data.bind,
    configuredPlane: String(pick2(data, "configured_plane", "configuredPlane") ?? ""),
    selectedPlane: String(pick2(data, "selected_plane", "selectedPlane") ?? ""),
    routingReason: pick2(data, "routing_reason", "routingReason"),
    automaticUsageState: pick2(data, "automatic_usage_state", "automaticUsageState"),
    utilization: data.utilization,
    resetAt: pick2(data, "reset_at", "resetAt"),
    workloadPolicy: pick2(data, "workload_policy", "workloadPolicy"),
    sponsoredAvailable: pick2(data, "sponsored_available", "sponsoredAvailable"),
    cloudCredentialSource: pick2(data, "cloud_credential_source", "cloudCredentialSource"),
    limitations: data.limitations ?? [],
    requestId: String(pick2(data, "request_id", "requestId") ?? ""),
    ...Object.keys(raw).length > 0 ? { raw } : {}
  };
}
var MetaProxyClient = class {
  config;
  constructor(config = {}) {
    assertNodeRuntime("construct");
    this.config = resolveMetaProxyClientConfig(config);
  }
  /** Read-only view of the effective configuration. */
  getConfig() {
    return this.config;
  }
  /**
   * `GET /status` — authenticated local runtime and routing state
   * (ADR-0025a Context, §D4). `proxy_token_valid: true` (surfaced only as
   * a successful auth, never as a raw token) means only that auth
   * succeeded — this method never returns tokens, keys, OAuth data, unsafe
   * paths, or full account identifiers (§D4).
   */
  async status(options) {
    const { data, meta } = await this.getJson("/status", "status", options);
    return { data: parseStatus(data), meta };
  }
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
  async capabilities(options) {
    const { data: status, meta } = await this.status(options);
    const snapshot = this.config.capabilitiesSnapshot;
    const warnings = [...meta.warnings ?? []];
    if (this.config.expectedProxyVersion && this.config.expectedProxyVersion !== status.productVersion) {
      warnings.push(
        `expectedProxyVersion "${this.config.expectedProxyVersion}" does not match the Proxy's reported productVersion "${status.productVersion}" (ADR-0025a \xA7D2: unknown versions receive a minimum-safe set)`
      );
    }
    const capabilities = {
      product: PRODUCT8,
      productVersion: status.productVersion || DEFAULT_CAPABILITY_VERSION,
      protocol: snapshot?.protocol ?? "cognitum.meta-proxy.http",
      protocolVersion: status.protocolVersion ?? snapshot?.protocolVersion ?? "1.0",
      features: snapshot?.features ?? {},
      limitations: [...status.limitations, ...snapshot?.limitations ?? []],
      authMethods: snapshot?.authMethods ?? [],
      source: "server",
      compatibleSdkRange: status.compatibleSdkRange,
      selectedPlane: status.selectedPlane,
      configuredPlane: status.configuredPlane
    };
    return {
      data: capabilities,
      meta: { ...meta, warnings: warnings.length > 0 ? warnings : meta.warnings }
    };
  }
  /**
   * `POST /v1/chat/completions` through the Proxy (ADR-0025a §D7), non-
   * streaming only this pass (§D8 streaming is deferred, so there is no
   * `chat.completionsStream` here). Namespace-object shape mirrors
   * `MetaLlmClient.chat.completions` (`../meta-llm/client.js`), but the call
   * returns a Proxy result whose `meta` carries the selected-plane routing
   * receipt and is verified against `options.routingIntent.requiredPlane`
   * (§D5 rule 7). See `./forwarding.js` for the header allowlist, idempotency,
   * retry, redirect, and ambient-proxy rules.
   */
  chat = {
    completions: (request, options) => forwardChatCompletion(this.forwardingDeps(), request, options),
    /**
     * `POST /v1/chat/completions` through the Proxy with `stream: true`
     * (ADR-0025a §D8). Returns an async generator of
     * `MetaProxyStreamEnvelope<OpenAiStreamEvent>` — iterate with `for await`.
     * See `./stream/chat-completions-stream.js` for the full streaming
     * contract (reused SSE parser/decoder, `ProxyTimeBudget`, no auto-retry,
     * required-plane verification on the terminal receipt).
     */
    completionsStream: (request, options) => forwardChatCompletionStream(this.forwardingDeps(), request, options)
  };
  /**
   * `client.preview.sponsored.chatCompletions` (ADR-0025a §D1 topology,
   * §D9 preview maturity). Sponsored forwarding itself (budget, receipts,
   * atomic spend) is explicitly OUT of scope this pass (§D9 defers to
   * ADR-0025b's lifecycle/state fixes) — this method exists ONLY to
   * fail fast, with zero HTTP I/O, per §D1 ("Such a call returns
   * `UnsupportedCapabilityError` before HTTP I/O") and §D8 ("Sponsored
   * `stream = true` fails locally until an end-to-end stream capability
   * exists"). Streaming and non-streaming sponsored calls both fail this
   * pass; the error message distinguishes the two so a caller who only
   * hit the streaming restriction isn't told sponsor support is entirely
   * absent when non-stream sponsor lands in a later pass.
   */
  preview = {
    sponsored: {
      chatCompletions: async (request, _options) => {
        if (request.stream) {
          throw new UnsupportedCapabilityError(
            PRODUCT8,
            "preview.sponsored.chatCompletions",
            "sponsored-inference-streaming",
            "Sponsored stream=true fails locally until an end-to-end stream capability exists (ADR-0025a \xA7D8) \u2014 this SDK pass does not implement sponsored streaming at all."
          );
        }
        throw new UnsupportedCapabilityError(
          PRODUCT8,
          "preview.sponsored.chatCompletions",
          "sponsored-inference",
          "Sponsored chat.completions forwarding is not implemented this pass (ADR-0025a \xA7D9 consent/sponsor-budget/usage is explicitly out of scope; ADR-0025b's lifecycle/state fixes are a prerequisite for stable sponsor support)."
        );
      }
    }
  };
  /** Assemble the `./forwarding.js` dependency bag from resolved config. */
  forwardingDeps() {
    return {
      origin: this.config.origin,
      transport: this.config.transport ?? fetch,
      credentialProvider: this.config.localCredentialProvider,
      allowNonLoopback: this.config.allowNonLoopback,
      defaultRequestContext: this.config.defaultRequestContext,
      telemetry: this.config.telemetry,
      consentGrants: this.config.consentGrants
    };
  }
  /**
   * Close local connections and wait only. Never stops the sidecar process
   * (ADR-0025a §D3: "Closing it releases connections only and never stops
   * the sidecar.").
   */
  async close() {
  }
  // ---------------------------------------------------------------------
  // Internal HTTP glue shared by status()/capabilities()
  // ---------------------------------------------------------------------
  async resolveCredential(operation) {
    const provider = this.config.localCredentialProvider;
    if (!provider) return void 0;
    return provider.acquire({
      product: PRODUCT8,
      normalizedOrigin: this.config.origin,
      audience: this.config.origin,
      requiredScopes: ["meta-proxy.status"],
      operation,
      interactiveAllowed: false
    });
  }
  applyAuth(headers, credential) {
    if (!credential) return;
    if (!isBearerAttachmentAllowed(this.config.origin, this.config.allowNonLoopback)) {
      throw new AgenticError(
        "protocol",
        `refusing to attach the local bearer to non-loopback origin "${this.config.origin}" (ADR-0025a \xA7D6/\xA7D10)`,
        { product: PRODUCT8, retryable: false }
      );
    }
    if (credential.scheme.toLowerCase() === "bearer") {
      headers.Authorization = `Bearer ${credential.secret.reveal()}`;
    } else {
      headers[credential.scheme] = credential.secret.reveal();
    }
  }
  async getJson(path, operation, options) {
    const requestId = options?.requestContext?.requestId ?? newRequestId2();
    this.config.telemetry?.onRequestStart?.({ operation, requestId });
    const startedAt = Date.now();
    let credential;
    try {
      credential = await this.resolveCredential(operation);
    } catch (cause) {
      throw new AgenticError("authentication", `failed to acquire local credential: ${cause}`, {
        product: PRODUCT8,
        operation,
        requestId,
        retryable: false,
        cause
      });
    }
    if (!credential) {
      throw new AgenticError(
        "authentication",
        `MetaProxyClient.${operation} requires a localCredentialProvider (ADR-0025a Context: "GET /status | Authenticated local runtime and routing state")`,
        { product: PRODUCT8, operation, requestId, retryable: false }
      );
    }
    const headers = {
      Accept: "application/json",
      "X-Cognitum-Request-Id": requestId
    };
    this.applyAuth(headers, credential);
    const transport = this.config.transport ?? fetch;
    const url = `${this.config.origin}${path}`;
    let response;
    try {
      response = await transport(url, { method: "GET", headers, redirect: "manual" });
    } catch (cause) {
      this.config.telemetry?.onRequestEnd?.({
        operation,
        requestId,
        durationMs: Date.now() - startedAt
      });
      throw new AgenticError("transport", `${operation} request failed: ${cause}`, {
        product: PRODUCT8,
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
    rejectRedirectResponse(response, operation, requestId);
    if (!response.ok) {
      throw await mapMetaProxyHttpError(response, operation, requestId);
    }
    const data = await response.json();
    const retryAfterHeader = response.headers.get("retry-after");
    const meta = {
      requestId: response.headers.get("x-cognitum-request-id") ?? requestId,
      productVersion: response.headers.get("x-cognitum-product-version") ?? void 0,
      protocolVersion: response.headers.get("x-cognitum-protocol-version") ?? void 0,
      httpStatus: response.status,
      retryAfter: retryAfterHeader ? Number(retryAfterHeader) : void 0
    };
    return { data, meta };
  }
};
export {
  CLOUD_ROUTING_CONSENT_KIND,
  DEFAULT_META_PROXY_ORIGIN,
  DEFAULT_META_PROXY_TOKEN_ENV_VAR,
  DEFAULT_PROXY_CONNECT_TIMEOUT_MS,
  LocalBearerTokenCredentialProvider,
  MetaProxyClient,
  PROXY_CHAT_FORWARD_HEADER_ALLOWLIST,
  __resetMetaProxyNonLoopbackWarnLatch,
  assertConsentForRoutingIntent,
  assertNodeRuntime,
  assertRoutingReceiptMatchesIntent,
  forwardChatCompletion,
  forwardChatCompletionStream,
  hasValidConsentGrant,
  intentTouchesPlane,
  isBearerAttachmentAllowed,
  isBrowserLikeRuntime,
  isConsentGrantValid,
  rejectRedirectResponse,
  resolveMetaProxyClientConfig,
  resolveProxyTimeBudget
};
//# sourceMappingURL=index.js.map