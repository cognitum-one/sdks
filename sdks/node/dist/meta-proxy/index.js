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

// src/meta-proxy/http-errors.ts
var PRODUCT = "meta-proxy";
function nonEmpty(value, fallback) {
  return value.length > 0 ? value : fallback;
}
async function mapMetaProxyHttpError(response, operation, requestId) {
  const status = response.status;
  const bodyText = await response.text().catch(() => "");
  const fields = { product: PRODUCT, operation, status, requestId };
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

// src/meta-proxy/client.ts
var PRODUCT2 = "meta-proxy";
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
function newRequestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
function pick(data, snake, camel) {
  return data[snake] ?? data[camel];
}
function parseStatus(data) {
  const raw = {};
  for (const [key, value] of Object.entries(data)) {
    if (!KNOWN_STATUS_KEYS.has(key)) raw[key] = value;
  }
  return {
    productVersion: String(pick(data, "product_version", "productVersion") ?? ""),
    protocolVersion: pick(data, "protocol_version", "protocolVersion"),
    compatibleSdkRange: pick(data, "compatible_sdk_range", "compatibleSdkRange"),
    processState: String(pick(data, "process_state", "processState") ?? "unknown"),
    bind: data.bind,
    configuredPlane: String(pick(data, "configured_plane", "configuredPlane") ?? ""),
    selectedPlane: String(pick(data, "selected_plane", "selectedPlane") ?? ""),
    routingReason: pick(data, "routing_reason", "routingReason"),
    automaticUsageState: pick(data, "automatic_usage_state", "automaticUsageState"),
    utilization: data.utilization,
    resetAt: pick(data, "reset_at", "resetAt"),
    workloadPolicy: pick(data, "workload_policy", "workloadPolicy"),
    sponsoredAvailable: pick(data, "sponsored_available", "sponsoredAvailable"),
    cloudCredentialSource: pick(data, "cloud_credential_source", "cloudCredentialSource"),
    limitations: data.limitations ?? [],
    requestId: String(pick(data, "request_id", "requestId") ?? ""),
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
      product: PRODUCT2,
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
      product: PRODUCT2,
      normalizedOrigin: this.config.origin,
      audience: this.config.origin,
      requiredScopes: ["meta-proxy.status"],
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
  async getJson(path, operation, options) {
    const requestId = options?.requestContext?.requestId ?? newRequestId();
    this.config.telemetry?.onRequestStart?.({ operation, requestId });
    const startedAt = Date.now();
    let credential;
    try {
      credential = await this.resolveCredential(operation);
    } catch (cause) {
      throw new AgenticError("authentication", `failed to acquire local credential: ${cause}`, {
        product: PRODUCT2,
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
        { product: PRODUCT2, operation, requestId, retryable: false }
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
      response = await transport(url, { method: "GET", headers });
    } catch (cause) {
      this.config.telemetry?.onRequestEnd?.({
        operation,
        requestId,
        durationMs: Date.now() - startedAt
      });
      throw new AgenticError("transport", `${operation} request failed: ${cause}`, {
        product: PRODUCT2,
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
  DEFAULT_META_PROXY_ORIGIN,
  MetaProxyClient,
  __resetMetaProxyNonLoopbackWarnLatch,
  resolveMetaProxyClientConfig
};
//# sourceMappingURL=index.js.map