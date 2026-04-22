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
var TrustScoreBlockedError = class extends CognitumError {
  /** Canonical URL key of the peer whose trust-score budget was exhausted. */
  peerKey;
  /** Number of consecutive auth failures observed against `peerKey` (always 3). */
  consecutiveFailures;
  /**
   * `null` marker — intentionally not retryable. Exposed so tooling
   * that inspects `retryableAfter` on transient errors sees a definite
   * "do not retry" signal rather than `undefined` (which could be
   * mistaken for "retry immediately").
   */
  retryableAfter;
  constructor(peerKey, message) {
    super(
      message ?? `trust-score blocked: aborting before 4th consecutive auth failure would trigger seed lockdown (peer=${peerKey})`,
      "TRUST_SCORE_BLOCKED"
    );
    this.name = "TrustScoreBlockedError";
    this.peerKey = peerKey;
    this.consecutiveFailures = 3;
    this.retryableAfter = null;
  }
};

// src/seed/config.ts
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
  const endpoints = endpointList.map((raw, idx) => {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new ConfigError(
        `endpoints[${idx}] must be a non-empty URL string`
      );
    }
    return normaliseBaseUrl(raw);
  });
  let pairingToken;
  let pairingTokenMap;
  if (opts.auth?.pairingToken !== void 0) {
    if (typeof opts.auth.pairingToken === "string") {
      pairingToken = opts.auth.pairingToken;
    } else if (opts.auth.pairingToken !== null && typeof opts.auth.pairingToken === "object") {
      pairingTokenMap = { ...opts.auth.pairingToken };
    } else {
      throw new ConfigError(
        "`auth.pairingToken` must be a string or { [clientName]: token } map"
      );
    }
  } else if (typeof process !== "undefined" && process.env?.COGNITUM_SEED_TOKEN) {
    pairingToken = process.env.COGNITUM_SEED_TOKEN;
  }
  const routing = opts.routing ?? "session";
  if (routing !== "pinned" && routing !== "session" && routing !== "round-robin" && routing !== "read-any-write-one") {
    throw new ConfigError(
      `routing="${routing}" is not recognised \u2014 expected "pinned" | "session" | "round-robin" | "read-any-write-one"`
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
    onConnectError: opts.failover?.onConnectError ?? "next-peer",
    onStatus5xx: opts.failover?.onStatus5xx ?? "next-peer"
  };
  let healthInterval;
  if (opts.healthInterval !== void 0) {
    if (typeof opts.healthInterval !== "number" || !Number.isFinite(opts.healthInterval) || opts.healthInterval <= 0) {
      throw new ConfigError(
        `healthInterval must be a positive number of ms (got ${opts.healthInterval})`
      );
    }
    healthInterval = opts.healthInterval;
  }
  return {
    endpoints,
    baseUrl: endpoints[0],
    pairingToken,
    pairingTokenMap,
    apiKey: opts.auth?.apiKey,
    tls,
    routing,
    failover,
    timeouts,
    retries: opts.retries ?? 3,
    rateLimitRetry: opts.rateLimitRetry ?? true,
    tokenBook: opts.tokenBook,
    healthInterval,
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

// src/seed/retry.ts
var BASE_MS = 500;
var CAP_MS = 3e4;
var DEFAULT_MAX_ELAPSED_MS = 6e4;
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

// src/seed/dispatch.ts
async function classifyErrorResponse(res, path) {
  const rawBody = await res.text().catch(() => "");
  const parsed = tryJson(rawBody);
  const message = extractMessage(parsed) ?? res.statusText ?? `HTTP ${res.status}`;
  const status = res.status;
  switch (status) {
    case 400:
    case 422:
      return surface(new ValidationError(message));
    case 401:
      return surface(new AuthError(`unauthorized: ${message}`));
    case 403:
      return surface(new AuthError(`forbidden: ${message}`));
    case 404:
      return surface(new NotFoundError(message));
    case 409:
      return surface(new ConflictError(message));
    case 429: {
      const headerHint = parseRetryAfterHeader(res.headers.get("Retry-After"));
      const bodyHint = parseSeedRetryAfter(parsed);
      const retryAfterMs = headerHint ?? bodyHint ?? 1e3;
      return {
        kind: "err",
        disposition: "pin",
        retryHintMs: retryAfterMs,
        error: new RateLimitError(retryAfterMs, message)
      };
    }
    case 501:
      return surface(new NotImplementedError(path, message));
    case 503: {
      const headerHint = parseRetryAfterHeader(res.headers.get("Retry-After"));
      return {
        kind: "err",
        disposition: "cycle",
        peerClass: "serviceUnavailable",
        retryHintMs: headerHint ?? void 0,
        error: new ServiceUnavailableError(headerHint, message)
      };
    }
    default:
      if (status >= 500) {
        return {
          kind: "err",
          disposition: "cycle",
          peerClass: "server5xx",
          error: new ServiceUnavailableError(
            void 0,
            `HTTP ${status}: ${message}`
          )
        };
      }
      return surface(
        new CognitumError(`HTTP ${status}: ${message}`, "API_ERROR", status)
      );
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
function tryJson(body) {
  if (!body) return void 0;
  try {
    return JSON.parse(body);
  } catch {
    return void 0;
  }
}
function surface(error) {
  return { kind: "err", disposition: "surface", error };
}

// src/seed/health.ts
function startHealthProbe(opts) {
  const { peers, fetchFn, intervalMs } = opts;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError(
      `startHealthProbe: intervalMs must be > 0 (got ${intervalMs})`
    );
  }
  const probeTimeout = opts.probeTimeoutMs ?? intervalMs;
  let stopped = false;
  const controllers = /* @__PURE__ */ new Set();
  const tick = async () => {
    if (stopped) return;
    const snapshot = peers.snapshot();
    await Promise.all(
      snapshot.map(async (p) => {
        if (stopped) return;
        const ctrl = new AbortController();
        controllers.add(ctrl);
        const timer = setTimeout(() => ctrl.abort(), probeTimeout);
        try {
          const headers = {
            Accept: "application/json"
          };
          const tok = opts.tokenForPeer?.(p.key);
          if (tok) headers["X-Pairing-Token"] = tok;
          const res = await fetchFn(`${p.baseUrl}/api/v1/status`, {
            method: "GET",
            headers,
            signal: ctrl.signal
          });
          if (res.ok) {
            peers.markSuccess(p.key, probeTimeout);
          } else {
            const cls = classifyProbeStatus(res.status);
            if (cls) peers.markFailure(p.key, cls);
          }
          try {
            await res.text();
          } catch {
          }
        } catch (err) {
          if (stopped) return;
          const cls = classifyProbeError(err);
          peers.markFailure(p.key, cls);
        } finally {
          clearTimeout(timer);
          controllers.delete(ctrl);
        }
      })
    );
  };
  const interval = setInterval(() => {
    void tick();
  }, intervalMs);
  if (typeof interval.unref === "function") {
    interval.unref();
  }
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      for (const c of controllers) {
        try {
          c.abort();
        } catch {
        }
      }
      controllers.clear();
    }
  };
}
function classifyProbeStatus(status) {
  if (status === 503) return "serviceUnavailable";
  if (status === 500 || status === 502 || status === 504) return "server5xx";
  return void 0;
}
function classifyProbeError(err) {
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return "timeout";
    }
  }
  return "network";
}

