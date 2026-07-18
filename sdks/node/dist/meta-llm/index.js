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
import { createHash } from "crypto";

// src/agentic/receipt-verification.ts
import { createHash as createHash2, createHmac, timingSafeEqual } from "crypto";
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
  return createHash2("sha256").update(bytes, "utf8").digest("hex");
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
  return provider.acquire({
    product: PRODUCT2,
    normalizedOrigin: deps.baseUrl,
    audience: deps.baseUrl,
    requiredScopes: [INFERENCE_SCOPE],
    operation,
    interactiveAllowed: false
  });
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
  const data = await response.json();
  const meta = {
    requestId: response.headers.get("x-cognitum-request-id") ?? requestId,
    httpStatus: response.status,
    protocolVersion: response.headers.get("x-cognitum-protocol-version") ?? void 0,
    retryAfterMs,
    idempotentReplay
  };
  return { data, meta };
}
async function postJsonIdempotent(deps, path, operation, body) {
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
        continue;
      }
      throw err;
    }
  }
}

// src/meta-llm/client.ts
var DEFAULT_CAPABILITY_VERSION = "0.0.0";
var PRODUCT3 = "meta-llm";
function newRequestId2() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
function notImplemented(operation) {
  return Promise.reject(
    new AgenticError(
      "unsupported_capability",
      `MetaLlmClient.${operation} is not implemented yet (ADR-0024a \xA7D2/\xA7D3 wire types only landed in issue #58 / M2 \u2014 HTTP logic is a follow-up issue)`,
      { product: PRODUCT3, operation, retryable: false }
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
      product: PRODUCT3,
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
      { product: PRODUCT3, operation: "ready", retryable: false }
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
    )
  };
  completions(_request, _options) {
    return notImplemented("completions");
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
      product: PRODUCT3,
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
          product: PRODUCT3,
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
          { product: PRODUCT3, operation, requestId, retryable: false }
        );
      }
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
        product: PRODUCT3,
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
export {
  MetaLlmClient,
  resolveMetaLlmClientConfig
};
//# sourceMappingURL=index.js.map