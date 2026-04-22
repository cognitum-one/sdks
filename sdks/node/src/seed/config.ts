import { ConfigError } from "../errors.js";
import type { TokenBook } from "./tokenBook.js";

/**
 * Seed client configuration.
 *
 * Phase 1.5 (2026-04-22) accepts 1..N endpoints and adds `tokenBook`,
 * `routing`, `failover`, and `healthInterval` options. A single endpoint
 * still behaves exactly like Phase 1 — the mesh code paths degenerate
 * to the old single-peer loop when `endpoints.length === 1`.
 */

/** Single endpoint form; canonical host `https://cognitum.local:8443`. */
export type SeedEndpoint = string;

/**
 * Inline multi-identity token map: `{ [clientName]: token }`. Supplied
 * via {@link SeedAuthOptions.pairingToken}; converted into the per-peer
 * {@link TokenBook} at resolution time if no explicit book is provided.
 *
 * Deprecated for Phase 1.5: prefer passing a full {@link TokenBook}
 * instance via {@link SeedClientOptions.tokenBook}. Kept for backwards
 * compatibility with Phase 1 test fixtures.
 */
export interface InlineTokenMap {
  [clientName: string]: string;
}

export interface SeedAuthOptions {
  /**
   * Raw pairing-token string (single-identity mode). When the caller
   * also supplies `tokenBook`, that book's per-peer entries take
   * priority and this acts as a fallback.
   */
  pairingToken?: string | InlineTokenMap;
  /** Legacy / cloud-bridge API key. Not used by the seed itself. */
  apiKey?: string;
}

export interface SeedTlsOptions {
  /** Custom CA PEM (string or Buffer) for non-pinned hosts. */
  ca?: Buffer | string;
  /** Dev-only: disable TLS verification. Logs a one-time warning. */
  insecure?: boolean;
}

/**
 * Routing strategy across peers (ADR-0016a §D2). Phase 1.5 ships
 * `"session"` (closest-first with session-stickiness) as the default;
 * explicit values pre-reserve the surface for future per-call knobs.
 */
export type SeedRouting =
  | "pinned"
  | "session"
  | "round-robin"
  | "read-any-write-one";

export interface SeedFailoverOptions {
  onConnectError?: "next-peer" | "retry-same";
  onStatus5xx?: "next-peer" | "retry-same" | "propagate";
}

export interface SeedTimeoutOptions {
  /** Per-attempt connect timeout (ms). Default 5000. */
  connect?: number;
  /** Per-attempt read timeout (ms). Default 30_000. */
  read?: number;
  /** Total elapsed budget (ms) across all attempts. Default 60_000 per ADR-0005. */
  total?: number;
}

export interface SeedClientOptions {
  /**
   * One endpoint (single-seed mode) or a list (mesh mode, Phase 1.5).
   * Order is preserved as the peer `listIndex` for tie-breaking in the
   * closest-first picker.
   */
  endpoints: SeedEndpoint | SeedEndpoint[];
  auth?: SeedAuthOptions;
  tls?: SeedTlsOptions;
  /**
   * Explicit per-peer {@link TokenBook}. When omitted, the client
   * allocates an {@link InMemoryTokenBook} and seeds it from
   * `auth.pairingToken` (if a string) for every peer.
   */
  tokenBook?: TokenBook;
  /** Routing strategy across peers. Default `"session"` (Phase 1.5). */
  routing?: SeedRouting;
  failover?: SeedFailoverOptions;
  timeouts?: SeedTimeoutOptions;
  /** Max retry attempts beyond the first. Default 3 per ADR-0005. */
  retries?: number;
  /** Honour 429 `Retry-After` + `retry_after_us` and retry. Default true. */
  rateLimitRetry?: boolean;
  /**
   * Active health-probe interval in milliseconds. Default: disabled.
   * When set, the client pings `GET /api/v1/status` on every peer on
   * this cadence (ADR-0016a §D7).
   */
  healthInterval?: number;
  /** Test-only: inject a custom `fetch` (e.g. vitest mock). */
  fetch?: typeof fetch;
  /** Optional logger — receives redacted records. */
  logger?: { warn?: (msg: string) => void; debug?: (rec: unknown) => void };
}

