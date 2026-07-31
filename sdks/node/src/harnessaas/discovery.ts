/**
 * Discovery wire type: health (ADR-0027a, issue #67/#68 / M5 start).
 *
 * Verified against `cognitum-one/harnessaas@908e4a99:src/server.ts:286-304`.
 * `/health` is served WITHOUT authentication (no `authenticate()` call in the
 * route handler) — matching `MetaLlmClient.health()`'s "process-level
 * response only, never identity or readiness" contract exactly.
 *
 * IMPORTANT (2026-07-19 reconciliation audit, issue #67): the service also
 * answers on `/healthz` and `/status`, but `src/server.ts:290-292`'s own
 * comment documents that Cloud Run's frontend (GFE) RESERVES `/healthz` and
 * answers it with the platform's own 404 to EXTERNAL callers — so `/healthz`
 * is NOT reliably reachable from outside the container, even though the
 * README's local `curl -s localhost:8080/healthz` example works (it never
 * crosses a real Cloud Run frontend). `/health` and `/status` are the
 * externally-reachable aliases. This client therefore calls `GET /health`
 * as the canonical route.
 */

/**
 * `health()` response. No OpenAPI/JSON-Schema contract is published for this
 * shape yet (ADR-0027a §D11 blocker #1), so only the fields verified
 * directly against `src/server.ts:293-303` are typed; everything else
 * (`genome`, `sandbox_caps`, ...) is preserved in `raw`.
 */
export interface HarnessaaSHealth {
  status: string;
  /** `"mock"` ($0, no network) or `"live"`. */
  mode?: string;
  backend?: string;
  /** Always `"per-account"` at HEAD — tenancy is per-tenant, not global. */
  tenancy?: string;
  /** `"firestore"` (shared/consistent across instances) or `"memory"` (per-instance). */
  storeBackend?: string;
  /** Always `true` at HEAD — lineage is per-tenant; a global chain is no longer verified here. */
  lineageChainOk?: boolean;
  /** Unrecognized fields (`genome`, `sandbox_caps`, ...) from the server response, preserved verbatim. */
  raw?: Record<string, unknown>;
}

/** Parse a raw `GET /health` JSON body into {@link HarnessaaSHealth}. */
export function parseHarnessaaSHealth(value: unknown): HarnessaaSHealth {
  const raw = (value ?? {}) as Record<string, unknown>;
  const known = new Set([
    "status",
    "mode",
    "backend",
    "tenancy",
    "store_backend",
    "lineageChainOk",
  ]);
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) rest[key] = raw[key];
  }
  return {
    status: String(raw.status ?? "unknown"),
    mode: typeof raw.mode === "string" ? raw.mode : undefined,
    backend: typeof raw.backend === "string" ? raw.backend : undefined,
    tenancy: typeof raw.tenancy === "string" ? raw.tenancy : undefined,
    storeBackend: typeof raw.store_backend === "string" ? raw.store_backend : undefined,
    lineageChainOk: typeof raw.lineageChainOk === "boolean" ? raw.lineageChainOk : undefined,
    raw: Object.keys(rest).length > 0 ? rest : undefined,
  };
}
