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

// src/seed/index.ts
var seed_exports = {};
__export(seed_exports, {
  AuthError: () => AuthError,
  CognitumError: () => CognitumError,
  ConfigError: () => ConfigError,
  ConflictError: () => ConflictError,
  NetworkError: () => NetworkError,
  NotFoundError: () => NotFoundError,
  NotImplementedError: () => NotImplementedError,
  ParseError: () => ParseError,
  RateLimitError: () => RateLimitError,
  SeedClient: () => SeedClient,
  ServiceUnavailableError: () => ServiceUnavailableError,
  TimeoutError: () => TimeoutError,
  ValidationError: () => ValidationError
});
module.exports = __toCommonJS(seed_exports);

// src/errors.ts
var CognitumError = class extends Error {
  /** Machine-readable error code. */
  code;
  /** HTTP status code, if applicable. */
  statusCode;
  constructor(message, code, statusCode) {
    super(message);
    this.name = "CognitumError";
    this.code = code;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
var AuthError = class extends CognitumError {
  constructor(message = "Authentication failed") {
    super(message, "AUTH_ERROR", 401);
    this.name = "AuthError";
  }
};
var RateLimitError = class extends CognitumError {
  /** Milliseconds to wait before retrying, parsed from Retry-After header. */
  retryAfterMs;
  constructor(retryAfterMs = 1e3, message = "Rate limit exceeded") {
    super(message, "RATE_LIMIT", 429);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
};
var ValidationError = class extends CognitumError {
  constructor(message = "Validation failed") {
    super(message, "VALIDATION_ERROR", 400);
    this.name = "ValidationError";
  }
};
var NotFoundError = class extends CognitumError {
  constructor(message = "Resource not found") {
    super(message, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
};
var ConflictError = class extends CognitumError {
  constructor(message = "Conflict") {
    super(message, "CONFLICT", 409);
    this.name = "ConflictError";
  }
};
var NotImplementedError = class extends CognitumError {
  /** Path or feature that is not implemented. */
  endpoint;
  constructor(endpoint, message) {
    super(message ?? `Not implemented${endpoint ? `: ${endpoint}` : ""}`, "NOT_IMPLEMENTED", 501);
    this.name = "NotImplementedError";
    this.endpoint = endpoint;
  }
};
var ServiceUnavailableError = class extends CognitumError {
  /** Milliseconds to wait before retrying, if the server hinted. */
  retryAfterMs;
  constructor(retryAfterMs, message = "Service unavailable") {
    super(message, "UNAVAILABLE", 503);
    this.name = "ServiceUnavailableError";
    this.retryAfterMs = retryAfterMs;
  }
};
var NetworkError = class extends CognitumError {
  constructor(message = "Network error", cause) {
    super(message, "NETWORK_ERROR");
    this.name = "NetworkError";
    if (cause !== void 0) {
      this.cause = cause;
    }
  }
};
var TimeoutError = class extends CognitumError {
  /** Which phase of the request timed out. */
  phase;
  constructor(phase = "total", message) {
    super(message ?? `Request timed out (phase=${phase})`, "TIMEOUT");
    this.name = "TimeoutError";
    this.phase = phase;
  }
};
var ParseError = class extends CognitumError {
  expected;
  constructor(expected, message) {
    super(message ?? `Failed to parse response${expected ? ` (expected ${expected})` : ""}`, "PARSE_ERROR");
    this.name = "ParseError";
    this.expected = expected;
  }
};
var ConfigError = class extends CognitumError {
  constructor(message = "Invalid configuration") {
    super(message, "CONFIG_ERROR");
    this.name = "ConfigError";
  }
};

// src/seed/config.ts
var PHASE_1_5_MSG = "mesh mode (multiple endpoints) lands in Phase 1.5 \u2014 track issue #TBD";
function resolveSeedConfig(opts) {
  if (!opts || typeof opts !== "object") {
    throw new ConfigError("SeedClient options are required");
  }
  if (opts.endpoints === void 0 || opts.endpoints === null) {
    throw new ConfigError("`endpoints` is required");
  }
  const endpointList = Array.isArray(opts.endpoints) ? opts.endpoints : [opts.endpoints];
  if (endpointList.length === 0) {
    throw new ConfigError("at least one endpoint is required");
  }
  if (endpointList.length > 1) {
    throw new ConfigError(PHASE_1_5_MSG);
  }
  const raw = endpointList[0];
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ConfigError("endpoint must be a non-empty URL string");
  }
  const baseUrl = normaliseBaseUrl(raw);
  let pairingToken;
  if (opts.auth?.pairingToken !== void 0) {
    if (typeof opts.auth.pairingToken === "string") {
      pairingToken = opts.auth.pairingToken;
    } else {
      throw new ConfigError(
        "TokenBook (per-peer pairing tokens) lands in Phase 1.5 \u2014 pass a string for now"
      );
    }
  } else if (typeof process !== "undefined" && process.env?.COGNITUM_SEED_TOKEN) {
    pairingToken = process.env.COGNITUM_SEED_TOKEN;
  }
  const routing = opts.routing ?? "pinned";
  if (routing !== "pinned") {
    throw new ConfigError(
      `routing="${routing}" lands in Phase 1.5 \u2014 only "pinned" is supported`
    );
  }
  const tls = {
    ca: opts.tls?.ca,
    insecure: Boolean(opts.tls?.insecure)
  };
  const timeouts = {
    connect: opts.timeouts?.connect ?? 5e3,
    read: opts.timeouts?.read ?? 3e4,
    total: opts.timeouts?.total ?? 6e4
  };
  const failover = {
    onConnectError: opts.failover?.onConnectError ?? "retry-same",
    onStatus5xx: opts.failover?.onStatus5xx ?? "retry-same"
  };
  return {
    baseUrl,
    pairingToken,
    apiKey: opts.auth?.apiKey,
    tls,
    routing,
    failover,
    timeouts,
    retries: opts.retries ?? 3,
    rateLimitRetry: opts.rateLimitRetry ?? true,
    fetchFn: opts.fetch ?? globalThis.fetch,
    logger: opts.logger ?? {}
  };
}
function normaliseBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`invalid endpoint URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(
      `endpoint must use http(s); got ${url.protocol}${url.host}`
    );
  }
  return url.toString().replace(/\/+$/, "");
}

// src/seed/peers.ts
function singlePeer(baseUrl, pairingToken) {
  return [
    {
      baseUrl,
      pairingToken,
      label: labelFor(baseUrl)
    }
  ];
}
function labelFor(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return url;
  }
}

// src/seed/transport.ts
var warnedInsecure = false;
function buildSeedFetch(cfg) {
  if (cfg.fetchFn !== globalThis.fetch) {
    return cfg.fetchFn;
  }
  const { insecure, ca } = cfg.tls;
  if (insecure && !warnedInsecure) {
    warnedInsecure = true;
    const warn = cfg.logger.warn ?? ((m) => console.warn(m));
    warn(
      "[cognitum-sdk/seed] TLS verification disabled (tls.insecure=true). Never use this in production \u2014 pair with a trustRoot CA instead."
    );
  }
  let dispatcher;
  let httpsAgent;
  let resolved = false;
  const ensureDispatcher = () => {
    if (resolved) return { dispatcher, agent: httpsAgent };
    resolved = true;
    try {
      const undici = require("undici");
      dispatcher = new undici.Agent({
        keepAliveTimeout: 1e4,
        connections: 16,
        allowH2: false,
        connect: {
          ca,
          rejectUnauthorized: !insecure
        }
      });
    } catch {
      try {
        const https = require("https");
        httpsAgent = new https.Agent({
          keepAlive: true,
          ca,
          rejectUnauthorized: !insecure
        });
      } catch {
      }
    }
    return { dispatcher, agent: httpsAgent };
  };
  return async (input, init) => {
    const { dispatcher: disp } = ensureDispatcher();
    const finalInit = {
      ...init ?? {}
    };
    if (disp !== void 0) {
      finalInit.dispatcher = disp;
    } else if (insecure) {
      const prior = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      try {
        return await globalThis.fetch(input, finalInit);
      } finally {
        if (prior === void 0) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prior;
      }
    }
    return globalThis.fetch(input, finalInit);
  };
}

// src/seed/retry.ts
var BASE_MS = 500;
var CAP_MS = 3e4;
var DEFAULT_MAX_ELAPSED_MS = 6e4;
async function runWithRetry(op, cfg, pathForLog) {
  const started = Date.now();
  let attempt = 0;
  for (; ; ) {
    try {
      return await op(attempt);
    } catch (err) {
      const elapsed = Date.now() - started;
      const { retriable, hintMs } = classify(err, cfg);
      const outOfBudget = attempt >= cfg.retries || elapsed >= cfg.maxElapsedMs;
      if (!retriable || outOfBudget) throw err;
      const expo = BASE_MS * 2 ** attempt;
      const jitter = Math.random() * BASE_MS;
      const computed = Math.min(CAP_MS, expo + jitter);
      const delay = Math.max(computed, hintMs ?? 0);
      const remaining = cfg.maxElapsedMs - elapsed;
      cfg.logger?.debug?.({
        attempt,
        next_delay_ms: Math.min(delay, remaining),
        reason: err.name,
        path: pathForLog
      });
      await sleep(Math.min(delay, Math.max(0, remaining)));
      attempt += 1;
    }
  }
}
function classify(err, cfg) {
  if (err instanceof RateLimitError) {
    return { retriable: cfg.rateLimitRetry, hintMs: err.retryAfterMs };
  }
  if (err instanceof ServiceUnavailableError) {
    return { retriable: true, hintMs: err.retryAfterMs };
  }
  if (err instanceof NetworkError) {
    return { retriable: true };
  }
  if (err instanceof TimeoutError) {
    if (err.phase === "connect") return { retriable: true };
    if (cfg.method.toUpperCase() === "POST" && !cfg.idempotent) {
      return { retriable: false };
    }
    return { retriable: true };
  }
  if (err instanceof CognitumError) {
    const sc = err.statusCode;
    if (sc !== void 0 && sc >= 500 && sc !== 501) {
      return { retriable: true };
    }
  }
  if (err instanceof AuthError || err instanceof ValidationError || err instanceof NotFoundError || err instanceof ConflictError || err instanceof NotImplementedError || err instanceof ParseError) {
    return { retriable: false };
  }
  return { retriable: false };
}
function parseRetryAfterHeader(h) {
  if (!h) return void 0;
  const secs = Number(h);
  if (!Number.isNaN(secs) && secs >= 0) return Math.round(secs * 1e3);
  const date = Date.parse(h);
  if (!Number.isNaN(date)) return Math.max(date - Date.now(), 0);
  return void 0;
}
function parseSeedRetryAfter(body) {
  if (typeof body !== "object" || body === null) return void 0;
  const rec = body;
  if (typeof rec.retry_after_us === "number") {
    return Math.round(rec.retry_after_us / 1e3);
  }
  if (typeof rec.error === "string") {
    const m = /retry after (\d+)\s*s/i.exec(rec.error);
    if (m) return Number(m[1]) * 1e3;
  }
  return void 0;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

// src/seed/resources/status.ts
function makeStatusResource(request) {
  const fn = (() => request("GET", "/api/v1/status", {
    idempotent: true
  }));
  fn.get = fn;
  return fn;
}

// src/seed/resources/identity.ts
function makeIdentityResource(request) {
  const fn = (() => request("GET", "/api/v1/identity", {
    idempotent: true
  }));
  fn.get = fn;
  return fn;
}

// src/seed/resources/pair.ts
function makePairResource(request) {
  return {
    status: () => request("GET", "/api/v1/pair/status", { idempotent: true }),
    create: async (params) => {
      if (!params || typeof params.clientName !== "string" || !params.clientName.trim()) {
        throw new TypeError("pair.create: `clientName` is required");
      }
      return request("POST", "/api/v1/pair", {
        body: { client_name: params.clientName },
        idempotent: false
      });
    },
    delete: async (clientName) => {
      if (typeof clientName !== "string" || !clientName.trim()) {
        throw new TypeError("pair.delete: `clientName` is required");
      }
      await request("DELETE", `/api/v1/pair/${encodeURIComponent(clientName)}`, {
        idempotent: true
      });
    }
  };
}

// src/seed/resources/witness.ts
function makeWitnessResource(request) {
  return {
    chain: () => request("GET", "/api/v1/witness/chain", {
      idempotent: true
    })
  };
}

// src/seed/resources/custody.ts
function makeCustodyResource(request) {
  return {
    epoch: () => request("GET", "/api/v1/custody/epoch", {
      idempotent: true
    })
  };
}

// src/seed/resources/store.ts
function makeStoreResource(request) {
  return {
    status: () => request("GET", "/api/v1/store/status", {
      idempotent: true
    }),
    query: (params) => {
      if (!params || !Array.isArray(params.vector) || typeof params.k !== "number") {
        throw new TypeError("store.query: { vector: number[], k: number } required");
      }
      return request("POST", "/api/v1/store/query", {
        body: {
          vector: params.vector,
          k: params.k,
          ...params.metric ? { metric: params.metric } : {}
        },
        idempotent: true
        // read-only query; safe to retry on timeout
      });
    },
    ingest: (params) => {
      if (!params || !Array.isArray(params.vectors) || params.vectors.length === 0) {
        throw new TypeError("store.ingest: { vectors: StoreIngestItem[] } required (non-empty)");
      }
      return request("POST", "/api/v1/store/ingest", {
        body: { vectors: params.vectors },
        idempotent: false
      });
    }
  };
}

// src/seed/resources/ota.ts
function makeOtaResource(request) {
  return {
    config: () => request("GET", "/api/v1/ota/config", {
      idempotent: true
    }),
    checkNow: () => request("POST", "/api/v1/ota/checkNow", {
      idempotent: true
      // the seed merely re-checks; no destructive effect
    })
  };
}

// src/seed/client.ts
var SeedClient = class {
  /** Resolved config (read-only snapshot). */
  config;
  /** GET /api/v1/status */
  status;
  /** GET /api/v1/identity */
  identity;
  /** Pairing — create / status / delete. */
  pair;
  /** GET /api/v1/witness/chain + related. */
  witness;
  /** GET /api/v1/custody/epoch. */
  custody;
  /** Vector store — status / query / ingest. */
  store;
  /** OTA — config + check-now. */
  ota;
  /** Peer list (always length 1 in Phase 1). */
  peers;
  /** TLS-aware fetch bound to this client. */
  fetchFn;
  constructor(options) {
    this.config = resolveSeedConfig(options);
    this.peers = singlePeer(this.config.baseUrl, this.config.pairingToken);
    this.fetchFn = buildSeedFetch(this.config);
    const req = this.request.bind(this);
    this.status = makeStatusResource(req);
    this.identity = makeIdentityResource(req);
    this.pair = makePairResource(req);
    this.witness = makeWitnessResource(req);
    this.custody = makeCustodyResource(req);
    this.store = makeStoreResource(req);
    this.ota = makeOtaResource(req);
  }
  /**
   * Perform an HTTP request against the seed and return the parsed JSON
   * body. Wraps every attempt in the retry loop. Maps HTTP / network /
   * parse failures onto the ADR-0004 error taxonomy.
   */
  async request(method, path, opts = {}) {
    const peer = this.peers[0];
    const url = buildUrl(peer.baseUrl, path, opts.query);
    const idempotent = opts.idempotent ?? (method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD");
    return runWithRetry(
      async () => this.singleAttempt(method, url, path, peer, opts),
      {
        retries: this.config.retries,
        maxElapsedMs: this.config.timeouts.total ?? DEFAULT_MAX_ELAPSED_MS,
        rateLimitRetry: this.config.rateLimitRetry,
        method,
        idempotent,
        logger: this.config.logger
      },
      path
    );
  }
  async singleAttempt(method, url, pathForLog, peer, opts) {
    const headers = {
      Accept: "application/json",
      "User-Agent": "cognitum-sdk-node/0.2.0-seed-phase1"
    };
    if (peer.pairingToken) {
      headers["X-Pairing-Token"] = peer.pairingToken;
    }
    if (this.config.apiKey) {
      headers["X-API-Key"] = this.config.apiKey;
    }
    const init = { method, headers };
    if (opts.body !== void 0 && method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    const timeoutMs = opts.timeoutMs ?? this.config.timeouts.read;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    init.signal = controller.signal;
    let response;
    try {
      response = await this.fetchFn(url, init);
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new TimeoutError("read", `timeout after ${timeoutMs}ms at ${pathForLog}`);
      }
      if (isAbortError(err)) {
        throw new TimeoutError("read", `timeout after ${timeoutMs}ms at ${pathForLog}`);
      }
      throw new NetworkError(
        err instanceof Error ? err.message : String(err),
        err
      );
    }
    clearTimeout(timer);
    if (response.ok) {
      if (response.status === 204) return void 0;
      return await parseJson(response);
    }
    throw await this.mapHttpError(response, pathForLog);
  }
  /** Translate an HTTP error response into an ADR-0004 `CognitumError`. */
  async mapHttpError(res, pathForLog) {
    const rawBody = await res.text().catch(() => "");
    const parsed = tryJson(rawBody);
    const message = extractMessage(parsed) ?? res.statusText ?? `HTTP ${res.status}`;
    switch (res.status) {
      case 400:
      case 422:
        return new ValidationError(message);
      case 401:
        return new AuthError(`unauthorized: ${message}`);
      case 403:
        return new AuthError(`forbidden: ${message}`);
      case 404:
        return new NotFoundError(message);
      case 409:
        return new ConflictError(message);
      case 429: {
        const headerHint = parseRetryAfterHeader(res.headers.get("Retry-After"));
        const bodyHint = parseSeedRetryAfter(parsed);
        const retryAfterMs = headerHint ?? bodyHint ?? 1e3;
        return new RateLimitError(retryAfterMs, message);
      }
      case 501:
        return new NotImplementedError(pathForLog, message);
      case 503: {
        const headerHint = parseRetryAfterHeader(res.headers.get("Retry-After"));
        return new ServiceUnavailableError(headerHint, message);
      }
      default:
        if (res.status >= 500) {
          return new ServiceUnavailableError(void 0, `HTTP ${res.status}: ${message}`);
        }
        return new CognitumError(`HTTP ${res.status}: ${message}`, "API_ERROR", res.status);
    }
  }
};
function buildUrl(baseUrl, path, query) {
  const joined = `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
  if (!query) return joined;
  const entries = Object.entries(query).filter(([, v]) => v !== void 0);
  if (entries.length === 0) return joined;
  const qs = entries.map(
    ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`
  ).join("&");
  return `${joined}${joined.includes("?") ? "&" : "?"}${qs}`;
}
async function parseJson(res) {
  const text = await res.text();
  if (!text) return void 0;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ParseError("JSON", `invalid JSON in ${res.status} response: ${err.message}`);
  }
}
function tryJson(body) {
  if (!body) return void 0;
  try {
    return JSON.parse(body);
  } catch {
    return void 0;
  }
}
function extractMessage(parsed) {
  if (parsed && typeof parsed === "object") {
    const rec = parsed;
    if (typeof rec.error === "string") return rec.error;
    if (typeof rec.message === "string") return rec.message;
  }
  return void 0;
}
function isAbortError(err) {
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return true;
  }
  return false;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AuthError,
  CognitumError,
  ConfigError,
  ConflictError,
  NetworkError,
  NotFoundError,
  NotImplementedError,
  ParseError,
  RateLimitError,
  SeedClient,
  ServiceUnavailableError,
  TimeoutError,
  ValidationError
});
//# sourceMappingURL=index.cjs.map