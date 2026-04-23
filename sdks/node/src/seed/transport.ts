/**
 * Transport layer for the seed client.
 *
 * ADR-0015b §5 prescribes `undici.Agent` for TLS pinning. As of
 * 2026-04-22 (issue #18 remediation) `undici` is a hard dependency and
 * the agent is scoped to THIS client only — we never touch
 * `process.env.NODE_TLS_REJECT_UNAUTHORIZED`, which would leak insecure
 * TLS across the entire process (including unrelated concurrent fetches
 * on the cloud client or any other library).
 *
 * The key invariant: TLS pinning / insecure-mode choices are resolved
 * once per client at construction — request paths stay pure.
 *
 * Per-peer fingerprint pinning (ADR-0015c Phase 3 §fp= cert pinning,
 * closes FINDING-28): when a peer's mDNS TXT record carries
 * `fp=sha256:<hex>`, the SDK builds a dedicated dispatcher whose
 * `checkServerIdentity` verifies that SHA-256(peerCert.raw) matches the
 * advertised prefix. A mismatch throws {@link TlsPinError} with no
 * fallback to `tls.insecure` — the peer's mDNS record asserted a
 * specific cert; accepting a different one would silently consent to
 * the classic mDNS-spoofing attack.
 */

import { createHash } from "node:crypto";
import { Agent } from "undici";
import type { ResolvedSeedConfig } from "./config.js";
import { TlsPinError } from "../errors.js";
import type { Peer } from "./peers.js";
import { FP_MIN_HEX_LEN, FP_MAX_HEX_LEN } from "./discovery/mdns.js";

let warnedInsecure = false;

/**
 * Build a `fetch`-compatible callable bound to this client's TLS policy.
 * The returned function signature matches the global `fetch`, so callers
 * can treat it as a drop-in.
 */
export function buildSeedFetch(cfg: ResolvedSeedConfig): typeof fetch {
  // If the caller injected a fetch (tests), honour it verbatim. We do
  // not wrap it because tests want to assert on the URL + headers, not
  // on an undici dispatcher.
  if (cfg.fetchFn !== globalThis.fetch) {
    return cfg.fetchFn;
  }

  const { insecure, ca } = cfg.tls;
  if (insecure && !warnedInsecure) {
    warnedInsecure = true;
    const warn = cfg.logger.warn ?? ((m: string) => console.warn(m));
    warn(
      "[cognitum-sdk/seed] TLS verification disabled (tls.insecure=true). " +
        "Never use this in production — pair with a trustRoot CA instead.",
    );
  }

  // Build a dispatcher scoped to this client. Passed via `fetch(url, {
  // dispatcher })` so it never mutates process-wide state. Closed with
  // the owning `SeedClient` via `close()` (future work — today we rely
  // on the `unref`'d keep-alive timer + GC).
  const dispatcher = buildDispatcher({ insecure, ca });

  // Hot-path perf (issue #24): when the client has no custom dispatcher
  // (no insecure mode, no custom CA), there's nothing for this wrapper to
  // add — defer directly to `globalThis.fetch` and avoid the per-call
  // object spread. `SeedClient.dispatchOnce` already builds a fresh
  // `init` per call, so we do NOT need to clone it here.
  if (dispatcher === undefined) {
    return globalThis.fetch;
  }

  // With a custom dispatcher, attach it to the caller's init without a
  // spread. `init` is either undefined (GETs built server-side) or a
  // fresh object the caller owns; mutating it in place is safe because
  // `dispatchOnce` never reuses the same `init` across retry attempts.
  return (input, init) => {
    if (init === undefined) {
      return globalThis.fetch(input, { dispatcher } as RequestInit);
    }
    (init as RequestInit & { dispatcher?: unknown }).dispatcher = dispatcher;
    return globalThis.fetch(input, init);
  };
}

/**
 * Construct the per-client {@link Agent}. Returns `undefined` when the
 * caller has not opted into a custom CA AND is not using insecure mode
 * — in that case Node's default fetch dispatcher is used and the system
 * trust store applies.
 *
 * Exported for testing (see
 * `tests/seed/unit/transport-tls-isolation.test.ts`).
 */
