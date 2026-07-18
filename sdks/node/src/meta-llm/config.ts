/**
 * MetaLlmClient construction and deployment ownership (ADR-0024a §D1).
 *
 * Type-only scaffolding plus construction-time validation for issue #58 / M2.
 * Construction performs NO I/O — see {@link MetaLlmClient} in `./client.js`
 * for the first real HTTP-backed operations (`health`, `whoami`, `models`).
 */

import type { BudgetPolicy, CredentialProvider, RequestContext } from "../agentic/index.js";
import type { CapabilitySet } from "../agentic/index.js";
import type { MetaLlmRoutingControls } from "./types/routing.js";

/**
 * ADR-0024b §D2's concrete `MetaLlmRoutingControls` shape (issue #59, D11
 * migration step 1). Re-exported here (rather than duplicated) so existing
 * imports of `MetaLlmRoutingControls` from `./config.js` keep working
 * unchanged now that the placeholder has a real shape.
 */
export type { MetaLlmRoutingControls } from "./types/routing.js";

/**
 * ADR-0024b product-specific safety control. Frozen as an opaque placeholder
 * — this stays a separate, still-deferred surface from `MetaLlmRoutingControls`
 * (whose `safety: SafetyMode` field is now concrete): richer safety
 * configuration (detector-class selection, thresholds) is out of this
 * pass's scope.
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
 * One-shot latch so the `allowInsecureHttp` escape hatch only ever warns
 * once per process, matching the seed module's `tls.insecure` pattern
 * (`../seed/transport.js`'s `warnedInsecure`).
 */
let warnedInsecureHttp = false;

/** Test-only hook to reset the one-shot warning latch between test cases. */
export function __resetMetaLlmInsecureHttpWarnLatch(): void {
  warnedInsecureHttp = false;
}

function extractHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * `true` only for a literal IPv4/IPv6 loopback address. Hostname
 * resolution (e.g. "localhost") is deliberately excluded — ADR-0022 §D3:
 * "Hostname resolution to loopback is insufficient for the default-safe
 * mode because rebinding can change the destination."
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "::1") return true;
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  return match.slice(1).every((octet) => Number(octet) >= 0 && Number(octet) <= 255) && Number(match[1]) === 127;
}

function warnInsecureHttpOnce(baseUrl: string): void {
  if (warnedInsecureHttp) return;
  warnedInsecureHttp = true;
  console.warn(
    `[cognitum-sdk/meta-llm] HTTP (non-TLS) transport is ENABLED via allowInsecureHttp ` +
      `for loopback baseUrl "${baseUrl}". Never use this in production — see ADR-0022 §D3.`,
  );
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
  if (!isHttps) {
    if (!config.allowInsecureHttp) {
      throw new TypeError(
        `MetaLlmClientConfig.baseUrl must be an explicit HTTPS origin (ADR-0024a §D1); ` +
          `got "${config.baseUrl}". Set allowInsecureHttp: true for local development only.`,
      );
    }
    // ADR-0022 §D3: disabling TLS is allowed only for loopback
    // development, emits a local warning hook, and cannot be enabled
    // through a generic environment variable in production builds.
    const host = extractHost(trimmed);
    if (!host || !isLoopbackHost(host)) {
      throw new TypeError(
        `MetaLlmClientConfig.allowInsecureHttp is only permitted for literal IPv4/IPv6 ` +
          `loopback base URLs (ADR-0022 §D3); got "${config.baseUrl}". Hostname resolution ` +
          `to loopback (e.g. "localhost") is insufficient.`,
      );
    }
    warnInsecureHttpOnce(trimmed);
  }
  return { ...config, baseUrl: trimmed };
}
