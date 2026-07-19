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

// src/meta-proxy/index.ts
var meta_proxy_exports = {};
__export(meta_proxy_exports, {
  DEFAULT_META_PROXY_ORIGIN: () => DEFAULT_META_PROXY_ORIGIN,
  DEFAULT_META_PROXY_TOKEN_ENV_VAR: () => DEFAULT_META_PROXY_TOKEN_ENV_VAR,
  LocalBearerTokenCredentialProvider: () => LocalBearerTokenCredentialProvider,
  MetaProxyClient: () => MetaProxyClient,
  PROXY_CHAT_FORWARD_HEADER_ALLOWLIST: () => PROXY_CHAT_FORWARD_HEADER_ALLOWLIST,
  __resetMetaProxyNonLoopbackWarnLatch: () => __resetMetaProxyNonLoopbackWarnLatch,
  assertRoutingReceiptMatchesIntent: () => assertRoutingReceiptMatchesIntent,
  forwardChatCompletion: () => forwardChatCompletion,
  isBearerAttachmentAllowed: () => isBearerAttachmentAllowed,
  rejectRedirectResponse: () => rejectRedirectResponse,
  resolveMetaProxyClientConfig: () => resolveMetaProxyClientConfig
});
module.exports = __toCommonJS(meta_proxy_exports);

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

// src/agentic/receipt-verification.ts
var import_node_crypto2 = require("crypto");

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

// src/meta-proxy/auth.ts
var import_node_crypto3 = require("crypto");
var PRODUCT2 = "meta-proxy";
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
    { product: PRODUCT2 }
  );
}
function fingerprintOf(token) {
  return (0, import_node_crypto3.createHash)("sha256").update(`${PRODUCT2}:${token}`).digest("hex").slice(0, 16);
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
    return `local-bearer-token:${PRODUCT2}:${this.#fingerprint}`;
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
        { product: PRODUCT2, operation: request.operation }
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
      product: PRODUCT2,
      normalizedOrigin: this.#normalizedOrigin,
      audience: this.#audience
    };
  }
  /** Fail-closed match check (ADR-0022 §D1/§D3). Exact string equality only. */
  assertMatch(request) {
    if (request.product !== PRODUCT2) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} is bound to product "${PRODUCT2}", refusing request for product "${request.product}"`,
        { product: PRODUCT2, operation: request.operation }
      );
    }
    if (request.normalizedOrigin !== this.#normalizedOrigin) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} is bound to origin "${this.#normalizedOrigin}", refusing request for origin "${request.normalizedOrigin}" (ADR-0022 \xA7D3: a redirect to another origin is not followed with credentials)`,
        { product: PRODUCT2, operation: request.operation }
      );
    }
    if (request.audience !== this.#audience) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} is bound to audience "${this.#audience}", refusing request for audience "${request.audience}"`,
        { product: PRODUCT2, operation: request.operation }
      );
    }
  }
};

// src/meta-proxy/http-errors.ts
var PRODUCT3 = "meta-proxy";
function nonEmpty(value, fallback) {
  return value.length > 0 ? value : fallback;
}
async function mapMetaProxyHttpError(response, operation, requestId) {
  const status = response.status;
  const bodyText = await response.text().catch(() => "");
  const fields = { product: PRODUCT3, operation, status, requestId };
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
var PRODUCT4 = "meta-proxy";
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
    { product: PRODUCT4, operation, status: response.status, requestId, retryable: false }
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
      { product: PRODUCT4, operation: OPERATION, retryable: false }
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
      { product: PRODUCT4, operation: OPERATION, retryable: false }
    );
  }
  return provider.acquire({
    product: PRODUCT4,
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
      product: PRODUCT4,
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
  const { forwarded, idempotencyKey: callerKey } = filterForwardHeaders(options?.forwardHeaders);
  const idempotencyKey = callerKey ?? newIdempotencyKey();
  let credential = await requireCredential(deps);
  const retryPolicy = DEFAULT_RETRY_POLICY;
  let attempt = 0;
  let sleepBudgetUsedMs = 0;
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
        continue;
      }
      throw err;
    }
    assertRoutingReceiptMatchesIntent(options?.routingIntent, result.meta.routingReceipt);
    return result;
  }
}

// src/meta-proxy/client.ts
var PRODUCT5 = "meta-proxy";
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
      product: PRODUCT5,
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
    completions: (request, options) => forwardChatCompletion(this.forwardingDeps(), request, options)
  };
  /** Assemble the `./forwarding.js` dependency bag from resolved config. */
  forwardingDeps() {
    return {
      origin: this.config.origin,
      transport: this.config.transport ?? fetch,
      credentialProvider: this.config.localCredentialProvider,
      allowNonLoopback: this.config.allowNonLoopback,
      defaultRequestContext: this.config.defaultRequestContext,
      telemetry: this.config.telemetry
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
      product: PRODUCT5,
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
        { product: PRODUCT5, retryable: false }
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
        product: PRODUCT5,
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
        { product: PRODUCT5, operation, requestId, retryable: false }
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
        product: PRODUCT5,
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_META_PROXY_ORIGIN,
  DEFAULT_META_PROXY_TOKEN_ENV_VAR,
  LocalBearerTokenCredentialProvider,
  MetaProxyClient,
  PROXY_CHAT_FORWARD_HEADER_ALLOWLIST,
  __resetMetaProxyNonLoopbackWarnLatch,
  assertRoutingReceiptMatchesIntent,
  forwardChatCompletion,
  isBearerAttachmentAllowed,
  rejectRedirectResponse,
  resolveMetaProxyClientConfig
});
//# sourceMappingURL=index.cjs.map