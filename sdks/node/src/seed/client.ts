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
  AuthError,
  CognitumError,
  ConfigError,
  NetworkError,
  ParseError,
  RateLimitError,
  ServiceUnavailableError,
  TimeoutError,
  TrustScoreBlockedError,
  UnsupportedError,
} from "../errors.js";
import type { CallOptions } from "./callOptions.js";
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
import { makeMeshResource, type MeshResource } from "./resources/mesh.js";

/** Options passed to {@link SeedClient.request} per call. */
export interface SeedRequestOptions extends CallOptions {
  /** JSON body to serialise; omit for GET/DELETE. */
  body?: unknown;
  /** Extra query parameters. */
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * Pin this one request to `peerKey` (canonical URL, no trailing
   * slash). Used by {@link SeedSession}; the failover state machine
   * still cycles when the pinned peer hard-fails. Distinct from the
   * {@link CallOptions.peer} per-call override — `pinnedPeerKey` is
   * set by the session handle and silently no-ops when the peer isn't
   * in the set, whereas `peer` is caller-facing and throws
   * {@link ConfigError} when the peer is unknown.
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
  /**
   * Mesh observability — `status()`, `peers()`, `swarmStatus()`,
   * `clusterHealth()` (ADR-0016a §D8). Read-only; all four are on the
   * seed's WiFi-read allowlist so no pairing token is needed.
   */
  readonly mesh: MeshResource;

