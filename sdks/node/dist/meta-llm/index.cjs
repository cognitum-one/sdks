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
  MetaLlmClient: () => MetaLlmClient,
  resolveMetaLlmClientConfig: () => resolveMetaLlmClientConfig
});
module.exports = __toCommonJS(meta_llm_exports);

// src/meta-llm/config.ts
function resolveMetaLlmClientConfig(config) {
  if (!config.baseUrl) {
    throw new TypeError("MetaLlmClientConfig.baseUrl is required");
  }
  const trimmed = config.baseUrl.replace(/\/+$/, "");
  const isHttps = /^https:\/\//i.test(trimmed);
  if (!isHttps && !config.allowInsecureHttp) {
    throw new TypeError(
      `MetaLlmClientConfig.baseUrl must be an explicit HTTPS origin (ADR-0024a \xA7D1); got "${config.baseUrl}". Set allowInsecureHttp: true for local development only.`
    );
  }
  return { ...config, baseUrl: trimmed };
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
var import_node_crypto = require("crypto");

// src/agentic/receipt-verification.ts
var import_node_crypto2 = require("crypto");

// src/meta-llm/client.ts
var DEFAULT_CAPABILITY_VERSION = "0.0.0";
var PRODUCT = "meta-llm";
function newRequestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
function notImplemented(operation) {
  return Promise.reject(
    new AgenticError(
      "unsupported_capability",
      `MetaLlmClient.${operation} is not implemented yet (ADR-0024a \xA7D2/\xA7D3 wire types only landed in issue #58 / M2 \u2014 HTTP logic is a follow-up issue)`,
      { product: PRODUCT, operation, retryable: false }
    )
  );
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
   * Versioned behavior safe for this caller, from the static compatibility
   * snapshot (no I/O — ADR-0024a §D9 gate #3 is not yet published). Unknown
   * server versions receive the intersection of proven-safe capabilities,
   * never the union (ADR-0019 §D6).
   */
  capabilities() {
    return this.config.capabilitiesSnapshot ?? {
      product: PRODUCT,
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
      { product: PRODUCT, operation: "ready", retryable: false }
    );
  }
  // ---------------------------------------------------------------------
  // D3: protocol-specific wire types only this pass — placeholders below
  // ---------------------------------------------------------------------
  chat = {
    completions: (_request, _options) => notImplemented("chat.completions")
  };
  completions(_request, _options) {
    return notImplemented("completions");
  }
  messages = {
    create: (_request, _options) => notImplemented("messages.create"),
    countTokens: (_request, _options) => notImplemented("messages.countTokens")
  };
  responses(_request, _options) {
    return notImplemented("responses");
  }
  embeddings(_request, _options) {
    return notImplemented("embeddings");
  }
  /**
   * Close local connections and wait only. Never cancels a remote
   * operation, stops a pod, releases a reservation, or revokes a
   * credential (ADR-0024a §D1).
   */
  async close() {
  }
  // ---------------------------------------------------------------------
  // Internal HTTP glue shared by health/whoami/models
  // ---------------------------------------------------------------------
  async resolveCredential(operation, requiredScopes) {
    const provider = this.config.credentialProvider;
    if (!provider) return void 0;
    return provider.acquire({
      product: PRODUCT,
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
    const requestId = options?.requestContext?.requestId ?? this.config.defaultRequestContext?.requestId ?? newRequestId();
    this.config.telemetry?.onRequestStart?.({ operation, requestId });
    const startedAt = Date.now();
    const credential = await this.resolveCredential(operation, ["meta-llm.read"]).catch(
      (cause) => {
        if (opts.requireCredential) {
          throw new AgenticError("authentication", `failed to acquire credential: ${cause}`, {
            product: PRODUCT,
            operation,
            requestId,
            retryable: false,
            cause
          });
        }
        return void 0;
      }
    );
    if (opts.requireCredential && !credential) {
      throw new AgenticError(
        "authentication",
        `MetaLlmClient.${operation} requires a credential_provider`,
        { product: PRODUCT, operation, requestId, retryable: false }
      );
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
        product: PRODUCT,
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
      throw await this.mapHttpError(response, operation, requestId);
    }
    const data = await response.json();
    const meta = {
      requestId: response.headers.get("x-cognitum-request-id") ?? requestId,
      httpStatus: response.status,
      protocolVersion: response.headers.get("x-cognitum-protocol-version") ?? void 0
    };
    return { data, meta };
  }
  async mapHttpError(response, operation, requestId) {
    const status = response.status;
    const bodyText = await response.text().catch(() => "");
    const fields = { product: PRODUCT, operation, status, requestId };
    switch (status) {
      case 401:
        return new AgenticError("authentication", bodyText || "authentication failed", {
          ...fields,
          retryable: false
        });
      case 403:
        return new AgenticError("permission_denied", bodyText || "permission denied", {
          ...fields,
          retryable: false
        });
      case 404:
        return new AgenticError("not_found", bodyText || "not found", {
          ...fields,
          retryable: false
        });
      case 429: {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1e3 : void 0;
        return new AgenticError("rate_limited", bodyText || "rate limited", {
          ...fields,
          retryable: true,
          retryAfterMs
        });
      }
      case 502:
      case 503:
        return new AgenticError("transport", bodyText || `upstream error ${status}`, {
          ...fields,
          retryable: true
        });
      default:
        return new AgenticError("protocol", bodyText || `unexpected status ${status}`, {
          ...fields,
          retryable: false
        });
    }
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MetaLlmClient,
  resolveMetaLlmClientConfig
});
//# sourceMappingURL=index.cjs.map