export function buildDispatcher(tls: {
  insecure: boolean;
  ca: Buffer | string | undefined;
}): Agent | undefined {
  if (tls.insecure) {
    // Scoped insecure — applies ONLY to requests that use this agent.
    // Unrelated `fetch()` calls in the same Node process retain
    // default TLS verification.
    return new Agent({
      keepAliveTimeout: 10_000,
      connections: 16,
      allowH2: false,
      connect: {
        rejectUnauthorized: false,
      },
    });
  }
  if (tls.ca !== undefined) {
    return new Agent({
      keepAliveTimeout: 10_000,
      connections: 16,
      allowH2: false,
      connect: {
        ca: tls.ca,
        rejectUnauthorized: true,
      },
    });
  }
  // No per-client TLS customisation — let Node's default dispatcher
  // handle the request with the system trust store.
  return undefined;
}

/** Reset the insecure-warning latch — test hook only. */
export function __resetInsecureWarnLatch(): void {
  warnedInsecure = false;
}

/**
 * Per-peer dispatcher cache. Keyed by `peer.key` (canonical URL), value
 * is the pinned {@link Agent} built lazily on first use. Precedence:
 *
 *   1. Explicit `tls.ca` — user-supplied CA wins for every peer; no
 *      per-peer entry is built (the client-wide dispatcher handles it).
 *   2. Peer has `tlsFingerprint` — pinned Agent with `checkServerIdentity`
 *      that verifies SHA-256(cert.raw) starts with the advertised hex.
 *      A mismatch surfaces as {@link TlsPinError}; no insecure fallback.
 *   3. Otherwise — per-peer entry is `undefined`; the caller uses the
 *      client-wide dispatcher (`tls.insecure` / system CA / custom CA).
 *
 * The cache is scoped to a single {@link SeedClient} via
 * {@link buildPeerDispatcherFactory}. Agents live for the client's
 * lifetime and are re-used across every retry / request to the same
 * peer — this matters because each `new Agent()` allocates a TLS
 * session cache and a keep-alive pool.
 */
export type PeerDispatcherFactory = (peer: Peer) => Agent | undefined;

/**
 * Build a per-peer dispatcher factory with a private cache. Call once
 * at {@link SeedClient} construction; dispatchers are memoised by
 * `peer.key` so five calls to the same peer share one Agent.
 */
export function buildPeerDispatcherFactory(tls: {
  insecure: boolean;
  ca: Buffer | string | undefined;
}): PeerDispatcherFactory {
  // ca wins — no per-peer pinning needed; the client-wide dispatcher
  // already applies the CA uniformly.
  if (tls.ca !== undefined) {
    return () => undefined;
  }
  const cache = new Map<string, Agent | undefined>();
  return (peer: Peer): Agent | undefined => {
    if (!peer.tlsFingerprint) return undefined;
    const cached = cache.get(peer.key);
    if (cached !== undefined) return cached;
    const agent = buildPinnedAgent(peer.key, peer.tlsFingerprint);
    cache.set(peer.key, agent);
    return agent;
  };
}

/**
 * Construct a pinned {@link Agent} for `peerKey`. The `checkServerIdentity`
 * callback computes the SHA-256 of the peer's DER-encoded cert
 * (`cert.raw`) and asserts it starts with the advertised hex prefix
 * (the seed truncates to 16 hex chars — 8 bytes — per its TXT budget).
 *
 * Rejecting with a non-`Error` Error instance is critical: undici
 * surfaces the returned Error through the fetch promise chain, and
 * {@link SeedClient.dispatchOnce} then unwraps it into a
 * {@link TlsPinError}. The returned error has a stable `code`
 * (`TLS_PIN_ERROR`) so callers can `err.cause instanceof TlsPinError`
 * and `err.message` contains the mismatch details.
 *
 * Exported for testing
 * (`tests/seed/unit/transport-fp-pin.test.ts`).
 */
export function buildPinnedAgent(
  peerKey: string,
  expectedFingerprint: string,
): Agent {
  return new Agent({
    keepAliveTimeout: 10_000,
    connections: 16,
    allowH2: false,
    connect: {
      // rejectUnauthorized must stay off here because the seed serves a
      // self-signed cert — standard chain validation would always fail.
      // The fingerprint pin IS the trust anchor, enforced below.
      rejectUnauthorized: false,
      checkServerIdentity: makePinCheckServerIdentity(
        peerKey,
        expectedFingerprint,
      ),
    },
  });
}

