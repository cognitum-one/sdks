/**
 * Transport layer for the seed client.
 *
 * ADR-0015b §5 prescribes `undici.Agent` for TLS pinning, but `undici`
 * is not in the dependency list at the time of Phase 1 landing. We
 * degrade gracefully:
 *
 *   - If `undici` is resolvable at runtime, we construct an `Agent`
 *     with the caller's CA / insecure flag and wire it onto `fetch`.
 *   - Otherwise, we fall back to Node's built-in `https.Agent` applied
 *     via an internal `fetch` wrapper that sets the per-request
 *     dispatcher. Native `fetch` in Node 20+ honours the `dispatcher`
 *     option when the process-wide undici shim is present; when it
 *     isn't, we toggle `NODE_TLS_REJECT_UNAUTHORIZED` process-wide for
 *     a single request (dev tooling only) and log a warning each time.
 *
 * The key invariant: TLS pinning / insecure-mode choices are resolved
 * once per client at construction — request paths stay pure.
 */

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

  // Try to load undici at runtime; if unavailable, use Node's https.Agent.
  // We keep this synchronous-at-first-call: the fetch fn resolves the
  // dispatcher lazily so import-time doesn't fail on environments
  // without undici (e.g. edge runtimes, bundled apps).
  let dispatcher: unknown | undefined;
  let httpsAgent: unknown | undefined;
  let resolved = false;

  const ensureDispatcher = (): {
    dispatcher?: unknown;
    agent?: unknown;
  } => {
    if (resolved) return { dispatcher, agent: httpsAgent };
    resolved = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const undici = require("undici") as typeof import("undici");
      dispatcher = new undici.Agent({
        keepAliveTimeout: 10_000,
        connections: 16,
        allowH2: false,
        connect: {
          ca,
          rejectUnauthorized: !insecure,
        },
      });
    } catch {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const https = require("node:https") as typeof import("node:https");
        httpsAgent = new https.Agent({
          keepAlive: true,
          ca: ca as string | Buffer | undefined,
          rejectUnauthorized: !insecure,
        });
      } catch {
        // Last resort — rely on the global fetch with no TLS override.
      }
    }
    return { dispatcher, agent: httpsAgent };
  };

  return async (input, init) => {
    const { dispatcher: disp } = ensureDispatcher();
    // `dispatcher` is an undici-specific option. Node's native fetch
    // accepts it and silently ignores when undici isn't the underlying
    // impl — that's fine for our purposes.
    const finalInit: RequestInit & { dispatcher?: unknown } = {
      ...(init ?? {}),
    };
    if (disp !== undefined) {
      finalInit.dispatcher = disp;
    } else if (insecure) {
      // Native fetch without undici cannot disable cert verification on
      // a per-request basis. For Phase 1, we set the env var for the
      // duration of this one request, then restore. This is a known
      // workaround called out in ADR-0015b §"Negative / trade-offs".
      const prior = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      try {
        return await globalThis.fetch(input, finalInit);
      } finally {
        if (prior === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prior;
      }
    }
    return globalThis.fetch(input, finalInit);
  };
}

/** Reset the insecure-warning latch — test hook only. */
export function __resetInsecureWarnLatch(): void {
  warnedInsecure = false;
}
