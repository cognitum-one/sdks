/**
 * Browser-runtime rejection for `MetaHarnessClient` (ADR-0026a §D1, ADR-0029
 * §D2).
 *
 * §D1: "Browser imports fail immediately with `UnsupportedRuntimeError` and
 * perform no loopback or registry I/O." A `MetaHarnessClient` spawns a local
 * child process over stdio (§D4) and reads/writes a local workspace
 * (ADR-0026b) — neither is a browser contract, exactly the same reasoning
 * ADR-0025a §D10 / ADR-0029 §D2 give for excluding Meta Proxy.
 *
 * This is a deliberate byte-for-byte port of `../meta-proxy/browser-guard.js`
 * (PR #96) with the product literal changed — the detection heuristic,
 * comments' structure, and fail-closed contract are identical by design so
 * the two guards stay trivially auditable against each other.
 *
 * This package ships one universal build per subpath (no separate
 * browser/node bundle split in `tsup.config.ts`), so "reject ... at build
 * time" is not wired up via conditional bundler exports here — the runtime
 * guard below is what actually enforces §D1/§D2 regardless of which
 * bundler resolves this module. It is checked as literally the first
 * statement of `MetaHarnessClient`'s constructor (`./client.js`), before
 * `resolveMetaHarnessClientConfig` or anything else runs.
 */

import { UnsupportedRuntimeError } from "../agentic/index.js";

const PRODUCT = "metaharness";

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
 * is true. Zero I/O — must run before any npm access, process spawn,
 * repository read, filesystem write, capability probe, login, or prompt.
 */
export function assertNodeRuntime(operation: string): void {
  if (!isBrowserLikeRuntime()) return;
  throw new UnsupportedRuntimeError(
    PRODUCT,
    operation,
    "browser",
    `MetaHarnessClient cannot be constructed in a browser-like runtime (ADR-0026a §D1, ` +
      `ADR-0029 §D2): its local child-process bridge and workspace filesystem access are ` +
      `not a browser contract. Construction is refused before any npm access, process ` +
      `spawn, repository read, filesystem write, capability probe, login, or prompt.`,
  );
}