/**
 * Build the `checkServerIdentity` callback used by
 * {@link buildPinnedAgent}. Exported so unit tests can exercise the
 * comparator against stubbed peer certs without spinning up a TLS
 * server.
 *
 * Returning an {@link Error} aborts the handshake; returning
 * `undefined` accepts it. The error carries a stable `code` marker
 * (`TLS_PIN_ERROR`) plus the peer / fingerprint fields that
 * {@link classifyPinFailure} unwraps into a typed {@link TlsPinError}.
 */
export function makePinCheckServerIdentity(
  peerKey: string,
  expectedFingerprint: string,
): (host: string, cert: unknown) => Error | undefined {
  return (_host: string, cert: unknown): Error | undefined => {
    const actual = sha256OfCert(cert);
    if (!matchFingerprint(expectedFingerprint, actual)) {
      const e = new Error(
        `TLS fingerprint mismatch for ${peerKey}: expected ${expectedFingerprint}, got ${actual ?? "<unknown>"}`,
      ) as Error & {
        code?: string;
        peerKey?: string;
        expectedFingerprint?: string;
        actualFingerprint?: string | undefined;
      };
      e.code = "TLS_PIN_ERROR";
      e.peerKey = peerKey;
      e.expectedFingerprint = expectedFingerprint;
      e.actualFingerprint = actual;
      return e;
    }
    return undefined;
  };
}

/** Compute SHA-256 of a peer cert's DER (`raw`) bytes → lowercase hex. */
function sha256OfCert(cert: unknown): string | undefined {
  const raw = (cert as { raw?: Uint8Array } | undefined)?.raw;
  if (!raw) return undefined;
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Compare the advertised fingerprint against the actual SHA-256 hex.
 * The seed truncates to 16 hex chars (8 bytes) in its TXT record, so
 * we accept any byte-prefix of the actual hash. Both inputs must
 * already be lowercase hex (no colons, no `sha256:`).
 *
 * Defense-in-depth: this function ALSO enforces the `[FP_MIN_HEX_LEN,
 * FP_MAX_HEX_LEN]` bounds that {@link parseFingerprint} applies at
 * the mDNS layer. Even if a caller ever constructs a pinned dispatcher
 * without going through the discovery path (e.g. a hand-rolled
 * `PeerSet` in tests), `fp=ab`-style short prefixes cannot slip through
 * and match 1/256 of any self-signed cert. An `expected` outside the
 * bounds is treated as a hard mismatch.
 */
function matchFingerprint(
  expected: string,
  actual: string | undefined,
): boolean {
  if (!actual) return false;
  if (expected.length < FP_MIN_HEX_LEN) return false;
  if (expected.length > FP_MAX_HEX_LEN) return false;
  if (expected.length % 2 !== 0) return false;
  if (expected.length > actual.length) return false;
  if (!/^[0-9a-f]+$/.test(expected)) return false;
  // Constant-time compare is overkill here — the fingerprint is public
  // info (broadcast over mDNS), so timing leaks are a non-issue.
  return actual.startsWith(expected);
}

/**
 * Classify a fetch failure into a typed {@link TlsPinError} when the
 * underlying cause was our pinning check. Called by
 * {@link SeedClient.dispatchOnce} before the generic `NetworkError`
 * fallback — pinning failures MUST surface verbatim, never degrade to
 * a cycleable "connect failed".
 *
 * Node + undici re-wrap errors thrown from `checkServerIdentity` into
 * a `TypeError: fetch failed` with a nested `cause`. We walk the cause
 * chain looking for the `TLS_PIN_ERROR` marker we stamped in
 * {@link buildPinnedAgent}.
 */
export function classifyPinFailure(err: unknown): TlsPinError | undefined {
  // Walk the cause chain. Undici produces
  //   TypeError: fetch failed
  //     cause: Error: ... (our stamped error)
  // possibly wrapped further by future Node versions.
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== undefined && cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const rec = cur as {
      code?: unknown;
      peerKey?: unknown;
      expectedFingerprint?: unknown;
      actualFingerprint?: unknown;
      cause?: unknown;
    };
    if (
      rec.code === "TLS_PIN_ERROR" &&
      typeof rec.peerKey === "string" &&
      typeof rec.expectedFingerprint === "string"
    ) {
      const actual =
        typeof rec.actualFingerprint === "string"
          ? rec.actualFingerprint
          : undefined;
      return new TlsPinError(rec.peerKey, rec.expectedFingerprint, actual);
    }
    cur = rec.cause;
  }
  return undefined;
}
