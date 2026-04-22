/**
 * SeedClient — Phase 1.5 mesh-aware implementation. Composes `config.ts`,
 * `peers.ts`, `tokenBook.ts`, `session.ts`, `health.ts`, `transport.ts`,
 * `retry.ts`, and the ADR-0004 error taxonomy in `../errors.ts`.
 *
 * Failover state machine (ADR-0016a §D3, ADR-0017 §Step 4):
 * NetworkError / TimeoutError / 500 / 502 / 503 / 504 → mark peer, cycle
 * via `PeerSet.nextAfter`, else fall through to ADR-0005 retry. 429 → pin
 * on the same peer, honour `Retry-After` / `retry_after_us`, apply
 * equal-jitter backoff (trust-score protection — do NOT cycle). 4xx
 * auth / validation / not-found / 501 → surface immediately. The 60 s
 * total-elapsed budget covers ALL peer attempts combined — N peers × M
 * retries is NOT allowed (invariant I10).
 */

import {
  CognitumError,
  NetworkError,
  ParseError,
  RateLimitError,
  ServiceUnavailableError,
  TimeoutError,
} from "../errors.js";
import {
  resolveSeedConfig,
  type ResolvedSeedConfig,
  type SeedClientOptions,
} from "./config.js";
import { classifyErrorResponse, type DispatchOutcome } from "./dispatch.js";
import { startHealthProbe, type HealthProbeHandle } from "./health.js";
import { PeerSet, type Peer } from "./peers.js";
import { buildSeedFetch } from "./transport.js";
import { BASE_MS, CAP_MS, DEFAULT_MAX_ELAPSED_MS } from "./retry.js";
import { SeedSession } from "./session.js";
import {
  InMemoryTokenBook,
  SecretString,
  type TokenBook,
} from "./tokenBook.js";

import { makeStatusResource, type StatusResource } from "./resources/status.js";
import {
  makeIdentityResource,
  type IdentityResource,
} from "./resources/identity.js";
import { makePairResource, type PairResource } from "./resources/pair.js";
import {
  makeWitnessResource,
  type WitnessResource,
} from "./resources/witness.js";
import {
  makeCustodyResource,
  type CustodyResource,
} from "./resources/custody.js";
import { makeStoreResource, type StoreResource } from "./resources/store.js";
import { makeOtaResource, type OtaResource } from "./resources/ota.js";

/** Options passed to {@link SeedClient.request} per call. */
export interface SeedRequestOptions {
  /** JSON body to serialise; omit for GET/DELETE. */
  body?: unknown;
  /** Extra query parameters. */
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * Idempotency hint — GETs, HEADs, and read-only POSTs (e.g. k-NN
   * search) set this to `true` so the retry loop will retry read
   * timeouts. Non-idempotent POSTs (e.g. `pair`, `ingest`) set it
   * to `false` (the default for POSTs).
   */
  idempotent?: boolean;
  /** Timeout override for this request (ms). */
  timeoutMs?: number;
  /**
   * Pin this one request to `peerKey` (canonical URL, no trailing
   * slash). Used by {@link SeedSession}; the failover state machine
   * still cycles when the pinned peer hard-fails.
   */
  pinnedPeerKey?: string;
}

