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
  ExplicitDiscovery: () => ExplicitDiscovery,
  InMemoryTokenBook: () => InMemoryTokenBook,
  NetworkError: () => NetworkError,
  NotFoundError: () => NotFoundError,
  NotImplementedError: () => NotImplementedError,
  ParseError: () => ParseError,
  PeerSet: () => PeerSet,
  RateLimitError: () => RateLimitError,
  SecretString: () => SecretString,
  SeedClient: () => SeedClient,
  SeedSession: () => SeedSession,
  ServiceUnavailableError: () => ServiceUnavailableError,
  TailscaleDiscovery: () => TailscaleDiscovery,
  TimeoutError: () => TimeoutError,
  TlsPinError: () => TlsPinError,
  TrustScoreBlockedError: () => TrustScoreBlockedError,
  UnsupportedError: () => UnsupportedError,
  ValidationError: () => ValidationError,
  normaliseBaseUrl: () => normaliseBaseUrl2,
  pairAll: () => pairAll,
  startHealthProbe: () => startHealthProbe
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
var UnsupportedError = class extends CognitumError {
  /** Feature identifier (e.g. `"consistency=strong"`). */
  feature;
  constructor(feature, message) {
    super(
      message ?? `unsupported: ${feature}`,
      "UNSUPPORTED"
    );
    this.name = "UnsupportedError";
    this.feature = feature;
  }
};
var TlsPinError = class extends CognitumError {
  /** Canonical peer URL that failed pinning. */
  peerKey;
  /** Fingerprint the peer advertised (hex, lowercase, no colons). */
  expectedFingerprint;
  /** SHA-256 of the cert the peer actually presented (hex, lowercase). */
  actualFingerprint;
  constructor(peerKey, expectedFingerprint, actualFingerprint, message) {
    super(
      message ?? `TLS fingerprint mismatch for ${peerKey}: expected ${expectedFingerprint}, got ${actualFingerprint ?? "<unknown>"}`,
      "TLS_PIN_ERROR"
    );
    this.name = "TlsPinError";
    this.peerKey = peerKey;
    this.expectedFingerprint = expectedFingerprint;
    this.actualFingerprint = actualFingerprint;
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
  let discovery;
  const resolvedEndpoints = opts.endpoints;
  if (isDiscoveryProvider(opts.endpoints)) {
    throw new ConfigError(
      "`endpoints` is a DiscoveryProvider \u2014 use `await SeedClient.create(options)` which resolves discovery before constructing the client."
    );
  }
  let peerOptions;
  if (opts._preResolvedFromDiscovery) {
    const internal = opts;
    discovery = internal._preResolvedFromDiscovery;
    peerOptions = internal._peerOptions;
  }
  const endpointList = Array.isArray(resolvedEndpoints) ? resolvedEndpoints : [resolvedEndpoints];
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
    discovery,
    peerOptions,
    fetchFn: opts.fetch ?? globalThis.fetch,
    logger: opts.logger ?? {}
  };
}
function isDiscoveryProvider(x) {
  return typeof x === "object" && x !== null && typeof x.discover === "function";
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
function makePeer(listIndex, rawUrl, opts) {
  const normalised = normaliseBaseUrl2(rawUrl);
  return {
    listIndex,
    baseUrl: normalised,
    key: normalised,
    label: labelFor(normalised),
    state: "healthy",
    latencyEmaMs: void 0,
    lastUsedAt: void 0,
    consecutiveFailures: 0,
    tlsFingerprint: opts?.tlsFingerprint
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
  constructor(endpoints, peerOptions) {
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      throw new ConfigError("PeerSet requires at least one endpoint");
    }
    this.peers = endpoints.map((url, i) => makePeer(i, url, peerOptions?.[i]));
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
   * Reset every peer's per-session state so the next `pick()` is driven
   * purely by `listIndex` again. Used by `SeedClient.rediscover()` to
   * re-prime the table after a caller has rotated credentials / rebuilt
   * the peer list. Does NOT remove peers; does NOT touch the TokenBook.
   */
  resetAll() {
    for (const p of this.peers) {
      p.state = "healthy";
      p.latencyEmaMs = void 0;
      p.consecutiveFailures = 0;
    }
  }
  /**
   * Return a one-call ordered view per {@link CallPrefer} — used by the
   * per-call `prefer:` knob in the request pipeline. Does NOT mutate
   * the underlying table.
   *
   * - `"closest"` / `"any"` — default closest-first ordering.
   * - `"local-first"` — RFC-1918 / link-local hosts first, then the
   *   closest-first ordering for the remainder.
   * - `"random"` — Fisher-Yates shuffle with `Math.random`.
   */
  preferOrder(mode) {
    const snap = this.peers.slice();
    switch (mode) {
      case "closest":
      case "any": {
        snap.sort((a, b) => compareSortKeys(sortKey(a), sortKey(b)));
        return snap;
      }
      case "local-first": {
        const local = snap.filter(isLocalHost);
        const rest = snap.filter((p) => !isLocalHost(p));
        local.sort((a, b) => compareSortKeys(sortKey(a), sortKey(b)));
        rest.sort((a, b) => compareSortKeys(sortKey(a), sortKey(b)));
        return [...local, ...rest];
      }
      case "random": {
        for (let i = snap.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          [snap[i], snap[j]] = [snap[j], snap[i]];
        }
        return snap;
      }
    }
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
function isLocalHost(peer) {
  let host;
  try {
    host = new URL(peer.baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "::1" || host.startsWith("127.")) {
    return true;
  }
  if (host.startsWith("169.254.")) return true;
  if (host.startsWith("fe80:") || host.startsWith("[fe80")) return true;
  if (host.startsWith("10.")) return true;
  if (host.startsWith("192.168.")) return true;
  if (host.startsWith("172.")) {
    const octet = Number.parseInt(host.split(".")[1] ?? "", 10);
    if (Number.isFinite(octet) && octet >= 16 && octet <= 31) return true;
  }
  return false;
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
var import_node_crypto = require("crypto");
var import_undici = require("undici");
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
    return new import_undici.Agent({
      keepAliveTimeout: 1e4,
      connections: 16,
      allowH2: false,
      connect: {
        rejectUnauthorized: false
      }
    });
  }
  if (tls.ca !== void 0) {
    return new import_undici.Agent({
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
function buildPeerDispatcherFactory(tls) {
  if (tls.ca !== void 0) {
    return () => void 0;
  }
  const cache = /* @__PURE__ */ new Map();
  return (peer) => {
    if (!peer.tlsFingerprint) return void 0;
    const cached = cache.get(peer.key);
    if (cached !== void 0) return cached;
    const agent = buildPinnedAgent(peer.key, peer.tlsFingerprint);
    cache.set(peer.key, agent);
    return agent;
  };
}
function buildPinnedAgent(peerKey, expectedFingerprint) {
  return new import_undici.Agent({
    keepAliveTimeout: 1e4,
    connections: 16,
    allowH2: false,
    connect: {
      // rejectUnauthorized must stay off here because the seed serves a
      // self-signed cert — standard chain validation would always fail.
      // The fingerprint pin IS the trust anchor, enforced below.
      rejectUnauthorized: false,
      checkServerIdentity: makePinCheckServerIdentity(
        peerKey,
        expectedFingerprint
      )
    }
  });
}
function makePinCheckServerIdentity(peerKey, expectedFingerprint) {
  return (_host, cert) => {
    const actual = sha256OfCert(cert);
    if (!matchFingerprint(expectedFingerprint, actual)) {
      const e = new Error(
        `TLS fingerprint mismatch for ${peerKey}: expected ${expectedFingerprint}, got ${actual ?? "<unknown>"}`
      );
      e.code = "TLS_PIN_ERROR";
      e.peerKey = peerKey;
      e.expectedFingerprint = expectedFingerprint;
      e.actualFingerprint = actual;
      return e;
    }
    return void 0;
  };
}
function sha256OfCert(cert) {
  const raw = cert?.raw;
  if (!raw) return void 0;
  return (0, import_node_crypto.createHash)("sha256").update(raw).digest("hex");
}
function matchFingerprint(expected, actual) {
  if (!actual) return false;
  if (expected.length === 0) return false;
  if (expected.length > actual.length) return false;
  return actual.startsWith(expected);
}
function classifyPinFailure(err) {
  const seen = /* @__PURE__ */ new Set();
  let cur = err;
  while (cur !== void 0 && cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const rec = cur;
    if (rec.code === "TLS_PIN_ERROR" && typeof rec.peerKey === "string" && typeof rec.expectedFingerprint === "string") {
      const actual = typeof rec.actualFingerprint === "string" ? rec.actualFingerprint : void 0;
      return new TlsPinError(rec.peerKey, rec.expectedFingerprint, actual);
    }
    cur = rec.cause;
  }
  return void 0;
}

// src/seed/resources/custody.ts
function makeCustodyResource(request) {
  return {
    epoch: (opts) => request("GET", "/api/v1/custody/epoch", {
      idempotent: true,
      ...opts ?? {}
    })
  };
}

// src/seed/resources/identity.ts
function makeIdentityResource(request) {
  const fn = ((opts) => request("GET", "/api/v1/identity", {
    idempotent: true,
    ...opts ?? {}
  }));
  fn.get = fn;
  return fn;
}

// src/seed/resources/mesh.ts
function makeMeshResource(request) {
  return {
    status: (opts) => request("GET", "/api/v1/network/mesh/status", {
      idempotent: true,
      ...opts ?? {}
    }),
    peers: (opts) => request("GET", "/api/v1/peers", {
      idempotent: true,
      ...opts ?? {}
    }),
    swarmStatus: (opts) => request("GET", "/api/v1/swarm/status", {
      idempotent: true,
      ...opts ?? {}
    }),
    clusterHealth: (opts) => request("GET", "/api/v1/cluster/health", {
      idempotent: true,
      ...opts ?? {}
    })
  };
}

// src/seed/resources/ota.ts
function makeOtaResource(request) {
  return {
    config: (opts) => request("GET", "/api/v1/ota/config", {
      idempotent: true,
      ...opts ?? {}
    }),
    checkNow: (opts) => request("POST", "/api/v1/ota/check-now", {
      idempotent: true,
      // the seed merely re-checks; no destructive effect
      ...opts ?? {}
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
    status: (opts) => request("GET", "/api/v1/pair/status", {
      idempotent: true,
      ...opts ?? {}
    }),
    create: async (params, opts) => {
      if (!params || typeof params.clientName !== "string" || !params.clientName.trim()) {
        throw new TypeError("pair.create: `clientName` is required");
      }
      const wire = await request("POST", "/api/v1/pair", {
        body: { client_name: params.clientName },
        idempotent: false,
        ...opts ?? {}
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
    delete: async (clientName, opts) => {
      if (typeof clientName !== "string" || !clientName.trim()) {
        throw new TypeError("pair.delete: `clientName` is required");
      }
      await request("DELETE", `/api/v1/pair/${encodeURIComponent(clientName)}`, {
        idempotent: true,
        ...opts ?? {}
      });
    }
  };
}

// src/seed/resources/status.ts
function makeStatusResource(request) {
  const fn = ((opts) => request("GET", "/api/v1/status", {
    idempotent: true,
    ...opts ?? {}
  }));
  fn.get = fn;
  return fn;
}

// src/seed/resources/store.ts
function makeStoreResource(request) {
  return {
    status: (opts) => request("GET", "/api/v1/store/status", {
      idempotent: true,
      ...opts ?? {}
    }),
    query: (params, opts) => {
      if (!params || !Array.isArray(params.vector) || typeof params.k !== "number") {
        throw new TypeError("store.query: { vector: number[], k: number } required");
      }
      return request("POST", "/api/v1/store/query", {
        body: {
          vector: params.vector,
          k: params.k,
          ...params.metric ? { metric: params.metric } : {}
        },
        idempotent: true,
        // read-only query; safe to retry on timeout
        ...opts ?? {}
      });
    },
    ingest: (params, opts) => {
      if (!params || !Array.isArray(params.vectors) || params.vectors.length === 0) {
        throw new TypeError("store.ingest: { vectors: StoreIngestItem[] } required (non-empty)");
      }
      return request("POST", "/api/v1/store/ingest", {
        body: { vectors: params.vectors },
        idempotent: false,
        ...opts ?? {}
      });
    }
  };
}

// src/seed/resources/witness.ts
function makeWitnessResource(request) {
  return {
    chain: (opts) => request("GET", "/api/v1/witness/chain", {
      idempotent: true,
      ...opts ?? {}
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
  /** Mesh observability — read endpoints routed through the pinned peer. */
  mesh;
  /** @internal — constructed by {@link SeedClient.session}. */
  constructor(client, pinnedPeer) {
    this.pinnedPeer = pinnedPeer;
    const req = (method, path, opts) => client.request(method, path, {
      ...opts ?? {},
      pinnedPeerKey: pinnedPeer
    });
    this.status = makeStatusResource(req);
    this.identity = makeIdentityResource(req);
    this.pair = makePairResource(req);
    this.witness = makeWitnessResource(req);
    this.custody = makeCustodyResource(req);
    this.store = makeStoreResource(req);
    this.ota = makeOtaResource(req);
    this.mesh = makeMeshResource(req);
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
  /**
   * Mesh observability — `status()`, `peers()`, `swarmStatus()`,
   * `clusterHealth()` (ADR-0016a §D8). Read-only; all four are on the
   * seed's WiFi-read allowlist so no pairing token is needed.
   */
  mesh;
  /**
   * Peer set — closest-first picker with per-peer health state.
   * Re-assigned (not mutated) by {@link SeedClient.rediscover} when a
   * discovery provider returns a fresh peer list; the reference-swap
   * keeps the data structure's internal invariants tidy without needing
   * a separate "replace" method on {@link PeerSet}.
   */
  peerSet;
  /** Per-peer pairing-token store. */
  tokenBook;
  /** TLS-aware fetch bound to this client. */
  fetchFn;
  /**
   * Per-peer dispatcher factory (ADR-0015c Phase 3 §fp= cert pinning).
   * Returns a pinned undici Agent when the peer carries an mDNS
   * fingerprint; `undefined` otherwise (→ client-wide dispatcher
   * applies). Memoised inside the factory — one Agent per peer for the
   * client's lifetime.
   */
  peerDispatcher;
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
  /**
   * Attached discovery provider (ADR-0016a §D6). When set,
   * {@link SeedClient.rediscover} re-invokes `discover()` and rebuilds
   * the {@link PeerSet} with the fresh entries. `undefined` for
   * explicit-list clients.
   */
  discovery;
  /**
   * Async factory that resolves a {@link DiscoveryProvider} before
   * constructing the client. Use this when `options.endpoints` is a
   * provider (e.g. `MdnsDiscovery`) — the sync constructor rejects
   * providers because `discover()` is async.
   *
   * For explicit-list callers the sync constructor still works; this
   * factory is only needed for the Phase 1.5 opt-in discovery path.
   *
   * @example
   * ```ts
   * import { SeedClient } from "@cognitum/sdk/seed";
   * import { MdnsDiscovery } from "@cognitum/sdk/seed/discovery/mdns";
   *
   * const client = await SeedClient.create({
   *   endpoints: MdnsDiscovery.default(),
   *   tls: { insecure: true },
   * });
   * ```
   */
  static async create(options) {
    const ep = options.endpoints;
    if (typeof ep === "object" && ep !== null && !Array.isArray(ep) && typeof ep.discover === "function") {
      const provider = ep;
      const peers = await provider.discover();
      if (!peers || peers.length === 0) {
        throw new ConfigError(
          "DiscoveryProvider returned no peers; cannot construct SeedClient. Check mDNS / network multicast configuration."
        );
      }
      const internal = {
        ...options,
        endpoints: peers.map((p) => p.url),
        _preResolvedFromDiscovery: provider,
        _peerOptions: peers.map(
          (p) => p.tlsFingerprint !== void 0 ? { tlsFingerprint: p.tlsFingerprint } : void 0
        )
      };
      return new _SeedClient(internal);
    }
    return new _SeedClient(options);
  }
  constructor(options) {
    this.config = resolveSeedConfig(options);
    this.peerSet = new PeerSet(
      this.config.endpoints,
      this.config.peerOptions
    );
    this.discovery = this.config.discovery;
    this.peerDispatcher = buildPeerDispatcherFactory(this.config.tls);
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
    this.mesh = makeMeshResource(req);
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
   * Stop the active health probe (if any) and close the attached
   * discovery provider (if any) so the Node event loop can exit
   * cleanly. Idempotent — safe to call more than once.
   *
   * The discovery provider's `close()` is awaited only when the caller
   * awaits the returned value; sync callers still get a best-effort
   * teardown (mDNS sockets are set to `unref` on the wire layer).
   *
   * Does NOT revoke pairing or wipe the TokenBook; callers own token
   * lifetimes per ADR-0007.
   */
  close() {
    this.healthProbe?.stop();
    if (this.discovery?.close) {
      const r = this.discovery.close();
      if (r && typeof r.then === "function") {
        return r;
      }
    }
  }
  /**
   * Rebuild the per-peer routing state from scratch (ADR-0016a §D7
   * "rediscover"). Resets every peer's {@link Peer.state} to `"healthy"`,
   * clears `latencyEmaMs`, zeroes `consecutiveFailures`, and re-sorts
   * the table so the next `request()` is driven by constructor order.
   *
   * Use this after rotating pairing tokens or when the caller knows the
   * previous failure bookkeeping is stale (e.g. the mesh transport
   * recovered out-of-band from a brown-out). Idempotent — calling it
   * multiple times in a row is a no-op beyond the first.
   *
   * No discovery provider: returns `void` synchronously (reset only).
   * With a discovery provider attached (ADR-0016a §D6): returns a
   * `Promise<void>` that resolves after the provider has been
   * re-queried and the {@link PeerSet} rebuilt with the fresh entries.
   * Providers that return zero peers are treated as a no-op — the
   * previous peer set is preserved so the client never becomes
   * un-routable as a side-effect of a transient multicast drop.
   */
  rediscover() {
    if (this.discovery === void 0) {
      this.peerSet.resetAll();
      this.authFailures.clear();
      return;
    }
    return this.rediscoverFromProvider(this.discovery);
  }
  /**
   * Re-query the attached discovery provider, normalise results, and
   * splice them into the peer table. Preserves tokens for URLs that
   * are still present; ejects tokens for URLs that have dropped out.
   * @internal
   */
  async rediscoverFromProvider(provider) {
    const fresh = await provider.discover();
    if (!fresh || fresh.length === 0) {
      this.peerSet.resetAll();
      this.authFailures.clear();
      return;
    }
    const urls = fresh.map((p) => p.url);
    const freshSet = new Set(urls);
    for (const peer of this.peerSet.iter()) {
      if (!freshSet.has(peer.key)) {
        this.tokenBook.delete?.(peer.key);
      }
    }
    const peerOpts = fresh.map(
      (p) => p.tlsFingerprint !== void 0 ? { tlsFingerprint: p.tlsFingerprint } : void 0
    );
    this.peerSet = new PeerSet(urls, peerOpts);
    if (this.config.pairingToken !== void 0) {
      const shared = new SecretString(this.config.pairingToken);
      for (const peer of this.peerSet.iter()) {
        if (this.tokenBook.get(peer.key) === void 0) {
          this.tokenBook.set(peer.key, shared);
        }
      }
    }
    this.authFailures.clear();
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
    if (opts.consistency === "strong") {
      throw new UnsupportedError(
        "consistency=strong",
        "strong consistency unsupported; seed has no quorum protocol today"
      );
    }
    let explicitPeer;
    if (opts.peer !== void 0) {
      explicitPeer = this.peerSet.findByKey(opts.peer);
      if (!explicitPeer) {
        throw new ConfigError(`peer not in mesh: ${opts.peer}`);
      }
    }
    const methodUpper = method.toUpperCase();
    const idempotent = opts.idempotent ?? (methodUpper === "GET" || methodUpper === "HEAD");
    const totalBudgetMs = this.config.timeouts.total ?? DEFAULT_MAX_ELAPSED_MS;
    const retriesBudget = opts.retries === null ? 0 : typeof opts.retries === "number" ? opts.retries : this.config.retries;
    const preferOrder = explicitPeer === void 0 && opts.prefer !== void 0 ? this.peerSet.preferOrder(opts.prefer) : void 0;
    let preferCursor = 0;
    const startedAt = Date.now();
    const hasBody = opts.body !== void 0 && methodUpper !== "GET" && methodUpper !== "HEAD";
    const bodyStr = hasBody ? JSON.stringify(opts.body) : void 0;
    let peer;
    if (explicitPeer) {
      peer = explicitPeer;
    } else if (preferOrder && preferOrder.length > 0) {
      peer = preferOrder[0];
      preferCursor = 1;
    } else if (opts.consistency === "eventual") {
      peer = this.peerSet.pick();
    } else {
      peer = this.initialPeer(opts.pinnedPeerKey);
    }
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
          if (explicitPeer) {
            throw outcome.error;
          }
          peersTried += 1;
          if (peersTried < totalPeers) {
            let next;
            if (preferOrder) {
              next = preferOrder[preferCursor];
              preferCursor += 1;
            } else {
              next = this.peerSet.nextAfter(peer);
            }
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
            if (retryAttempt + 1 > retriesBudget) {
              throw outcome.error;
            }
            await sleep(delayMs);
            retryAttempt += 1;
            peersTried = 0;
            preferCursor = preferOrder ? 1 : 0;
            peer = preferOrder ? preferOrder[0] : this.initialPeer(opts.pinnedPeerKey);
            continue;
          }
          throw outcome.error;
        }
        case "pin": {
          if (!this.shouldBackoffRetry(outcome.error, methodUpper, idempotent)) {
            throw outcome.error;
          }
          if (retryAttempt + 1 > retriesBudget) {
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
    const pinnedDispatcher = this.peerDispatcher(peer);
    if (pinnedDispatcher !== void 0) {
      init.dispatcher = pinnedDispatcher;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    const callerSignal = opts.signal;
    const onCallerAbort = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) {
        controller.abort();
      } else {
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }
    init.signal = controller.signal;
    const callStarted = Date.now();
    let response;
    try {
      response = await this.fetchFn(url, init);
    } catch (err) {
      clearTimeout(timer);
      if (callerSignal) {
        callerSignal.removeEventListener("abort", onCallerAbort);
      }
      if (callerSignal?.aborted) {
        const e2 = new NetworkError("request aborted by caller signal", err);
        return {
          kind: "err",
          disposition: "surface",
          peerClass: "network",
          error: e2
        };
      }
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
      const pinErr = classifyPinFailure(err);
      if (pinErr) {
        return {
          kind: "err",
          disposition: "surface",
          error: pinErr
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
    if (callerSignal) {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
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

// src/seed/discovery/explicit.ts
var ExplicitDiscovery = class {
  peers;
  constructor(endpoints) {
    const list = Array.isArray(endpoints) ? endpoints : [endpoints];
    if (list.length === 0) {
      throw new ConfigError("ExplicitDiscovery requires at least one endpoint");
    }
    this.peers = list.map((url, idx) => {
      if (typeof url !== "string" || !url.trim()) {
        throw new ConfigError(
          `endpoints[${idx}] must be a non-empty URL string`
        );
      }
      return { url: normaliseBaseUrl2(url) };
    });
  }
  async discover() {
    return this.peers.map((p) => ({ ...p }));
  }
};

// src/seed/discovery/tailscale.ts
var DEFAULT_PREFIX = "cognitum-";
var DEFAULT_PORT = 8443;
var DEFAULT_COMMAND = "tailscale";
var TailscaleDiscovery = class {
  prefix;
  port;
  scheme;
  command;
  predicate;
  execFile;
  constructor(opts = {}) {
    const port = opts.port ?? DEFAULT_PORT;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      throw new ConfigError(
        `TailscaleDiscovery.port must be a TCP port in 1..65535 (got ${port})`
      );
    }
    this.prefix = (opts.prefix ?? DEFAULT_PREFIX).toLowerCase();
    this.port = port;
    this.scheme = opts.scheme ?? "https";
    this.command = opts.command ?? DEFAULT_COMMAND;
    this.predicate = opts.predicate;
    this.execFile = opts.execFile;
  }
  async discover() {
    const exec = this.execFile ?? await loadExecFile();
    const stdout = await runTailscale(exec, this.command);
    const status = parseStatus(stdout);
    const peers = [];
    if (status.Peer) {
      for (const p of Object.values(status.Peer)) peers.push(p);
    }
    if (status.Self) peers.push(status.Self);
    const seen = /* @__PURE__ */ new Map();
    for (const p of peers) {
      if (!this.keep(p)) continue;
      const host = pickHost(p);
      if (!host) continue;
      const url = `${this.scheme}://${host}:${this.port}`;
      if (!seen.has(url)) seen.set(url, { url });
    }
    return Array.from(seen.values());
  }
  keep(p) {
    if (this.predicate) return this.predicate(p);
    const candidate = (p.HostName ?? p.DNSName ?? "").toLowerCase();
    return candidate.startsWith(this.prefix);
  }
};
function pickHost(p) {
  const dns = p.DNSName?.trim();
  if (dns) {
    const stripped = dns.replace(/\.$/, "");
    if (stripped) return stripped;
  }
  const h = p.HostName?.trim();
  return h ? h : void 0;
}
function parseStatus(raw) {
  try {
    const obj = JSON.parse(raw);
    if (obj === null || typeof obj !== "object") {
      throw new Error("not an object");
    }
    return obj;
  } catch (err) {
    throw new ConfigError(
      `TailscaleDiscovery: failed to parse \`tailscale status --json\` output: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
function runTailscale(exec, command) {
  return new Promise((resolve, reject) => {
    try {
      exec(command, ["status", "--json"], (err, stdout, stderr) => {
        if (err) {
          const code = err.code;
          if (code === "ENOENT") {
            reject(
              new ConfigError(
                `TailscaleDiscovery: \`${command}\` not found on PATH. Install the Tailscale CLI (https://tailscale.com/download) or pass \`command\` with an absolute path.`
              )
            );
            return;
          }
          reject(
            new ConfigError(
              `TailscaleDiscovery: \`${command} status --json\` failed: ${err.message}${stderr ? ` \u2014 stderr: ${stderr.trim()}` : ""}`
            )
          );
          return;
        }
        resolve(stdout);
      });
    } catch (err) {
      reject(
        new ConfigError(
          `TailscaleDiscovery: unable to spawn \`${command}\`: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    }
  });
}
async function loadExecFile() {
  try {
    const spec = "node:child_process";
    const mod = await import(spec);
    if (typeof mod.execFile !== "function") {
      throw new Error("child_process.execFile is unavailable");
    }
    return mod.execFile;
  } catch (err) {
    throw new ConfigError(
      `TailscaleDiscovery requires Node's \`child_process\` module, which is unavailable in this runtime: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AuthError,
  CognitumError,
  ConfigError,
  ConflictError,
  ExplicitDiscovery,
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
  TailscaleDiscovery,
  TimeoutError,
  TlsPinError,
  TrustScoreBlockedError,
  UnsupportedError,
  ValidationError,
  normaliseBaseUrl,
  pairAll,
  startHealthProbe
});
//# sourceMappingURL=index.cjs.map