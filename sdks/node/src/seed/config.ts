import { ConfigError } from "../errors.js";

/**
 * Seed client configuration — Phase 1 accepts a single endpoint (string)
 * or a 1-element array. Mesh mode (multiple endpoints + routing/failover)
 * lands in Phase 1.5 with ADR-0016 and a tracking issue.
 *
 * The shape below locks the mesh API surface; unsupported values throw
 * `ConfigError` at construction so misconfiguration fails fast.
 */

/** Single endpoint form; canonical host `https://cognitum.local:8443`. */
export type SeedEndpoint = string;

/** A token book maps a logical identity → pairing-token (Phase 1.5). */
export interface TokenBook {
  [clientName: string]: string;
}

export interface SeedAuthOptions {
  /** Raw pairing-token string (single-identity mode). */
  pairingToken?: string | TokenBook;
  /** Legacy / cloud-bridge API key. Not used by the seed itself. */
  apiKey?: string;
}

export interface SeedTlsOptions {
  /** Custom CA PEM (string or Buffer) for non-pinned hosts. */
  ca?: Buffer | string;
  /** Dev-only: disable TLS verification. Logs a one-time warning. */
  insecure?: boolean;
}

export type SeedRouting =
  | "pinned"
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
   * In Phase 1, a list of length > 1 throws `ConfigError`.
   */
  endpoints: SeedEndpoint | SeedEndpoint[];
  auth?: SeedAuthOptions;
  tls?: SeedTlsOptions;
  /** Routing strategy across peers. Phase 1: "pinned" only. */
  routing?: SeedRouting;
  failover?: SeedFailoverOptions;
  timeouts?: SeedTimeoutOptions;
  /** Max retry attempts beyond the first. Default 3 per ADR-0005. */
  retries?: number;
  /** Honour 429 `Retry-After` + `retry_after_us` and retry. Default true. */
  rateLimitRetry?: boolean;
  /** Test-only: inject a custom `fetch` (e.g. vitest mock). */
  fetch?: typeof fetch;
  /** Optional logger — receives redacted records. */
  logger?: { warn?: (msg: string) => void; debug?: (rec: unknown) => void };
}

/** Resolved, validated, defaulted config — consumed by SeedClient internals. */
export interface ResolvedSeedConfig {
  baseUrl: string;
  pairingToken: string | undefined;
  apiKey: string | undefined;
  tls: { ca: Buffer | string | undefined; insecure: boolean };
  routing: SeedRouting;
  failover: Required<SeedFailoverOptions>;
  timeouts: Required<SeedTimeoutOptions>;
  retries: number;
  rateLimitRetry: boolean;
  fetchFn: typeof fetch;
  logger: { warn?: (msg: string) => void; debug?: (rec: unknown) => void };
}

const PHASE_1_5_MSG =
  "mesh mode (multiple endpoints) lands in Phase 1.5 — track issue #TBD";

/**
 * Validate and default a raw `SeedClientOptions` into a `ResolvedSeedConfig`.
 * Throws `ConfigError` on anything Phase 1 cannot yet honour.
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
  if (endpointList.length > 1) {
    throw new ConfigError(PHASE_1_5_MSG);
  }

  const raw = endpointList[0];
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ConfigError("endpoint must be a non-empty URL string");
  }
  const baseUrl = normaliseBaseUrl(raw);

  // Token book → Phase 1.5. In Phase 1 only a raw string token is honoured.
  let pairingToken: string | undefined;
  if (opts.auth?.pairingToken !== undefined) {
    if (typeof opts.auth.pairingToken === "string") {
      pairingToken = opts.auth.pairingToken;
    } else {
      throw new ConfigError(
        "TokenBook (per-peer pairing tokens) lands in Phase 1.5 — pass a string for now",
      );
    }
  } else if (typeof process !== "undefined" && process.env?.COGNITUM_SEED_TOKEN) {
    pairingToken = process.env.COGNITUM_SEED_TOKEN;
  }

  const routing: SeedRouting = opts.routing ?? "pinned";
  if (routing !== "pinned") {
    throw new ConfigError(
      `routing="${routing}" lands in Phase 1.5 — only "pinned" is supported`,
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
    onConnectError: opts.failover?.onConnectError ?? "retry-same",
    onStatus5xx: opts.failover?.onStatus5xx ?? "retry-same",
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