// src/seed/peers.ts
function stateRank(state) {
  switch (state) {
    case "healthy":
      return 0;
    case "degraded":
      return 1;
    case "unhealthy":
      return 2;
  }
}
function makePeer(listIndex, rawUrl) {
  const normalised = normaliseBaseUrl2(rawUrl);
  return {
    listIndex,
    baseUrl: normalised,
    key: normalised,
    label: labelFor(normalised),
    state: "healthy",
    latencyEmaMs: void 0,
    lastUsedAt: void 0,
    consecutiveFailures: 0
  };
}
function sortKey(p) {
  const ema = p.latencyEmaMs === void 0 ? Number.MAX_SAFE_INTEGER / 2 : Math.max(0, p.latencyEmaMs);
  return [stateRank(p.state), ema, p.listIndex];
}
function compareSortKeys(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}
var PeerSet = class {
  peers;
  constructor(endpoints) {
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      throw new ConfigError("PeerSet requires at least one endpoint");
    }
    this.peers = endpoints.map((url, i) => makePeer(i, url));
  }
  /** Total peer count. */
  len() {
    return this.peers.length;
  }
  /** Whether more than one peer is configured. */
  isMesh() {
    return this.peers.length > 1;
  }
  /** Snapshot of all peers (shallow copy so callers can't mutate state). */
  snapshot() {
    return this.peers.map((p) => ({ ...p }));
  }
  /** Primary peer — the first in constructor order. */
  primary() {
    return this.peers[0];
  }
  /** Iterator over peers in constructor order. */
  *iter() {
    for (const p of this.peers) yield p;
  }
  /**
   * Pick the next peer to dispatch against per closest-first ordering.
   * Prefers `healthy` → `degraded`; falls back to `unhealthy` only if
   * every peer is unhealthy (so the request still attempts something).
   */
  pick() {
    let best;
    let bestKey;
    for (const p of this.peers) {
      const k = sortKey(p);
      if (!best || !bestKey || compareSortKeys(k, bestKey) < 0) {
        best = p;
        bestKey = k;
      }
    }
    if (!best) {
      throw new ConfigError("PeerSet invariant: at least one peer");
    }
    return best;
  }
  /**
   * Next peer to try after `failed` has returned a cycling-eligible
   * error. Skips `failed` by `listIndex`; scans remaining peers in the
   * same closest-first order.
   */
  nextAfter(failed) {
    let best;
    let bestKey;
    for (const p of this.peers) {
      if (p.listIndex === failed.listIndex) continue;
      const k = sortKey(p);
      if (!best || !bestKey || compareSortKeys(k, bestKey) < 0) {
        best = p;
        bestKey = k;
      }
    }
    return best;
  }
  /** Look up a peer by canonical URL key. */
  findByKey(peerKey) {
    const wanted = normaliseBaseUrl2(peerKey);
    return this.peers.find((p) => p.key === wanted);
  }
  /**
   * Record a successful outcome: update EMA, clear failure counter,
   * promote state to `healthy`.
   */
  markSuccess(peerKey, latencyMs) {
    const p = this.peerMut(peerKey);
    if (!p) return;
    const ms = Math.max(0, latencyMs);
    p.latencyEmaMs = p.latencyEmaMs === void 0 ? ms : 0.8 * p.latencyEmaMs + 0.2 * ms;
    p.consecutiveFailures = 0;
    p.state = "healthy";
    p.lastUsedAt = Date.now();
  }
  /**
   * Record a failure. `class` determines the state transition:
   *
   * - `serviceUnavailable` — immediate `unhealthy` (lockdown semantics).
   * - `network` / `timeout` / `server5xx` — bumps `consecutiveFailures`;
   *   `degraded` at 1-2, `unhealthy` at >=3.
   */
  markFailure(peerKey, cls) {
    const p = this.peerMut(peerKey);
    if (!p) return;
    p.consecutiveFailures += 1;
    p.lastUsedAt = Date.now();
    if (cls === "serviceUnavailable") {
      p.state = "unhealthy";
    } else if (p.consecutiveFailures >= 3) {
      p.state = "unhealthy";
    } else {
      p.state = "degraded";
    }
  }
  peerMut(peerKey) {
    const wanted = normaliseBaseUrl2(peerKey);
    return this.peers.find((p) => p.key === wanted);
  }
};
function normaliseBaseUrl2(raw) {
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
function labelFor(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return url;
  }
}

