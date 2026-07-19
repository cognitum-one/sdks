/**
 * `MetaHarnessClient` construction and configuration (ADR-0026a §D1, §D3).
 *
 * Type-only scaffolding plus construction-time validation for issue #64 /
 * M4 start. Construction performs NO I/O — it "resolves configuration
 * only. [It performs] no npm access, process spawn, repository read,
 * filesystem write, capability probe, login, or prompt" (§D1). See
 * `./client.js` for the fail-closed method stubs this pass ships instead
 * of any real bridge call.
 *
 * Mirrors `MetaProxyClient`'s construction conventions exactly
 * (`../meta-proxy/config.js`): a resolved config object and the same
 * telemetry-hook shape. Unlike Meta Proxy, there is no HTTP loopback
 * origin here at all — the bridge is a child process over stdio
 * (ADR-0026a §D4) — so there is nothing analogous to `origin` to default
 * or validate. The §D1/§D10 "zero I/O" requirement this module upholds
 * instead is structural: `resolveMetaHarnessClientConfig` only reads and
 * defaults plain fields, never touching npm, a process, or a filesystem
 * path.
 *
 * §D3's `distribution`, `workspace_policy`, `process_policy`, and
 * `diagnostic_policy` sub-shapes are owned by ADR-0026b (process,
 * filesystem, and npm/npx supply chain) — that ADR is explicitly out of
 * scope for this pass (§D7 blocker #1: "reviewed 0.4.1 is not published at
 * the registry state"), so they are typed here as opaque records rather
 * than guessed at in detail.
 */

/**
 * Locked OSS distribution identity (ADR-0026b, out of scope here). Opaque —
 * its exact shape (registry, version pin, digest, Node version range, etc.)
 * belongs to ADR-0026b's distribution manager, which cannot exist yet
 * (ADR-0026a §D7 blocker #1).
 */
export type MetaHarnessDistribution = Record<string, unknown>;

/** Workspace containment policy (ADR-0026b, out of scope here). Opaque record. */
export type MetaHarnessWorkspacePolicy = Record<string, unknown>;

/** Child-process containment policy (ADR-0026b, out of scope here). Opaque record. */
export type MetaHarnessProcessPolicy = Record<string, unknown>;

/**
 * Diagnostic redaction/retention policy (ADR-0026a §D5: "Events are local
 * telemetry inputs subject to ADR-0028 ... Diagnostics use opaque file IDs
 * and workspace-relative paths."). Opaque record — the exact shape is
 * bridge-defined and not yet published.
 */
export type MetaHarnessDiagnosticPolicy = Record<string, unknown>;

/** Default warm-bridge-handshake budget — matches §D4's default parser limit table exactly. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 2_000;

/** A single telemetry observation emitted around one MetaHarnessClient operation. */
export interface MetaHarnessTelemetryEvent {
  operation: string;
  requestId: string;
  durationMs?: number;
}

/**
 * Caller-supplied telemetry hooks (ADR-0028), matching
 * `MetaProxyTelemetryHooks`'s convention (`../meta-proxy/config.js`). Hooks
 * MUST NOT receive secrets.
 */
export interface MetaHarnessTelemetryHooks {
  onRequestStart?(event: Pick<MetaHarnessTelemetryEvent, "operation" | "requestId">): void;
  onRequestEnd?(event: MetaHarnessTelemetryEvent): void;
}

/**
 * Construction config for {@link MetaHarnessClient} (ADR-0026a §D3).
 *
 * Every field is resolved with zero I/O (§D1). None of `distribution`,
 * `workspacePolicy`, or `processPolicy` is read from disk, npm, or the
 * environment here — they are plain caller-supplied values, held as-is.
 */
export interface MetaHarnessConfig {
  distribution?: MetaHarnessDistribution;
  workspacePolicy?: MetaHarnessWorkspacePolicy;
  processPolicy?: MetaHarnessProcessPolicy;
  /** Milliseconds. Budget for locating/validating the locked distribution before bridge acquisition (ADR-0026b). */
  acquisitionTimeoutMs?: number;
  /**
   * Milliseconds. Defaults to {@link DEFAULT_HANDSHAKE_TIMEOUT_MS} (2000),
   * matching §D4's "Warm bridge handshake | 2 seconds" default parser limit.
   */
  handshakeTimeoutMs?: number;
  /** Milliseconds. Per-operation budget once a bridge protocol exists (§D4). */
  operationTimeoutMs?: number;
  diagnosticPolicy?: MetaHarnessDiagnosticPolicy;
  /**
   * Feature-flagged preview capabilities this caller opts into (ADR-0026a
   * §D7: "a released SDK may offer only a feature-flagged, read-only
   * development preview with the exact verified distribution"). Opting in
   * to a name here never grants an operation that is otherwise blocked —
   * every §D2 method still fails closed until its upstream capability
   * exists.
   */
  previewFeatures?: string[];
  telemetry?: MetaHarnessTelemetryHooks;
}

/** Normalized, defaulted construction state held by {@link MetaHarnessClient}. */
export interface ResolvedMetaHarnessConfig extends MetaHarnessConfig {
  handshakeTimeoutMs: number;
  previewFeatures: string[];
}

/**
 * Validate and normalize a {@link MetaHarnessConfig}. Pure function, no I/O
 * — construction MUST stay side-effect free (ADR-0026a §D1: "Constructors
 * resolve configuration only. They perform no npm access, process spawn,
 * repository read, filesystem write, capability probe, login, or prompt.").
 */
export function resolveMetaHarnessClientConfig(
  config: MetaHarnessConfig = {},
): ResolvedMetaHarnessConfig {
  if (config.handshakeTimeoutMs !== undefined && config.handshakeTimeoutMs <= 0) {
    throw new TypeError("MetaHarnessConfig.handshakeTimeoutMs must be a positive number");
  }
  if (config.acquisitionTimeoutMs !== undefined && config.acquisitionTimeoutMs <= 0) {
    throw new TypeError("MetaHarnessConfig.acquisitionTimeoutMs must be a positive number");
  }
  if (config.operationTimeoutMs !== undefined && config.operationTimeoutMs <= 0) {
    throw new TypeError("MetaHarnessConfig.operationTimeoutMs must be a positive number");
  }
  return {
    ...config,
    handshakeTimeoutMs: config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    previewFeatures: config.previewFeatures ? [...config.previewFeatures] : [],
  };
}
