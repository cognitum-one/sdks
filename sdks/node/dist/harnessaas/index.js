// src/harnessaas/config.ts
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
    `[cognitum-sdk/harnessaas] HTTP (non-TLS) transport is ENABLED via allowInsecureHttp for loopback baseUrl "${baseUrl}". Never use this in production \u2014 see ADR-0022 \xA7D3.`
  );
}
function resolveHarnessaaSClientConfig(config) {
  if (!config.baseUrl) {
    throw new TypeError("HarnessaaSClientConfig.baseUrl is required");
  }
  let end = config.baseUrl.length;
  while (end > 0 && config.baseUrl.charCodeAt(end - 1) === 47) end--;
  const trimmed = config.baseUrl.slice(0, end);
  const isHttps = /^https:\/\//i.test(trimmed);
  if (!isHttps) {
    if (!config.allowInsecureHttp) {
      throw new TypeError(
        `HarnessaaSClientConfig.baseUrl must be an explicit HTTPS origin (ADR-0027a); got "${config.baseUrl}". Set allowInsecureHttp: true for local development only.`
      );
    }
    const host = extractHost(trimmed);
    if (!host || !isLoopbackHost(host)) {
      throw new TypeError(
        `HarnessaaSClientConfig.allowInsecureHttp is only permitted for literal IPv4/IPv6 loopback base URLs (ADR-0022 \xA7D3); got "${config.baseUrl}". Hostname resolution to loopback (e.g. "localhost") is insufficient.`
      );
    }
    warnInsecureHttpOnce(trimmed);
  }
  return { ...config, baseUrl: trimmed };
}

// src/harnessaas/discovery.ts
function parseHarnessaaSHealth(value) {
  const raw = value ?? {};
  const known = /* @__PURE__ */ new Set([
    "status",
    "mode",
    "backend",
    "tenancy",
    "store_backend",
    "lineageChainOk"
  ]);
  const rest = {};
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) rest[key] = raw[key];
  }
  return {
    status: String(raw.status ?? "unknown"),
    mode: typeof raw.mode === "string" ? raw.mode : void 0,
    backend: typeof raw.backend === "string" ? raw.backend : void 0,
    tenancy: typeof raw.tenancy === "string" ? raw.tenancy : void 0,
    storeBackend: typeof raw.store_backend === "string" ? raw.store_backend : void 0,
    lineageChainOk: typeof raw.lineageChainOk === "boolean" ? raw.lineageChainOk : void 0,
    raw: Object.keys(rest).length > 0 ? rest : void 0
  };
}