/**
 * Phase 1.5 seed client — supports 1..N peers with closest-first
 * routing + failover state machine.
 *
 * @example
 * ```ts
 * import { SeedClient } from "@cognitum/sdk/seed";
 *
 * const client = new SeedClient({
 *   endpoints: ["https://seed-a:8443", "https://seed-b:8443"],
 *   auth: { pairingToken: process.env.COGNITUM_SEED_TOKEN },
 *   tls: { insecure: true }, // dev only
 *   healthInterval: 30_000,  // opt-in active probe
 * });
 *
 * // Mesh-aware read:
 * const status = await client.status();
 *
 * // Session pins both to the same peer:
 * const session = client.session();
 * await session.store.ingest({ vectors: [{ values: [1,2,3] }] });
 * await session.store.query({ vector: [1,2,3], k: 1 });
 *
 * client.close(); // stop active health probe, if any
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

  /** Peer set — closest-first picker with per-peer health state. */
  private readonly peerSet: PeerSet;
  /** Per-peer pairing-token store. */
  private readonly tokenBook: TokenBook;
  /** TLS-aware fetch bound to this client. */
  private readonly fetchFn: typeof fetch;
  /** Active health-probe handle; `undefined` when disabled. */
  private readonly healthProbe: HealthProbeHandle | undefined;

  constructor(options: SeedClientOptions) {
    this.config = resolveSeedConfig(options);
    this.peerSet = new PeerSet(this.config.endpoints);

    // Prefer the caller-supplied TokenBook. Fall back to a fresh
    // InMemoryTokenBook seeded from the client-wide `pairingToken`
    // (ADR-0016a §D5 "single token for all peers when the caller
    // asserts they share").
    this.tokenBook = this.config.tokenBook ?? new InMemoryTokenBook();
    if (this.config.pairingToken !== undefined) {
      const shared = new SecretString(this.config.pairingToken);
      for (const peer of this.peerSet.iter()) {
        if (this.tokenBook.get(peer.key) === undefined) {
          this.tokenBook.set(peer.key, shared);
        }
      }
    }

    this.fetchFn = buildSeedFetch(this.config);

    // Bind the resource bundles. Each wraps `request()` so every call
    // passes through the failover pipeline.
    const req = this.request.bind(this);
    this.status = makeStatusResource(req);
    this.identity = makeIdentityResource(req);
    this.pair = makePairResource(req);
    this.witness = makeWitnessResource(req);
    this.custody = makeCustodyResource(req);
    this.store = makeStoreResource(req);
    this.ota = makeOtaResource(req);

    // Opt-in active health probe (ADR-0016a §D7). Starts a `setInterval`
    // that `unref`'s itself so it never keeps the process alive.
    if (this.config.healthInterval !== undefined) {
      this.healthProbe = startHealthProbe({
        peers: this.peerSet,
        fetchFn: this.fetchFn,
        intervalMs: this.config.healthInterval,
        tokenForPeer: (peerKey) => {
          const tok = this.tokenBook.get(peerKey);
          return tok?.reveal();
        },
      });
    }
  }

  /**
   * Snapshot view of the SDK-local peer table (ADR-0016a §D7 —
   * `client.peers()`). The returned array is a shallow copy; mutations
   * do not affect routing.
   */
  peers(): Peer[] {
    return this.peerSet.snapshot();
  }

  /**
   * Open a {@link SeedSession} pinned to the currently closest-first
   * peer. The session holds the pin for its lifetime; all its resource
   * calls go to the same peer unless the peer hard-fails, in which case
   * the failover state machine transparently cycles.
   */
  session(): SeedSession {
    return new SeedSession(this, this.peerSet.pick().key);
  }

  /**
   * Stop the active health probe (if any) so the Node event loop can
   * exit cleanly. Idempotent — safe to call more than once.
   *
   * Does NOT revoke pairing or wipe the TokenBook; callers own token
   * lifetimes per ADR-0007.
   */
  close(): void {
    this.healthProbe?.stop();
  }

  /**
   * Introspection helper for tests: look up a pairing token by
   * canonical peer URL. Returns `undefined` when the book has no entry.
   * @internal
   */
  tokenForPeer(peerKey: string): string | undefined {
    return this.tokenBook.get(peerKey)?.reveal();
  }

  /**
   * Perform an HTTP request against the seed mesh and return the parsed
   * JSON body. Implements the Phase 1.5 failover state machine.
   */
  async request<T>(
    method: string,
    path: string,
    opts: SeedRequestOptions = {},
  ): Promise<T> {
    const methodUpper = method.toUpperCase();
    const idempotent =
      opts.idempotent ?? (methodUpper === "GET" || methodUpper === "HEAD");
    const totalBudgetMs =
      this.config.timeouts.total ?? DEFAULT_MAX_ELAPSED_MS;
    const startedAt = Date.now();

    // Resolve the initial peer. When the caller pinned a specific peer
    // (session mode) and it's present, use it; otherwise let `pick`
    // choose the closest-first healthy peer.
    let peer: Peer = this.initialPeer(opts.pinnedPeerKey);

    const totalPeers = this.peerSet.len();
    let peersTried = 0;
    let retryAttempt = 0;
    let lastErr: CognitumError | undefined;

    for (;;) {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= totalBudgetMs) {
        throw (
          lastErr ??
          new TimeoutError(
            "read",
            `seed: total deadline ${totalBudgetMs}ms exceeded at ${path}`,
          )
        );
      }

      const attemptBudgetMs = Math.max(1, totalBudgetMs - elapsed);
      const attemptTimeoutMs = Math.min(
        opts.timeoutMs ?? this.config.timeouts.read,
        attemptBudgetMs,
      );

      const outcome = await this.dispatchOnce<T>(
        methodUpper,
        path,
        peer,
        opts,
        attemptTimeoutMs,
      );

      // -- success --------------------------------------------------------
      if (outcome.kind === "ok") {
        return outcome.value;
      }

      // -- classify for PeerSet bookkeeping --------------------------------
      if (outcome.peerClass !== undefined) {
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
          // All peers tried at least once — fall through to the ADR-0005
          // retry loop on the most recent peer.
          if (this.shouldBackoffRetry(outcome.error, methodUpper, idempotent)) {
            const delayMs = this.backoffDelay(
              retryAttempt,
              outcome.retryHintMs,
            );
            if (Date.now() - startedAt + delayMs > totalBudgetMs) {
              throw outcome.error;
            }
            if (retryAttempt + 1 > this.config.retries) {
              throw outcome.error;
            }
            await sleep(delayMs);
            retryAttempt += 1;
            peersTried = 0; // new budget round across the mesh
            peer = this.initialPeer(opts.pinnedPeerKey);
            continue;
          }
          throw outcome.error;
        }
        case "pin": {
          // 429 — stay on the same peer, honour ADR-0005 budget.
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

  private initialPeer(pinnedKey: string | undefined): Peer {
    if (pinnedKey) {
      const pinned = this.peerSet.findByKey(pinnedKey);
      if (pinned) return pinned;
    }
    return this.peerSet.pick();
  }

  private shouldBackoffRetry(
    err: CognitumError,
    method: string,
    idempotent: boolean,
  ): boolean {
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
      if (sc !== undefined && sc >= 500 && sc !== 501) return true;
    }
    return false;
  }

  private backoffDelay(attempt: number, hintMs: number | undefined): number {
    const expo = BASE_MS * 2 ** attempt;
    const jitter = Math.random() * BASE_MS; // equal-jitter (ADR-0005)
    const computed = Math.min(CAP_MS, expo + jitter);
    if (hintMs !== undefined) {
      return Math.min(CAP_MS, Math.max(computed, hintMs));
    }
    return computed;
  }

  private async dispatchOnce<T>(
    method: string,
    path: string,
    peer: Peer,
    opts: SeedRequestOptions,
    attemptTimeoutMs: number,
  ): Promise<DispatchOutcome<T>> {
    const url = buildUrl(peer.baseUrl, path, opts.query);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "cognitum-sdk-node/0.2.0-seed-phase1.5",
    };

    // Per-peer token wins over the client-wide fallback (ADR-0016a §D5).
    const tok = this.tokenBook.get(peer.key);
    if (tok) {
      headers["X-Pairing-Token"] = tok.reveal();
    }
    if (this.config.apiKey) {
      headers["X-API-Key"] = this.config.apiKey;
    }

    const init: RequestInit & { duplex?: string } = { method, headers };
    if (opts.body !== undefined && method !== "GET" && method !== "HEAD") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    init.signal = controller.signal;

    const callStarted = Date.now();
    let response: Response;
    try {
      response = await this.fetchFn(url, init);
    } catch (err) {
      clearTimeout(timer);
      if (isAbortError(err)) {
        const e = new TimeoutError(
          "read",
          `timeout after ${attemptTimeoutMs}ms at ${path}`,
        );
        return {
          kind: "err",
          disposition: "cycle",
          peerClass: "timeout",
          error: e,
        };
      }
      const e = new NetworkError(
        err instanceof Error ? err.message : String(err),
        err,
      );
      return {
        kind: "err",
        disposition: "cycle",
        peerClass: "network",
        error: e,
      };
    }
    clearTimeout(timer);

    if (response.ok) {
      const value =
        response.status === 204 ? (undefined as T) : await parseJson<T>(response);
      this.peerSet.markSuccess(peer.key, Date.now() - callStarted);
      return { kind: "ok", value };
    }

    // Non-2xx → map to the taxonomy + decide disposition.
    return classifyErrorResponse<T>(response, path);
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
    throw new ParseError(
      "JSON",
      `invalid JSON in ${res.status} response: ${(err as Error).message}`,
    );
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  ) {
    return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
