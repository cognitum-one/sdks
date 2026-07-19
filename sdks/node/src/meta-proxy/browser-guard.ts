/**
 * Browser-runtime rejection for `MetaProxyClient` (ADR-0025a §D10, ADR-0029 §D2).
 *
 * §D10: "Browser packages reject Meta Proxy at build time or immediately
 * before reading a credential or opening a loopback socket, consistent with
 * ADR-0029." ADR-0029 §D2 names the exact contract: "`./meta-proxy` |
 * Browser import permitted: no ... Meta Proxy is excluded because its
 * loopback token, local consent, process ownership, and CORS behavior are
 * not a browser contract ... If a bundler resolves a Node-only entry for a
 * browser target, construction MUST throw `UnsupportedRuntimeError` before
 * reading a credential, opening a socket, importing an installer, or
 * executing a process."
 *
 * This package ships one universal build per subpath (no separate
 * browser/node bundle split in `tsup.config.ts`), so "reject ... at build
 * time" is not wired up via conditional bundler exports here — the runtime
 * guard below is what actually enforces §D10/§D2 regardless of which
 * bundler resolves this module. It is checked as literally the first
 * statement of `MetaProxyClient`'s constructor (`./client.js`), before
 * `resolveMetaProxyClientConfig` or anything else runs, so it fires before
 * any credential read or socket open.
 */

import { UnsupportedRuntimeError } from "../agentic/index.js";

const PRODUCT = "meta-proxy";

/**
 * `true` when the current global environment looks like a browser (or any
 * non-Node runtime lacking Node's `process.versions.node`) rather than
 * Node.js. Detection is deliberately permissive in the "reject" direction:
 * presence of `window`/`document` is browser evidence; ABSENCE of
 * `process.versions.node` is treated the same way, since a bundler that
 * resolved this Node-only entry for a browser target typically strips or
 * never polyfills that field.
 */
export function isBrowserLikeRuntime(): boolean {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.window !== "undefined") return true;
  if (typeof g.document !== "undefined") return true;
  const proc = g.process as { versions?: { node?: unknown } } | undefined;
  if (typeof proc === "undefined") return true;
  if (typeof proc.versions === "undefined") return true;
  if (typeof proc.versions.node === "undefined") return true;
  return false;
}

/**
 * Throws {@link UnsupportedRuntimeError} when {@link isBrowserLikeRuntime}
 * is true. Zero I/O — must run before any credential read or socket open.
 */
export function assertNodeRuntime(operation: string): void {
  if (!isBrowserLikeRuntime()) return;
  throw new UnsupportedRuntimeError(
    PRODUCT,
    operation,
    "browser",
    `MetaProxyClient cannot be constructed in a browser-like runtime (ADR-0025a §D10, ` +
      `ADR-0029 §D2): its loopback token, local consent, process ownership, and CORS ` +
      `behavior are not a browser contract. Construction is refused before reading a ` +
      `credential or opening a loopback socket.`,
  );
}