// src/seed/transport.ts
import { Agent } from "undici";
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
  const dispatcher = buildDispatcher({ insecure, ca });
  if (dispatcher === void 0) {
    return globalThis.fetch;
  }
  return (input, init) => {
    if (init === void 0) {
      return globalThis.fetch(input, { dispatcher });
    }
    init.dispatcher = dispatcher;
    return globalThis.fetch(input, init);
  };
}
function buildDispatcher(tls) {
  if (tls.insecure) {
    return new Agent({
      keepAliveTimeout: 1e4,
      connections: 16,
      allowH2: false,
      connect: {
        rejectUnauthorized: false
      }
    });
  }
  if (tls.ca !== void 0) {
    return new Agent({
      keepAliveTimeout: 1e4,
      connections: 16,
      allowH2: false,
      connect: {
        ca: tls.ca,
        rejectUnauthorized: true
      }
    });
  }
  return void 0;
}

// src/seed/resources/custody.ts
function makeCustodyResource(request) {
  return {
    epoch: () => request("GET", "/api/v1/custody/epoch", {
      idempotent: true
    })
  };
}

// src/seed/resources/identity.ts
function makeIdentityResource(request) {
  const fn = (() => request("GET", "/api/v1/identity", {
    idempotent: true
  }));
  fn.get = fn;
  return fn;
}

