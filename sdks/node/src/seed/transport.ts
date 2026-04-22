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
 */

import { Agent } from "undici";
import type { ResolvedSeedConfig } from "./config.js";

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
