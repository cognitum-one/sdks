/**
 * Peer set management (Phase 1.5).
 *
 * ADR-0016a §D2 / §D7: a [`PeerSet`] of one or more peers with per-peer
 * health / latency tracking. `pick()` selects the "closest-first" peer;
 * `nextAfter(failed)` supplies the next candidate for the failover state
 * machine in `SeedClient.request()`.
 *
 * Kept deliberately free of HTTP concerns — the client layer records
 * outcomes via `markSuccess` / `markFailure`, and this module just
 * maintains the ordering invariants.
 */

import { ConfigError } from "../errors.js";

/** Routing-layer peer health state (ADR-0016a §D7). */
export type PeerState = "healthy" | "degraded" | "unhealthy";

/**
 * Error class observed on a peer-level request outcome. Informs the
 * failure bookkeeping in [`PeerSet.markFailure`].
 */
export type PeerErrorClass =
  | "network"
  | "timeout"
  | "server5xx"
  | "serviceUnavailable";

function stateRank(state: PeerState): number {
  switch (state) {
    case "healthy":
      return 0;
    case "degraded":
      return 1;
    case "unhealthy":
      return 2;
  }
}

/** One configured seed endpoint plus its latency / health state. */
export interface Peer {
  /** Constructor-order index (stable regardless of sort order). */
  readonly listIndex: number;
  /** Normalised base URL (no trailing slash). */
  readonly baseUrl: string;
  /** Canonical key (same as `baseUrl` today; kept distinct for clarity). */
  readonly key: string;
  /** Short `host:port` label for logs. */
  readonly label: string;
  /** Routing-layer health state. */
  state: PeerState;
  /**
   * Exponential moving average of observed latency in ms. `undefined`
   * until the first successful observation.
   */
  latencyEmaMs: number | undefined;
  /** Timestamp (ms since epoch) of the last dispatch attempt. */
  lastUsedAt: number | undefined;
  /** Consecutive failures — degraded at >=1, unhealthy at >=3. */
  consecutiveFailures: number;
}

/** Internal mutable peer representation. Exported `Peer` is the same shape. */
type MutablePeer = Peer;

function makePeer(listIndex: number, rawUrl: string): MutablePeer {
  const normalised = normaliseBaseUrl(rawUrl);
  return {
    listIndex,
    baseUrl: normalised,
    key: normalised,
    label: labelFor(normalised),
    state: "healthy",
    latencyEmaMs: undefined,
    lastUsedAt: undefined,
    consecutiveFailures: 0,
  };
}

function sortKey(p: Peer): [number, number, number] {
  const ema =
    p.latencyEmaMs === undefined
      ? Number.MAX_SAFE_INTEGER / 2
      : Math.max(0, p.latencyEmaMs);
  return [stateRank(p.state), ema, p.listIndex];
}

function compareSortKeys(
  a: [number, number, number],
  b: [number, number, number],
): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

/**
 * Ordered peer table. Phase 1 accepts one endpoint; Phase 1.5 accepts
 * 1..N and maintains health/latency per peer.
 */
export class PeerSet {
  private readonly peers: MutablePeer[];

  constructor(endpoints: readonly string[]) {
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      throw new ConfigError("PeerSet requires at least one endpoint");
    }
    this.peers = endpoints.map((url, i) => makePeer(i, url));
  }

  /** Total peer count. */
  len(): number {
    return this.peers.length;
  }

  /** Whether more than one peer is configured. */
  isMesh(): boolean {
    return this.peers.length > 1;
  }

  /** Snapshot of all peers (shallow copy so callers can't mutate state). */
  snapshot(): Peer[] {
    return this.peers.map((p) => ({ ...p }));
  }

  /** Primary peer — the first in constructor order. */
  primary(): Peer {
    return this.peers[0];
  }

  /** Iterator over peers in constructor order. */
  *iter(): IterableIterator<Peer> {
    for (const p of this.peers) yield p;
  }

  /**
   * Pick the next peer to dispatch against per closest-first ordering.
   * Prefers `healthy` → `degraded`; falls back to `unhealthy` only if
   * every peer is unhealthy (so the request still attempts something).
   */
  pick(): Peer {
    let best: MutablePeer | undefined;
    let bestKey: [number, number, number] | undefined;
    for (const p of this.peers) {
      const k = sortKey(p);
      if (!best || !bestKey || compareSortKeys(k, bestKey) < 0) {
        best = p;
        bestKey = k;
      }
    }
    if (!best) {
      // Constructor guarantees non-empty; this is unreachable at runtime.
      throw new ConfigError("PeerSet invariant: at least one peer");
    }
    return best;
  }

  /**
   * Next peer to try after `failed` has returned a cycling-eligible
   * error. Skips `failed` by `listIndex`; scans remaining peers in the
   * same closest-first order.
   */
  nextAfter(failed: Peer): Peer | undefined {
    let best: MutablePeer | undefined;
    let bestKey: [number, number, number] | undefined;
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
  findByKey(peerKey: string): Peer | undefined {
    const wanted = normaliseBaseUrl(peerKey);
    return this.peers.find((p) => p.key === wanted);
  }

  /**
   * Record a successful outcome: update EMA, clear failure counter,
   * promote state to `healthy`.
   */
  markSuccess(peerKey: string, latencyMs: number): void {
    const p = this.peerMut(peerKey);
    if (!p) return;
    const ms = Math.max(0, latencyMs);
    p.latencyEmaMs =
      p.latencyEmaMs === undefined ? ms : 0.8 * p.latencyEmaMs + 0.2 * ms;
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
  markFailure(peerKey: string, cls: PeerErrorClass): void {
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

  private peerMut(peerKey: string): MutablePeer | undefined {
    const wanted = normaliseBaseUrl(peerKey);
    return this.peers.find((p) => p.key === wanted);
  }
}

/**
 * Normalise a URL into the canonical `https://host:port[/path]` shape
 * with no trailing slash. Throws `ConfigError` on invalid input.
 */
export function normaliseBaseUrl(raw: string): string {
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
  return url.toString().replace(/\/+$/, "");
}

function labelFor(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return url;
  }
}
