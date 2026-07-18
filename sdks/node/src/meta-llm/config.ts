/**
 * MetaLlmClient construction and deployment ownership (ADR-0024a §D1).
 *
 * Type-only scaffolding plus construction-time validation for issue #58 / M2.
 * Construction performs NO I/O — see {@link MetaLlmClient} in `./client.js`
 * for the first real HTTP-backed operations (`health`, `whoami`, `models`).
 */

import type { BudgetPolicy, CredentialProvider, RequestContext } from "../agentic/index.js";
import type { CapabilitySet } from "../agentic/index.js";

/**
 * ADR-0024b product-specific routing controls. Frozen as an opaque
 * placeholder here — the concrete shape lands with issue #59
 * (ADR-0024b: Meta LLM platform resources, routing, and usage). A generic
 * caller override MUST NOT be able to conflict with the eventual typed
 * fields (ADR-0024a §D3), so this stays a nominal, intentionally-narrow
 * record rather than `Record<string, unknown>` reused elsewhere.
 */
export interface MetaLlmRoutingControls {
  readonly __brand?: "MetaLlmRoutingControls";
  [key: string]: unknown;
}

/**
 * ADR-0024b product-specific safety control. Frozen as an opaque placeholder
 * — see {@link MetaLlmRoutingControls} for the same issue #59 deferral note.
 */
export interface MetaLlmSafetyControl {
  readonly __brand?: "MetaLlmSafetyControl";
  [key: string]: unknown;
}

/** A single telemetry observation emitted around one MetaLlmClient operation. */
export interface MetaLlmTelemetryEvent {
  operation: string;
  requestId: string;
  httpStatus?: number;
  durationMs?: number;
  retryAfterMs?: number;
  idempotentReplay?: boolean;
}

/**
 * Caller-supplied telemetry hooks (ADR-0028). Deliberately minimal in this
 * pass — no cost/usage aggregation, no drift detection wiring yet. Hooks
 * MUST NOT receive secrets; callers wire redaction via `SecretRedactor`
 * from `../agentic/index.js` before logging anything derived from these
 * events.
 */
export interface MetaLlmTelemetryHooks {
  onRequestStart?(event: Pick<MetaLlmTelemetryEvent, "operation" | "requestId">): void;
  onRequestEnd?(event: MetaLlmTelemetryEvent): void;
}

/**
 * Fetch-compatible transport hook, injectable for tests (ADR-0024a §D1
 * `transport` field). Defaults to `globalThis.fetch`.
 */
export type MetaLlmTransport = typeof fetch;

/** Construction config for {@link MetaLlmClient} (ADR-0024a §D1). */
export interface MetaLlmClientConfig {
  /**
   * Explicit HTTPS origin. A production URL becomes a default only after
   * publication in the contract bundle (ADR-0024a §D1) — there is no
   * built-in default here, unlike the root `Cognitum` client.
   */
  baseUrl: string;
  /**
   * Opt out of the HTTPS-origin requirement for local development and
   * tests only (e.g. a local mock server on `http://127.0.0.1`). Defaults
   * to `false`. Never set this against a real deployment.
   */
  allowInsecureHttp?: boolean;
  credentialProvider?: CredentialProvider;
  transport?: MetaLlmTransport;
  defaultRequestContext?: Partial<RequestContext>;
  defaultRoutingControls?: MetaLlmRoutingControls;
  defaultSafetyControl?: MetaLlmSafetyControl;
  budgetPolicy?: BudgetPolicy;
  /**
   * Static compatibility-table entry consulted by `capabilities()` until a
   * runtime capabilities endpoint is published (ADR-0024a §D9 gate #3).
   */
  capabilitiesSnapshot?: CapabilitySet;
  telemetry?: MetaLlmTelemetryHooks;
}

/** Normalized, defaulted construction state held by {@link MetaLlmClient}. */
export interface ResolvedMetaLlmClientConfig extends MetaLlmClientConfig {
  baseUrl: string;
}

/**
 * Validate and normalize a {@link MetaLlmClientConfig}. Pure function, no
 * I/O — construction MUST stay side-effect free (ADR-0024a §D1, ADR-0019 §D3).
 */
export function resolveMetaLlmClientConfig(
  config: MetaLlmClientConfig,
): ResolvedMetaLlmClientConfig {
  if (!config.baseUrl) {
    throw new TypeError("MetaLlmClientConfig.baseUrl is required");
  }
  const trimmed = config.baseUrl.replace(/\/+$/, "");
  const isHttps = /^https:\/\//i.test(trimmed);
  if (!isHttps && !config.allowInsecureHttp) {
    throw new TypeError(
      `MetaLlmClientConfig.baseUrl must be an explicit HTTPS origin (ADR-0024a §D1); ` +
        `got "${config.baseUrl}". Set allowInsecureHttp: true for local development only.`,
    );
  }
  return { ...config, baseUrl: trimmed };
}
