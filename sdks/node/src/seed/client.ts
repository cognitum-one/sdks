/**
 * SeedClient — Phase 1 single-seed implementation.
 *
 * Layered on:
 *   - `config.ts`    — options validation + defaults
 *   - `transport.ts` — TLS-aware `fetch` wrapper
 *   - `retry.ts`     — equal-jitter backoff loop (ADR-0005)
 *   - `errors.ts`    — cross-SDK taxonomy (ADR-0004)
 *
 * Resource bindings (`resources/*`) are instantiated eagerly so method
 * chains like `client.pair.status()` Just Work without async deferment.
 */

import {
  AuthError,
  CognitumError,
  ConflictError,
  NetworkError,
  NotFoundError,
  NotImplementedError,
  ParseError,
  RateLimitError,
  ServiceUnavailableError,
  TimeoutError,
  ValidationError,
} from "../errors.js";
import {
  resolveSeedConfig,
  type ResolvedSeedConfig,
  type SeedClientOptions,
} from "./config.js";
import { singlePeer, type Peer } from "./peers.js";
import { buildSeedFetch } from "./transport.js";
import {
  DEFAULT_MAX_ELAPSED_MS,
  parseRetryAfterHeader,
  parseSeedRetryAfter,
  runWithRetry,
} from "./retry.js";

import { makeStatusResource, type StatusResource } from "./resources/status.js";
import { makeIdentityResource, type IdentityResource } from "./resources/identity.js";
import { makePairResource, type PairResource } from "./resources/pair.js";
import { makeWitnessResource, type WitnessResource } from "./resources/witness.js";
import { makeCustodyResource, type CustodyResource } from "./resources/custody.js";
import { makeStoreResource, type StoreResource } from "./resources/store.js";
import { makeOtaResource, type OtaResource } from "./resources/ota.js";

/** Options passed to `SeedClient.request()` per call. */
export interface SeedRequestOptions {
  /** JSON body to serialise; omit for GET/DELETE. */
  body?: unknown;
  /** Extra query parameters. */
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * Idempotency hint — GETs, HEADs, and read-only POSTs (e.g. k-NN
   * search) set this to `true` so the retry loop will retry read
   * timeouts. Non-idempotent POSTs (e.g. `pair`, `ingest`) set it
   * to `false` (the default).
   */
  idempotent?: boolean;
  /** Timeout override for this request (ms). */
  timeoutMs?: number;
}

/**
 * The Phase 1 seed client — single-endpoint, no mesh failover.
 *
 * @example
 * ```ts
 * import { SeedClient } from "@cognitum/sdk/seed";
 *
 * const client = new SeedClient({
 *   endpoints: "https://localhost:18443",
 *   auth: { pairingToken: process.env.COGNITUM_SEED_TOKEN },
 *   tls: { insecure: true },          // dev only — use ca: in prod
 * });
 *
 * const status = await client.status();
 * console.log(status.device_id, status.paired);
 * ```
 */
export class SeedClient {
  /** Resolved config (read-only snapshot). */
  readonly config: ResolvedSeedConfig;

  /** GET /api/v1/status */
  readonly status: StatusResource;
  /** GET /api/v1/identity */
  readonly identity: IdentityResource;
  /** Pairing — create / status / delete. */
  readonly pair: PairResource;
  /** GET /api/v1/witness/chain + related. */
  readonly witness: WitnessResource;
  /** GET /api/v1/custody/epoch. */
  readonly custody: CustodyResource;
  /** Vector store — status / query / ingest. */
  readonly store: StoreResource;
  /** OTA — config + check-now. */
  readonly ota: OtaResource;

  /** Peer list (always length 1 in Phase 1). */
  private readonly peers: Peer[];
  /** TLS-aware fetch bound to this client. */
  private readonly fetchFn: typeof fetch;

  constructor(options: SeedClientOptions) {
    this.config = resolveSeedConfig(options);
    this.peers = singlePeer(this.config.baseUrl, this.config.pairingToken);
    this.fetchFn = buildSeedFetch(this.config);

    // Bind the resource bundles. Each is a plain object literal of
    // functions so there's zero class-instance overhead per request.
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
  async request<T>(
    method: string,
    path: string,
    opts: SeedRequestOptions = {},
  ): Promise<T> {
    const peer = this.peers[0];
    const url = buildUrl(peer.baseUrl, path, opts.query);

    // Normalize method once per request; hot path used to call
    // `method.toUpperCase()` 4x (perf-note: was a no-op on GETs but
    // measurable for POSTs with long method strings).
    const methodUpper = method.toUpperCase();
    const idempotent =
      opts.idempotent ?? (methodUpper === "GET" || methodUpper === "HEAD");

    return runWithRetry(
      async () => this.singleAttempt<T>(methodUpper, url, path, peer, opts),
      {
        retries: this.config.retries,
        maxElapsedMs: this.config.timeouts.total ?? DEFAULT_MAX_ELAPSED_MS,
        rateLimitRetry: this.config.rateLimitRetry,
        method: methodUpper,
        idempotent,
        logger: this.config.logger,
      },
      path,
    );
  }

  private async singleAttempt<T>(
    method: string,
    url: string,
    pathForLog: string,
    peer: Peer,
    opts: SeedRequestOptions,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "cognitum-sdk-node/0.2.0-seed-phase1",
    };
    if (peer.pairingToken) {
      headers["X-Pairing-Token"] = peer.pairingToken;
    }
    if (this.config.apiKey) {
      headers["X-API-Key"] = this.config.apiKey;
    }

    const init: RequestInit & { duplex?: string } = { method, headers };
    // `method` here is already upper-cased by `request()` above.
    if (opts.body !== undefined && method !== "GET" && method !== "HEAD") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    const timeoutMs = opts.timeoutMs ?? this.config.timeouts.read;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    init.signal = controller.signal;

    let response: Response;
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
        err,
      );
    }
    clearTimeout(timer);

    if (response.ok) {
      if (response.status === 204) return undefined as T;
      return (await parseJson<T>(response)) as T;
    }

    // Non-2xx — map to the taxonomy.
    throw await this.mapHttpError(response, pathForLog);
  }

  /** Translate an HTTP error response into an ADR-0004 `CognitumError`. */
  private async mapHttpError(res: Response, pathForLog: string): Promise<CognitumError> {
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
        const retryAfterMs = headerHint ?? bodyHint ?? 1000;
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
          // Generic 5xx — map to ServiceUnavailableError so the retry
          // loop classifies it as retryable per ADR-0005.
          return new ServiceUnavailableError(undefined, `HTTP ${res.status}: ${message}`);
        }
        return new CognitumError(`HTTP ${res.status}: ${message}`, "API_ERROR", res.status);
    }
  }
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const joined = `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
  if (!query) return joined;
  const entries = Object.entries(query).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return joined;
  const qs = entries
    .map(
      ([k, v]) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
    )
    .join("&");
  return `${joined}${joined.includes("?") ? "&" : "?"}${qs}`;
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new ParseError("JSON", `invalid JSON in ${res.status} response: ${(err as Error).message}`);
  }
}

function tryJson(body: string): unknown {
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function extractMessage(parsed: unknown): string | undefined {
  if (parsed && typeof parsed === "object") {
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.error === "string") return rec.error;
    if (typeof rec.message === "string") return rec.message;
  }
  return undefined;
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return true;
  }
  return false;
}