// src/seed/resources/ota.ts
function makeOtaResource(request) {
  return {
    config: () => request("GET", "/api/v1/ota/config", {
      idempotent: true
    }),
    checkNow: () => request("POST", "/api/v1/ota/check-now", {
      idempotent: true
      // the seed merely re-checks; no destructive effect
    })
  };
}

// src/seed/tokenBook.ts
var SecretString = class {
  #value;
  constructor(value) {
    if (typeof value !== "string") {
      throw new TypeError("SecretString: value must be a string");
    }
    this.#value = value;
  }
  /**
   * Borrow the inner token. Use sparingly — never log the result.
   */
  reveal() {
    return this.#value;
  }
  /** Whether the underlying string is empty. */
  isEmpty() {
    return this.#value.length === 0;
  }
  /** Length of the underlying string (exposed for diagnostics). */
  get length() {
    return this.#value.length;
  }
  toString() {
    return `SecretString(<redacted, ${this.#value.length} bytes>)`;
  }
  toJSON() {
    return "<redacted>";
  }
  /** Node.js `util.inspect` hook so `console.log` prints a redacted form. */
  [/* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom")]() {
    return this.toString();
  }
};
var InMemoryTokenBook = class _InMemoryTokenBook {
  #inner = /* @__PURE__ */ new Map();
  /**
   * Build a book from an iterable of `[peerUrl, token]` pairs. Raw
   * strings are promoted to {@link SecretString} automatically.
   */
  static fromEntries(entries) {
    const book = new _InMemoryTokenBook();
    for (const [url, token] of entries) {
      book.set(
        url,
        typeof token === "string" ? new SecretString(token) : token
      );
    }
    return book;
  }
  get(peerUrl) {
    return this.#inner.get(normalise(peerUrl));
  }
  set(peerUrl, token) {
    this.#inner.set(normalise(peerUrl), token);
  }
  delete(peerUrl) {
    this.#inner.delete(normalise(peerUrl));
  }
  /** Number of entries; exposed for tests and introspection. */
  get size() {
    return this.#inner.size;
  }
};
function normalise(peerUrl) {
  try {
    return normaliseBaseUrl2(peerUrl);
  } catch {
    return peerUrl.replace(/\/+$/, "");
  }
}
async function pairAll(peers, clientName, pair, book) {
  if (!clientName || typeof clientName !== "string") {
    throw new TypeError("pairAll: clientName must be a non-empty string");
  }
  if (!Array.isArray(peers) || peers.length === 0) {
    throw new TypeError("pairAll: at least one peer required");
  }
  const results = [];
  for (const peer of peers) {
    const response = await pair(peer, clientName);
    const raw = response.pairing_token ?? response.token;
    if (book && typeof raw === "string" && raw.length > 0) {
      book.set(peer, new SecretString(raw));
    }
    results.push([peer, response]);
  }
  return results;
}

// src/seed/resources/pair.ts
function makePairResource(request) {
  return {
    status: () => request("GET", "/api/v1/pair/status", { idempotent: true }),
    create: async (params) => {
      if (!params || typeof params.clientName !== "string" || !params.clientName.trim()) {
        throw new TypeError("pair.create: `clientName` is required");
      }
      const wire = await request("POST", "/api/v1/pair", {
        body: { client_name: params.clientName },
        idempotent: false
      });
      const rawToken = typeof wire?.pairing_token === "string" ? wire.pairing_token : "";
      const response = {
        client_name: wire?.client_name ?? params.clientName,
        token: new SecretString(rawToken)
      };
      if (typeof wire?.expires_at === "string") {
        response.expires_at = wire.expires_at;
      }
      return response;
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

// src/seed/resources/status.ts
function makeStatusResource(request) {
  const fn = (() => request("GET", "/api/v1/status", {
    idempotent: true
  }));
  fn.get = fn;
  return fn;
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

// src/seed/resources/witness.ts
function makeWitnessResource(request) {
  return {
    chain: () => request("GET", "/api/v1/witness/chain", {
      idempotent: true
    })
  };
}

// src/seed/session.ts
var SeedSession = class {
  /** Canonical URL key of the pinned peer (no trailing slash). */
  pinnedPeer;
  /** GET /api/v1/status on the pinned peer. */
  status;
  /** GET /api/v1/identity on the pinned peer. */
  identity;
  /** Pairing resource on the pinned peer. */
  pair;
  /** Witness resource on the pinned peer. */
  witness;
  /** Custody resource on the pinned peer. */
  custody;
  /** Store resource on the pinned peer. */
  store;
  /** OTA resource on the pinned peer. */
  ota;
  /** @internal — constructed by {@link SeedClient.session}. */
  constructor(client, pinnedPeer) {
    this.pinnedPeer = pinnedPeer;
    const req = (method, path, opts) => client.request(method, path, { ...opts ?? {}, pinnedPeerKey: pinnedPeer });
    this.status = makeStatusResource(req);
    this.identity = makeIdentityResource(req);
    this.pair = makePairResource(req);
    this.witness = makeWitnessResource(req);
    this.custody = makeCustodyResource(req);
    this.store = makeStoreResource(req);
    this.ota = makeOtaResource(req);
  }
};

// src/seed/client.ts
var SeedClient = class _SeedClient {
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
  /** Peer set — closest-first picker with per-peer health state. */
  peerSet;
  /** Per-peer pairing-token store. */
  tokenBook;
  /** TLS-aware fetch bound to this client. */
  fetchFn;
  /** Active health-probe handle; `undefined` when disabled. */
  healthProbe;
  /**
   * Per-peer consecutive-AuthError counter — ADR-0007 §"Trust-score
   * protection", closes cognitum-one/sdks#16. The seed locks a client
   * out after 3 failed auth attempts; we abort on the 3rd so the caller
   * never burns the seed's budget. Reset to 0 on any 2xx from the same
   * peer, or explicitly via {@link SeedClient.resetTrustScore}.
   */
  authFailures = /* @__PURE__ */ new Map();
  /** Trust-score threshold — 3 consecutive auth failures triggers block. */
  static TRUST_SCORE_LIMIT = 3;
  constructor(options) {
    this.config = resolveSeedConfig(options);
    this.peerSet = new PeerSet(this.config.endpoints);
    this.tokenBook = this.config.tokenBook ?? new InMemoryTokenBook();
    if (this.config.pairingToken !== void 0) {
      const shared = new SecretString(this.config.pairingToken);
      for (const peer of this.peerSet.iter()) {
        if (this.tokenBook.get(peer.key) === void 0) {
          this.tokenBook.set(peer.key, shared);
        }
      }
    }
    this.fetchFn = buildSeedFetch(this.config);
    const req = this.request.bind(this);
    this.status = makeStatusResource(req);
    this.identity = makeIdentityResource(req);
    this.pair = makePairResource(req);
    this.witness = makeWitnessResource(req);
    this.custody = makeCustodyResource(req);
    this.store = makeStoreResource(req);
    this.ota = makeOtaResource(req);
    if (this.config.healthInterval !== void 0) {
      this.healthProbe = startHealthProbe({
        peers: this.peerSet,
        fetchFn: this.fetchFn,
        intervalMs: this.config.healthInterval,
        tokenForPeer: (peerKey) => {
          const tok = this.tokenBook.get(peerKey);
          return tok?.reveal();
        }
      });
    }
  }
  /**
   * Snapshot view of the SDK-local peer table (ADR-0016a §D7 —
   * `client.peers()`). The returned array is a shallow copy; mutations
   * do not affect routing.
   */
  peers() {
    return this.peerSet.snapshot();
  }
  /**
   * Open a {@link SeedSession} pinned to the currently closest-first
   * peer. The session holds the pin for its lifetime; all its resource
   * calls go to the same peer unless the peer hard-fails, in which case
   * the failover state machine transparently cycles.
   */
  session() {
    return new SeedSession(this, this.peerSet.pick().key);
  }
  /**
   * Stop the active health probe (if any) so the Node event loop can
   * exit cleanly. Idempotent — safe to call more than once.
   *
   * Does NOT revoke pairing or wipe the TokenBook; callers own token
   * lifetimes per ADR-0007.
   */
  close() {
    this.healthProbe?.stop();
  }
  /**
   * Introspection helper for tests: look up a pairing token by
   * canonical peer URL. Returns `undefined` when the book has no entry.
   * @internal
   */
  tokenForPeer(peerKey) {
    return this.tokenBook.get(peerKey)?.reveal();
  }
  /**
   * Clear the trust-score counter for a single peer (or, with no
   * argument, every peer). Call this after the caller has rotated the
   * pairing token or otherwise resolved the auth failure that triggered
   * the block — without a reset, the client will keep refusing further
   * requests to that peer to protect the seed's trust-score budget.
   *
   * @param peerKey — canonical peer URL to clear. If omitted, clears
   *   every peer's counter.
   */
  resetTrustScore(peerKey) {
    if (peerKey === void 0) {
      this.authFailures.clear();
      return;
    }
    this.authFailures.delete(peerKey);
  }
  /**
   * Current trust-score counter for `peerKey`. Exposed for tests; the
   * public API surface should consume {@link TrustScoreBlockedError}
   * from `request()` rather than polling this number.
   * @internal
   */
  trustScoreFailures(peerKey) {
    return this.authFailures.get(peerKey) ?? 0;
  }
  /**
   * Perform an HTTP request against the seed mesh and return the parsed
   * JSON body. Implements the Phase 1.5 failover state machine.
   */
  async request(method, path, opts = {}) {
    const methodUpper = method.toUpperCase();
    const idempotent = opts.idempotent ?? (methodUpper === "GET" || methodUpper === "HEAD");
    const totalBudgetMs = this.config.timeouts.total ?? DEFAULT_MAX_ELAPSED_MS;
    const startedAt = Date.now();
    const hasBody = opts.body !== void 0 && methodUpper !== "GET" && methodUpper !== "HEAD";
    const bodyStr = hasBody ? JSON.stringify(opts.body) : void 0;
    let peer = this.initialPeer(opts.pinnedPeerKey);
    const totalPeers = this.peerSet.len();
    let peersTried = 0;
    let retryAttempt = 0;
    let lastErr;
    for (; ; ) {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= totalBudgetMs) {
        throw lastErr ?? new TimeoutError(
          "read",
          `seed: total deadline ${totalBudgetMs}ms exceeded at ${path}`
        );
      }
      if ((this.authFailures.get(peer.key) ?? 0) >= _SeedClient.TRUST_SCORE_LIMIT) {
        throw new TrustScoreBlockedError(peer.key);
      }
      const attemptBudgetMs = Math.max(1, totalBudgetMs - elapsed);
      const attemptTimeoutMs = Math.min(
        opts.timeoutMs ?? this.config.timeouts.read,
        attemptBudgetMs
      );
      const outcome = await this.dispatchOnce(
        methodUpper,
        path,
        peer,
        opts,
        attemptTimeoutMs,
        bodyStr
      );
      if (outcome.kind === "ok") {
        this.authFailures.delete(peer.key);
        return outcome.value;
      }
      if (outcome.error instanceof AuthError) {
        const next = (this.authFailures.get(peer.key) ?? 0) + 1;
        this.authFailures.set(peer.key, next);
        if (next >= _SeedClient.TRUST_SCORE_LIMIT) {
          throw new TrustScoreBlockedError(peer.key);
        }
      }
      if (outcome.peerClass !== void 0) {
        this.peerSet.markFailure(peer.key, outcome.peerClass);
      }
      lastErr = outcome.error;
      switch (outcome.disposition) {
        case "cycle": {
          peersTried += 1;
          if (peersTried < totalPeers) {
            const next = this.peerSet.nextAfter(peer);
            if (next) {
              peer = next;
              continue;
            }
          }
          if (this.shouldBackoffRetry(outcome.error, methodUpper, idempotent)) {
            const delayMs = this.backoffDelay(
              retryAttempt,
              outcome.retryHintMs
            );
            if (Date.now() - startedAt + delayMs > totalBudgetMs) {
              throw outcome.error;
            }
            if (retryAttempt + 1 > this.config.retries) {
              throw outcome.error;
            }
            await sleep(delayMs);
            retryAttempt += 1;
            peersTried = 0;
            peer = this.initialPeer(opts.pinnedPeerKey);
            continue;
          }
          throw outcome.error;
        }
        case "pin": {
          if (!this.shouldBackoffRetry(outcome.error, methodUpper, idempotent)) {
            throw outcome.error;
          }
          if (retryAttempt + 1 > this.config.retries) {
            throw outcome.error;
          }
          const delayMs = this.backoffDelay(retryAttempt, outcome.retryHintMs);
          if (Date.now() - startedAt + delayMs > totalBudgetMs) {
            throw outcome.error;
          }
          await sleep(delayMs);
          retryAttempt += 1;
          continue;
        }
        case "surface": {
          throw outcome.error;
        }
      }
    }
  }
  // ------------------------------------------------------------------ //
  // internals                                                          //
  // ------------------------------------------------------------------ //
  initialPeer(pinnedKey) {
    if (pinnedKey) {
      const pinned = this.peerSet.findByKey(pinnedKey);
      if (pinned) return pinned;
    }
    return this.peerSet.pick();
  }
  shouldBackoffRetry(err, method, idempotent) {
    if (err instanceof RateLimitError) return this.config.rateLimitRetry;
    if (err instanceof ServiceUnavailableError) return true;
    if (err instanceof NetworkError) return true;
    if (err instanceof TimeoutError) {
      if (err.phase === "connect") return true;
      if (method === "POST" && !idempotent) return false;
      return true;
    }
    if (err instanceof CognitumError) {
      const sc = err.statusCode;
      if (sc !== void 0 && sc >= 500 && sc !== 501) return true;
    }
    return false;
  }
  backoffDelay(attempt, hintMs) {
    const expo = BASE_MS * 2 ** attempt;
    const jitter = Math.random() * BASE_MS;
    const computed = Math.min(CAP_MS, expo + jitter);
    if (hintMs !== void 0) {
      return Math.min(CAP_MS, Math.max(computed, hintMs));
    }
    return computed;
  }
  async dispatchOnce(method, path, peer, opts, attemptTimeoutMs, bodyStr) {
    const url = buildUrl(peer.baseUrl, path, opts.query);
    const headers = {
      Accept: "application/json",
      "User-Agent": "cognitum-sdk-node/0.2.0-seed-phase1.5"
    };
    const tok = this.tokenBook.get(peer.key);
    if (tok) {
      headers["X-Pairing-Token"] = tok.reveal();
    }
    if (this.config.apiKey) {
      headers["X-API-Key"] = this.config.apiKey;
    }
    const init = { method, headers };
    if (bodyStr !== void 0) {
      headers["Content-Type"] = "application/json";
      init.body = bodyStr;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    init.signal = controller.signal;
    const callStarted = Date.now();
    let response;
    try {
      response = await this.fetchFn(url, init);
    } catch (err) {
      clearTimeout(timer);
      if (isAbortError(err)) {
        const e2 = new TimeoutError(
          "read",
          `timeout after ${attemptTimeoutMs}ms at ${path}`
        );
        return {
          kind: "err",
          disposition: "cycle",
          peerClass: "timeout",
          error: e2
        };
      }
      const e = new NetworkError(
        err instanceof Error ? err.message : String(err),
        err
      );
      return {
        kind: "err",
        disposition: "cycle",
        peerClass: "network",
        error: e
      };
    }
    clearTimeout(timer);
    if (response.ok) {
      const value = response.status === 204 ? void 0 : await parseJson(response);
      this.peerSet.markSuccess(peer.key, Date.now() - callStarted);
      return { kind: "ok", value };
    }
    return classifyErrorResponse(response, path);
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
    throw new ParseError(
      "JSON",
      `invalid JSON in ${res.status} response: ${err.message}`
    );
  }
}
function isAbortError(err) {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return true;
  }
  return false;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
export {
  AuthError,
  CognitumError,
  ConfigError,
  ConflictError,
  InMemoryTokenBook,
  NetworkError,
  NotFoundError,
  NotImplementedError,
  ParseError,
  PeerSet,
  RateLimitError,
  SecretString,
  SeedClient,
  SeedSession,
  ServiceUnavailableError,
  TimeoutError,
  TrustScoreBlockedError,
  ValidationError,
  normaliseBaseUrl2 as normaliseBaseUrl,
  pairAll,
  startHealthProbe
};
//# sourceMappingURL=index.js.map