  /** Peer set — closest-first picker with per-peer health state. */
  private readonly peerSet: PeerSet;
  /** Per-peer pairing-token store. */
  private readonly tokenBook: TokenBook;
  /** TLS-aware fetch bound to this client. */
  private readonly fetchFn: typeof fetch;
  /** Active health-probe handle; `undefined` when disabled. */
  private readonly healthProbe: HealthProbeHandle | undefined;
  /**
   * Per-peer consecutive-AuthError counter — ADR-0007 §"Trust-score
   * protection", closes cognitum-one/sdks#16. The seed locks a client
   * out after 3 failed auth attempts; we abort on the 3rd so the caller
   * never burns the seed's budget. Reset to 0 on any 2xx from the same
   * peer, or explicitly via {@link SeedClient.resetTrustScore}.
   */
  private readonly authFailures: Map<string, number> = new Map();
  /** Trust-score threshold — 3 consecutive auth failures triggers block. */
  private static readonly TRUST_SCORE_LIMIT = 3;

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
    this.mesh = makeMeshResource(req);

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
   * Phase 2 placeholder: when mDNS discovery lands (ADR-0016a §D6),
   * this method will also re-run discovery; for now it only resets the
   * in-memory peer state.
   */
  rediscover(): void {
    this.peerSet.resetAll();
    this.authFailures.clear();
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
   * Clear the trust-score counter for a single peer (or, with no
   * argument, every peer). Call this after the caller has rotated the
   * pairing token or otherwise resolved the auth failure that triggered
   * the block — without a reset, the client will keep refusing further
   * requests to that peer to protect the seed's trust-score budget.
   *
   * @param peerKey — canonical peer URL to clear. If omitted, clears
   *   every peer's counter.
   */
  resetTrustScore(peerKey?: string): void {
    if (peerKey === undefined) {
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
  trustScoreFailures(peerKey: string): number {
    return this.authFailures.get(peerKey) ?? 0;
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
    // -- per-call knobs (ADR-0016b §"Per-call knobs") --------------------
    // Reject unsupported consistency modes up-front. "strong" throws per
    // ADR-0016a §D4 (no quorum protocol on seed today). "eventual" has no
    // dispatch-side effect beyond suppressing session-stickiness, which
    // we handle by ignoring `pinnedPeerKey` below.
    if (opts.consistency === "strong") {
      throw new UnsupportedError(
        "consistency=strong",
        "strong consistency unsupported; seed has no quorum protocol today",
      );
    }

    // Validate `opts.peer`: if the caller named a peer that isn't in the
    // set, fail loudly — cycling to a different peer would silently change
    // the semantics the caller asked for.
    let explicitPeer: Peer | undefined;
    if (opts.peer !== undefined) {
      explicitPeer = this.peerSet.findByKey(opts.peer);
      if (!explicitPeer) {
        throw new ConfigError(`peer not in mesh: ${opts.peer}`);
      }
    }

    const methodUpper = method.toUpperCase();
    const idempotent =
      opts.idempotent ?? (methodUpper === "GET" || methodUpper === "HEAD");
    const totalBudgetMs =
      this.config.timeouts.total ?? DEFAULT_MAX_ELAPSED_MS;

    // Per-call `retries: null` → no retries at all; `retries: number` →
    // override the client-wide default; undefined → client default.
    const retriesBudget =
      opts.retries === null
        ? 0
        : typeof opts.retries === "number"
          ? opts.retries
          : this.config.retries;

    // Pre-compute the per-call prefer ordering so the failover loop can
    // walk it deterministically (used only when `opts.peer` is unset).
    const preferOrder: Peer[] | undefined =
      explicitPeer === undefined && opts.prefer !== undefined
        ? this.peerSet.preferOrder(opts.prefer)
        : undefined;
    let preferCursor = 0;

    const startedAt = Date.now();

    // Serialise the JSON body ONCE per `request()` call (issue #23). The
    // retry loop re-dispatches on the same body up to `this.config.retries`
    // times; re-stringifying on every attempt is pure waste (CPU + GC) and
    // becomes measurable on vector-ingest payloads (10-100 KB). GET/HEAD
    // never carry a body, so skip the work entirely.
    const hasBody =
      opts.body !== undefined &&
      methodUpper !== "GET" &&
      methodUpper !== "HEAD";
    const bodyStr: string | undefined = hasBody
      ? JSON.stringify(opts.body)
      : undefined;

    // Resolve the initial peer.
    //
    // Precedence (highest first):
    //   1. explicit per-call `peer:` override — already validated above.
    //   2. per-call `prefer:` ordering — walk `preferOrder[0]` first.
    //   3. session `pinnedPeerKey` — unless `consistency === "eventual"`,
    //      which explicitly opts out of session-stickiness.
    //   4. `pick()` — default closest-first.
    let peer: Peer;
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

      // -- trust-score gate (ADR-0007, issue #16) -------------------------
      // If this peer has already hit the threshold, abort before we
      // send another auth-bearing request that would burn the seed's
      // trust-score budget. This is checked BEFORE dispatch so that
      // even the first call after a prior block surfaces the typed
      // error immediately.
      if (
        (this.authFailures.get(peer.key) ?? 0) >= SeedClient.TRUST_SCORE_LIMIT
      ) {
        throw new TrustScoreBlockedError(peer.key);
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
        bodyStr,
      );

      // -- success --------------------------------------------------------
      if (outcome.kind === "ok") {
        // 2xx from this peer clears any prior auth-failure streak.
        this.authFailures.delete(peer.key);
        return outcome.value;
      }

      // -- trust-score bookkeeping on AuthError ---------------------------
      // Count consecutive auth failures per-peer. On the 3rd, swap the
      // thrown error for TrustScoreBlockedError so the failover state
      // machine does NOT cycle — cycling would burn the next peer's
      // budget too. Per-peer isolation: a 401 on peer-A does not count
      // against peer-B.
      if (outcome.error instanceof AuthError) {
        const next = (this.authFailures.get(peer.key) ?? 0) + 1;
        this.authFailures.set(peer.key, next);
        if (next >= SeedClient.TRUST_SCORE_LIMIT) {
          throw new TrustScoreBlockedError(peer.key);
        }
      }

      // -- classify for PeerSet bookkeeping --------------------------------
      if (outcome.peerClass !== undefined) {
        this.peerSet.markFailure(peer.key, outcome.peerClass);
      }

      lastErr = outcome.error;

      switch (outcome.disposition) {
        case "cycle": {
          // Explicit per-call `peer:` means the caller opted OUT of
          // cycling — do not silently redirect to a different peer.
          if (explicitPeer) {
            throw outcome.error;
          }
          peersTried += 1;
          if (peersTried < totalPeers) {
            let next: Peer | undefined;
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
            if (retryAttempt + 1 > retriesBudget) {
              throw outcome.error;
            }
            await sleep(delayMs);
            retryAttempt += 1;
            peersTried = 0; // new budget round across the mesh
            preferCursor = preferOrder ? 1 : 0;
            peer = preferOrder
              ? preferOrder[0]
              : this.initialPeer(opts.pinnedPeerKey);
            continue;
          }
          throw outcome.error;
        }
        case "pin": {
          // 429 — stay on the same peer, honour ADR-0005 budget.
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
    bodyStr: string | undefined,
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
    if (bodyStr !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = bodyStr;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    // Chain the caller's abort signal, if supplied. Any fire on the
    // caller signal aborts this attempt the same way a timeout would —
    // the catch block classifies the outcome into a `NetworkError`.
    const callerSignal = opts.signal;
    const onCallerAbort = (): void => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) {
        controller.abort();
      } else {
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }
    init.signal = controller.signal;

    const callStarted = Date.now();
    let response: Response;
    try {
      response = await this.fetchFn(url, init);
    } catch (err) {
      clearTimeout(timer);
      if (callerSignal) {
        callerSignal.removeEventListener("abort", onCallerAbort);
      }
      // Caller-supplied abort wins over our own timeout — surface it as
      // a NetworkError with cause-chained signal, not a TimeoutError.
      if (callerSignal?.aborted) {
        const e = new NetworkError("request aborted by caller signal", err);
        return {
          kind: "err",
          disposition: "surface",
          peerClass: "network",
          error: e,
        };
      }
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
    if (callerSignal) {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }

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