/** Resolved, validated, defaulted config — consumed by SeedClient internals. */
export interface ResolvedSeedConfig {
  /**
   * Normalised endpoint list in caller order. At least one element.
   * For single-endpoint mode the first element is also exposed as
   * {@link ResolvedSeedConfig.baseUrl}.
   */
  endpoints: string[];
  /**
   * Canonical single-peer URL — convenience accessor identical to
   * `endpoints[0]`. Kept so Phase 1 call-sites keep compiling.
   */
  baseUrl: string;
  /**
   * Client-wide fallback pairing token. When a per-peer `tokenBook`
   * entry exists it wins; this field is only consulted when the book
   * has no entry for the dispatching peer.
   */
  pairingToken: string | undefined;
  /**
   * Inline multi-identity map (legacy). Present only when the caller
   * passed `auth.pairingToken` as an object; the resolver does NOT
   * promote it to the `TokenBook` automatically — use `tokenBook`
   * for that.
   */
  pairingTokenMap: InlineTokenMap | undefined;
  apiKey: string | undefined;
  tls: { ca: Buffer | string | undefined; insecure: boolean };
  routing: SeedRouting;
  failover: Required<SeedFailoverOptions>;
  timeouts: Required<SeedTimeoutOptions>;
  retries: number;
  rateLimitRetry: boolean;
  /** Explicit token book (only when caller supplied one). */
  tokenBook: TokenBook | undefined;
  /** Active health-probe interval in ms, or `undefined` when disabled. */
  healthInterval: number | undefined;
  fetchFn: typeof fetch;
  logger: { warn?: (msg: string) => void; debug?: (rec: unknown) => void };
}

/**
 * Validate and default a raw `SeedClientOptions` into a `ResolvedSeedConfig`.
 * Throws `ConfigError` on malformed input. Multi-endpoint input is accepted
 * as of Phase 1.5; `routing` accepts `"pinned"` | `"session"` |
 * `"round-robin"` | `"read-any-write-one"` — unsupported values throw.
 */
export function resolveSeedConfig(opts: SeedClientOptions): ResolvedSeedConfig {
  if (!opts || typeof opts !== "object") {
    throw new ConfigError("SeedClient options are required");
  }
  if (opts.endpoints === undefined || opts.endpoints === null) {
    throw new ConfigError("`endpoints` is required");
  }

  const endpointList = Array.isArray(opts.endpoints)
    ? opts.endpoints
    : [opts.endpoints];

  if (endpointList.length === 0) {
    throw new ConfigError("at least one endpoint is required");
  }

  const endpoints: string[] = endpointList.map((raw, idx) => {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new ConfigError(
        `endpoints[${idx}] must be a non-empty URL string`,
      );
    }
    return normaliseBaseUrl(raw);
  });

  // Caller-supplied pairing token: string (client-wide fallback) or an
  // inline multi-identity map (legacy). The inline map is preserved
  // verbatim; callers wanting per-peer tokens MUST pass `tokenBook`.
  let pairingToken: string | undefined;
  let pairingTokenMap: InlineTokenMap | undefined;
  if (opts.auth?.pairingToken !== undefined) {
    if (typeof opts.auth.pairingToken === "string") {
      pairingToken = opts.auth.pairingToken;
    } else if (
      opts.auth.pairingToken !== null &&
      typeof opts.auth.pairingToken === "object"
    ) {
      pairingTokenMap = { ...opts.auth.pairingToken };
    } else {
      throw new ConfigError(
        "`auth.pairingToken` must be a string or { [clientName]: token } map",
      );
    }
  } else if (
    typeof process !== "undefined" &&
    process.env?.COGNITUM_SEED_TOKEN
  ) {
    pairingToken = process.env.COGNITUM_SEED_TOKEN;
  }

  const routing: SeedRouting = opts.routing ?? "session";
  if (
    routing !== "pinned" &&
    routing !== "session" &&
    routing !== "round-robin" &&
    routing !== "read-any-write-one"
  ) {
    throw new ConfigError(
      `routing="${routing}" is not recognised — expected "pinned" | "session" | "round-robin" | "read-any-write-one"`,
    );
  }

  const tls = {
    ca: opts.tls?.ca,
    insecure: Boolean(opts.tls?.insecure),
  };

  const timeouts = {
    connect: opts.timeouts?.connect ?? 5_000,
    read: opts.timeouts?.read ?? 30_000,
    total: opts.timeouts?.total ?? 60_000,
  };

  const failover: Required<SeedFailoverOptions> = {
    onConnectError: opts.failover?.onConnectError ?? "next-peer",
    onStatus5xx: opts.failover?.onStatus5xx ?? "next-peer",
  };

  let healthInterval: number | undefined;
  if (opts.healthInterval !== undefined) {
    if (
      typeof opts.healthInterval !== "number" ||
      !Number.isFinite(opts.healthInterval) ||
      opts.healthInterval <= 0
    ) {
      throw new ConfigError(
        `healthInterval must be a positive number of ms (got ${opts.healthInterval})`,
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
    logger: opts.logger ?? {},
  };
}

function normaliseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`invalid endpoint URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(
      `endpoint must use http(s); got ${url.protocol}${url.host}`,
    );
  }
  // Strip trailing slash; we append `/api/v1/...` paths.
  return url.toString().replace(/\/+$/, "");
}

// Keep the alias type exported so downstream call-sites that imported
// `TokenBook` from `config.ts` keep compiling. The real interface now
// lives in `tokenBook.ts`.
export type { TokenBook };