// src/harnessaas/types.ts
function toSolveRequestWire(request) {
  const wire = {
    repo: request.repo,
    test_command: request.testCommand,
    issue: request.issue
  };
  if (request.w !== void 0) wire.w = request.w;
  if (request.vertical !== void 0) wire.vertical = request.vertical;
  return wire;
}
function parseCostReceipt(value) {
  const raw = value ?? {};
  const known = /* @__PURE__ */ new Set([
    "request_id",
    "model",
    "mode",
    "tokens_in",
    "tokens_out",
    "cost_usd",
    "route",
    "escalated",
    "ledger_refs",
    "cache_hits",
    "cached_read_tokens",
    "batched"
  ]);
  const rest = {};
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) rest[key] = raw[key];
  }
  return {
    requestId: String(raw.request_id ?? ""),
    model: String(raw.model ?? ""),
    mode: String(raw.mode ?? ""),
    tokensIn: Number(raw.tokens_in ?? 0),
    tokensOut: Number(raw.tokens_out ?? 0),
    costUsd: Number(raw.cost_usd ?? 0),
    route: String(raw.route ?? ""),
    escalated: Boolean(raw.escalated),
    ledgerRefs: Array.isArray(raw.ledger_refs) ? raw.ledger_refs : void 0,
    cacheHits: typeof raw.cache_hits === "number" ? raw.cache_hits : void 0,
    cachedReadTokens: typeof raw.cached_read_tokens === "number" ? raw.cached_read_tokens : void 0,
    batched: typeof raw.batched === "number" ? raw.batched : void 0,
    raw: Object.keys(rest).length > 0 ? rest : void 0
  };
}
function parseConformanceAttestation(value) {
  const raw = value ?? {};
  return {
    usedOracleDuringSolve: false,
    statement: String(raw.statement ?? ""),
    visibleInputsDigest: String(raw.visibleInputsDigest ?? raw.visible_inputs_digest ?? "")
  };
}
function parseSolveResponse(value) {
  const raw = value ?? {};
  return {
    requestId: String(raw.request_id ?? ""),
    patch: String(raw.patch ?? ""),
    resolved: Boolean(raw.resolved),
    costReceipt: parseCostReceipt(raw.cost_receipt),
    lineageRef: String(raw.lineage_ref ?? ""),
    conformance: parseConformanceAttestation(raw.conformance)
  };
}
function parseLineageRecord(value) {
  const raw = value ?? {};
  const known = /* @__PURE__ */ new Set(["request_id", "account_id", "ts", "prev_hash", "hash"]);
  const rest = {};
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) rest[key] = raw[key];
  }
  return {
    requestId: String(raw.request_id ?? ""),
    accountId: typeof raw.account_id === "string" ? raw.account_id : void 0,
    ts: String(raw.ts ?? ""),
    prevHash: String(raw.prev_hash ?? ""),
    hash: String(raw.hash ?? ""),
    raw: rest
  };
}
function parseLineageResult(value) {
  const raw = value ?? {};
  const records = Array.isArray(raw.records) ? raw.records.map(parseLineageRecord) : [];
  return {
    requestId: String(raw.request_id ?? ""),
    records
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
  /**
   * Server-supplied upgrade affordance. Set only for `upgrade_required`.
   *
   * Kept on the base shape rather than a subclass so the three SDKs expose
   * one field name apiece — Rust has no subclassing, and a caller reading
   * `error.upgrade` in Node, Python and Rust alike is the point.
   *
   * SUBJECT TO THE SAME REDACTION OBLIGATION as `message`/`details`/`cause`:
   * every value here is server-supplied. `upgradeUrl` in particular may carry
   * a tenant-scoped or pre-signed link, which ADR-0028 §D10 classes as never
   * capturable. Redact before logging or forwarding.
   */
  upgrade;
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
    this.upgrade = fields?.upgrade;
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

// src/agentic/retry-after.ts
var MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1e3;

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

// src/agentic/oauth-token-provider.ts
import { createHash as createHash2, randomBytes } from "crypto";

// src/agentic/telemetry-metrics.ts
var METRIC_REQUEST_DURATION = "request.duration";
var METRIC_STREAM_DURATION = "stream.duration";
var METRIC_REQUEST_COUNT = "request.count";
var METRIC_RETRY_COUNT = "retry.count";
var METRIC_ERROR_COUNT = "error.count";
var METRIC_CANCELLATION_COUNT = "cancellation.count";
var METRIC_FIRST_EVENT_LATENCY = "stream.first_event.latency";
var METRIC_INPUT_TOKEN_COUNT = "token.input.count";
var METRIC_OUTPUT_TOKEN_COUNT = "token.output.count";
var METRIC_CACHE_TOKEN_COUNT = "token.cache.count";
var METRIC_SAFETY_TOKEN_COUNT = "token.safety.count";
var METRIC_COST_RESERVED = "cost.reserved";
var METRIC_COST_COMMITTED = "cost.committed";
var METRIC_COST_RELEASED = "cost.released";
var METRIC_COST_RECONCILED = "cost.reconciled";
var METRIC_OPERATION_STATE_TRANSITION_COUNT = "operation.state_transition.count";
var METRIC_PROCESS_EXIT_COUNT = "process.exit.count";
var METRIC_PROCESS_FORCED_TERMINATION_COUNT = "process.forced_termination.count";
var METRIC_VERIFICATION_RESULT_COUNT = "verification.result.count";
var MEASUREMENT_KIND_BY_INSTRUMENT = {
  [METRIC_REQUEST_DURATION]: "histogram",
  [METRIC_STREAM_DURATION]: "histogram",
  [METRIC_REQUEST_COUNT]: "counter",
  [METRIC_RETRY_COUNT]: "counter",
  [METRIC_ERROR_COUNT]: "counter",
  [METRIC_CANCELLATION_COUNT]: "counter",
  [METRIC_FIRST_EVENT_LATENCY]: "histogram",
  [METRIC_INPUT_TOKEN_COUNT]: "counter",
  [METRIC_OUTPUT_TOKEN_COUNT]: "counter",
  [METRIC_CACHE_TOKEN_COUNT]: "counter",
  [METRIC_SAFETY_TOKEN_COUNT]: "counter",
  [METRIC_COST_RESERVED]: "counter",
  [METRIC_COST_COMMITTED]: "counter",
  [METRIC_COST_RELEASED]: "counter",
  [METRIC_COST_RECONCILED]: "counter",
  [METRIC_OPERATION_STATE_TRANSITION_COUNT]: "counter",
  [METRIC_PROCESS_EXIT_COUNT]: "counter",
  [METRIC_PROCESS_FORCED_TERMINATION_COUNT]: "counter",
  [METRIC_VERIFICATION_RESULT_COUNT]: "counter"
};

// src/agentic/trace-context.ts
import { randomBytes as randomBytes2 } from "crypto";

// src/agentic/receipt-verification.ts
import { createHash as createHash3, createHmac, timingSafeEqual } from "crypto";

// src/harnessaas/http-errors.ts
var PRODUCT = "harnessaas";
function nonEmpty(value, fallback) {
  return value.length > 0 ? value : fallback;
}
async function mapHarnessaaSHttpError(response, operation, requestId) {
  const status = response.status;
  const bodyText = await response.text().catch(() => "");
  const fields = { product: PRODUCT, operation, status, requestId };
  switch (status) {
    case 400:
      return new AgenticError("validation", nonEmpty(bodyText, "invalid request"), {
        ...fields,
        retryable: false
      });
    // Opaque anti-enumeration auth failure (`src/auth.ts`) — never retried.
    case 401:
      return new AgenticError("authentication", nonEmpty(bodyText, "authentication failed"), {
        ...fields,
        retryable: false
      });
    // Insufficient scope (`insufficient_scope`/`scope_required`) or egress denial.
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
    // The inbound safety pre-flight refused the request before any spend
    // (`PiiBlockedError`) — a genuine content-of-request rejection, never retried.
    case 422:
      return new AgenticError(
        "safety_blocked",
        nonEmpty(bodyText, "request blocked by PII/safety pre-flight"),
        { ...fields, retryable: false }
      );
    // No in-app rate limiter or explicit 5xx emission was found in
    // `harnessaas`'s own route code — these statuses, if seen, come from
    // infrastructure in front of the app. Classified `retryable: true` here
    // for forward compatibility ONLY; `solve()` never acts on this (see
    // `client.ts`'s doc comment on why solve is single-attempt).
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
    // An uncaught exception (`src/server.ts`'s catch-all `json(res, 500, ...)`).
    case 500:
      return new AgenticError("protocol", nonEmpty(bodyText, "internal server error"), {
        ...fields,
        retryable: false
      });
    default:
      return new AgenticError("protocol", nonEmpty(bodyText, `unexpected status ${status}`), {
        ...fields,
        retryable: false
      });
  }
}

// src/harnessaas/client.ts
var PRODUCT2 = "harnessaas";
var DEFAULT_CAPABILITY_VERSION = "0.0.0";
var DEFAULT_VERTICAL = "code-repair";
var SOLVE_FEATURE = "solve";
var LINEAGE_FEATURE = "lineage";
function solveVerticalFeature(vertical) {
  return `solve.vertical.${vertical}`;
}
var DEFAULT_CAPABILITY_SNAPSHOT = {
  product: PRODUCT2,
  productVersion: DEFAULT_CAPABILITY_VERSION,
  protocol: "cognitum.harnessaas.http",
  protocolVersion: "1.0",
  features: {
    [SOLVE_FEATURE]: true,
    [LINEAGE_FEATURE]: true,
    [solveVerticalFeature("code-repair")]: true,
    [solveVerticalFeature("security-remediation")]: false,
    [solveVerticalFeature("dependency-migration")]: false,
    [solveVerticalFeature("test-generation")]: false
  },
  limitations: [
    "solve() is verified only for the code-repair vertical; security-remediation, dependency-migration, and test-generation each require a compound request field (finding/scanner_command, migration/build_command, test_generation/coverage_command respectively) this SDK pass does not model, so those verticals are not locally supported even though the server may accept them"
  ],
  authMethods: ["X-API-Key", "Authorization: Bearer"],
  source: "static-compatibility-table"
};
function newRequestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
var HarnessaaSClient = class {
  config;
  constructor(config) {
    this.config = resolveHarnessaaSClientConfig(config);
  }
  /** Read-only view of the effective configuration. */
  getConfig() {
    return this.config;
  }
  /**
   * Versioned behavior safe for this caller, from the static compatibility
   * snapshot (no I/O — no runtime capabilities endpoint is published for
   * HarnessaaS yet). Unknown server versions receive the intersection of
   * proven-safe capabilities, never the union (ADR-0019 §D6).
   */
  capabilities() {
    return this.config.capabilitiesSnapshot ?? DEFAULT_CAPABILITY_SNAPSHOT;
  }
  /**
   * Fail closed BEFORE any HTTP call if the resolved capability set (an
   * operator-supplied `capabilitiesSnapshot`, or this SDK's own
   * known-tested default) does not affirmatively mark `solve` and the
   * requested `vertical` as supported (ADR-0019 §D6). `solve()` is
   * simultaneously a mutation, a spend trigger, and — given HarnessaaS's
   * untrusted-repository/command-execution trust boundary — a
   * code-execution trigger, so an unknown or unsupported capability MUST
   * be rejected locally rather than reaching the network.
   */
  assertSolveCapability(vertical) {
    const caps = this.capabilities();
    if (caps.features[SOLVE_FEATURE] !== true) {
      throw new UnsupportedCapabilityError(
        PRODUCT2,
        "solve",
        SOLVE_FEATURE,
        `HarnessaaSClient.solve is unsupported or unknown for the resolved capability set (product_version "${caps.productVersion}"). Refusing to call POST /solve \u2014 a mutating, billable, code-execution-triggering operation \u2014 before verifying support (ADR-0019 \xA7D6).`
      );
    }
    const verticalFeature = solveVerticalFeature(vertical);
    if (caps.features[verticalFeature] !== true) {
      throw new UnsupportedCapabilityError(
        PRODUCT2,
        "solve",
        verticalFeature,
        `HarnessaaSClient.solve vertical "${vertical}" is unsupported or unknown for the resolved capability set (product_version "${caps.productVersion}"). Only the "code-repair" vertical is modeled/verified by this SDK pass; refusing to send an incomplete request for a vertical whose compound fields this client does not serialize, before any spend or code execution occurs (ADR-0019 \xA7D6).`
      );
    }
  }
  /**
   * `GET /health` — process health only, no identity/readiness semantics.
   * Unauthenticated on the real service (`src/server.ts:293-303` never
   * calls `authenticate()` for this route) — never acquires a credential,
   * even when one is configured. Single HTTP attempt, no retry loop,
   * matching `MetaLlmClient.health()`.
   *
   * Calls `GET /health`, NOT `/healthz` — see `./discovery.js`'s module
   * doc comment for why `/healthz` is unreliable from outside the container
   * on Cloud Run.
   */
  async health(options) {
    const { data, meta } = await this.sendGetOnce("/health", "health", void 0, options);
    return { data: parseHarnessaaSHealth(data), meta };
  }
  /**
   * `POST /solve` — genuinely synchronous: one HTTP request, one full
   * `SolveResponse` back inline. See this module's doc comment for why this
   * makes exactly one HTTP attempt for every outcome except a verified 401
   * (safe to refresh-and-retry once, since auth is checked before any
   * spend) — 429/502/503/5xx/transport failures are NEVER retried
   * automatically.
   *
   * This pass does not perform local ADR-0022 §D5 scope preflight: unlike
   * Meta LLM/Meta Proxy's single required-scope-string convention, the real
   * server-side authorization is a tier-ladder CAP over multiple
   * alternative scopes (any of `completions:low`/`mid`/`high` lets a solve
   * proceed, just at a capped tier — `src/auth.ts`'s `authorizeGenome`),
   * which this client does not replicate client-side. The server remains
   * authoritative; a 403 (`insufficient_scope` or, for
   * `vertical: "security-remediation"`, `scope_required`) surfaces as a
   * `permission_denied` `AgenticError` — see `./http-errors.js`.
   */
  async solve(request, options) {
    this.assertSolveCapability(request.vertical ?? DEFAULT_VERTICAL);
    const body = toSolveRequestWire(request);
    let credential = await this.requireCredential("solve");
    let refreshedOnce = false;
    for (; ; ) {
      try {
        const { data, meta } = await this.sendPostOnce("/solve", "solve", body, credential, options);
        return { data: parseSolveResponse(data), meta };
      } catch (cause) {
        const err = cause;
        if (err.status === 401 && !refreshedOnce) {
          refreshedOnce = true;
          await this.config.credentialProvider?.invalidate("401 challenge from harnessaas");
          credential = await this.requireCredential("solve");
          continue;
        }
        throw err;
      }
    }
  }
  /**
   * `GET /lineage/:id` — a safe read (ADR-0023 §D3), so bounded 429/502/503
   * retry is appropriate here, unlike `solve()`. A `request_id` from
   * another tenant collapses to the same 404 as an absent one
   * (`src/server.ts`'s cross-tenant deny — anti-enumeration), matching
   * ADR-0019 §D6's "foreign resources map to the same `NotFoundError` as
   * absent resources."
   */
  async lineage(requestId, options) {
    if (!requestId) {
      throw new AgenticError("validation", "lineage requestId is required", {
        product: PRODUCT2,
        operation: "lineage",
        retryable: false
      });
    }
    if (this.capabilities().features[LINEAGE_FEATURE] !== true) {
      throw new UnsupportedCapabilityError(
        PRODUCT2,
        "lineage",
        LINEAGE_FEATURE,
        `HarnessaaSClient.lineage is unsupported or unknown for the resolved capability set (product_version "${this.capabilities().productVersion}").`
      );
    }
    const path = `/lineage/${encodeURIComponent(requestId)}`;
    let credential = await this.requireCredential("lineage");
    let refreshedOnce = false;
    const retryPolicy = DEFAULT_RETRY_POLICY;
    let attempt = 0;
    let sleepBudgetUsedMs = 0;
    for (; ; ) {
      try {
        const { data, meta } = await this.sendGetOnce(path, "lineage", credential, options);
        return { data: parseLineageResult(data), meta };
      } catch (cause) {
        const err = cause;
        if (err.status === 401 && !refreshedOnce) {
          refreshedOnce = true;
          await this.config.credentialProvider?.invalidate("401 challenge from harnessaas");
          credential = await this.requireCredential("lineage");
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
  /**
   * Close local connections and wait only. Never cancels a remote solve
   * (there is no remote job to cancel — `POST /solve` has already returned
   * by the time this client hands back a result).
   */
  async close() {
  }
  // ---------------------------------------------------------------------
  // Internal HTTP glue
  // ---------------------------------------------------------------------
  async requireCredential(operation) {
    const provider = this.config.credentialProvider;
    if (!provider) {
      throw new AgenticError(
        "authentication",
        `HarnessaaSClient.${operation} requires a credentialProvider`,
        { product: PRODUCT2, operation, retryable: false }
      );
    }
    return provider.acquire({
      product: PRODUCT2,
      normalizedOrigin: this.config.baseUrl,
      audience: this.config.baseUrl,
      // No single required-scope string — see `solve()`'s doc comment.
      requiredScopes: [],
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
  /** One GET attempt. Never retries by itself — callers own that (see `lineage()`/`health()`). */
  async sendGetOnce(path, operation, credential, options) {
    const requestId = options?.requestContext?.requestId ?? this.config.defaultRequestContext?.requestId ?? newRequestId();
    this.config.telemetry?.onRequestStart?.({ operation, requestId });
    const startedAt = Date.now();
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
    this.config.telemetry?.onRequestEnd?.({
      operation,
      requestId,
      httpStatus: response.status,
      durationMs,
      retryAfterMs
    });
    if (!response.ok) {
      const err = await mapHarnessaaSHttpError(response, operation, requestId);
      if (err.retryAfterMs === void 0 && retryAfterMs !== void 0) {
        err.retryAfterMs = retryAfterMs;
      }
      throw err;
    }
    const data = await response.json();
    const meta = {
      requestId: response.headers.get("x-cognitum-request-id") ?? requestId,
      httpStatus: response.status,
      retryAfterMs
    };
    return { data, meta };
  }
  /** One POST attempt. Never retries by itself — the caller (`solve()`) owns that. */
  async sendPostOnce(path, operation, body, credential, options) {
    const requestId = options?.requestContext?.requestId ?? this.config.defaultRequestContext?.requestId ?? newRequestId();
    this.config.telemetry?.onRequestStart?.({ operation, requestId });
    const startedAt = Date.now();
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Cognitum-Request-Id": requestId
    };
    this.applyAuth(headers, credential);
    const transport = this.config.transport ?? fetch;
    const url = `${this.config.baseUrl}${path}`;
    let response;
    try {
      response = await transport(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      });
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
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1e3 : void 0;
    this.config.telemetry?.onRequestEnd?.({
      operation,
      requestId,
      httpStatus: response.status,
      durationMs,
      retryAfterMs
    });
    if (!response.ok) {
      const err = await mapHarnessaaSHttpError(response, operation, requestId);
      if (err.retryAfterMs === void 0 && retryAfterMs !== void 0) {
        err.retryAfterMs = retryAfterMs;
      }
      throw err;
    }
    const data = await response.json();
    const meta = {
      requestId: response.headers.get("x-cognitum-request-id") ?? requestId,
      httpStatus: response.status,
      retryAfterMs
    };
    return { data, meta };
  }
};
export {
  HarnessaaSClient,
  mapHarnessaaSHttpError,
  parseConformanceAttestation,
  parseCostReceipt,
  parseHarnessaaSHealth,
  parseLineageResult,
  parseSolveResponse,
  resolveHarnessaaSClientConfig,
  toSolveRequestWire
};
//# sourceMappingURL=index.js.map