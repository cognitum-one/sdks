/**
 * MetaProxyClient construction and deployment ownership (ADR-0025a §D3).
 *
 * Type-only scaffolding plus construction-time validation for issue #61 /
 * M3 start. Construction performs NO I/O — see {@link MetaProxyClient} in
 * `./client.js` for the first real HTTP-backed operations (`status`,
 * `capabilities`).
 *
 * Unlike `MetaLlmClient` (ADR-0024a), which talks directly to Cognitum's
 * cloud service and therefore requires an explicit HTTPS origin with no
 * built-in default, `MetaProxyClient` talks to an ALREADY-RUNNING local
 * Meta Proxy sidecar process. Per ADR-0025a's Context section, the Rust
 * foreground binary "binds to `127.0.0.1:11435` by default" — so this
 * client's `origin` defaults to that literal loopback address rather than
 * requiring the caller to supply one, and literal loopback is the only
 * origin considered safe by default (ADR-0025a §D10: "Literal loopback is
 * the only stable origin"). This module does NOT install, start, or
 * reconfigure that process — see ADR-0025b's `MetaProxyManager` for that
 * (owned separately, and independent of this client per §D1's decision).
 */

import type { BudgetPolicy, CredentialProvider, RequestContext } from "../agentic/index.js";
import type { CapabilitySet } from "../agentic/index.js";

/** Default loopback origin — matches the Rust proxy binary's default bind (ADR-0025a Context). */
export const DEFAULT_META_PROXY_ORIGIN = "http://127.0.0.1:11435";

/** A single telemetry observation emitted around one MetaProxyClient operation. */
export interface MetaProxyTelemetryEvent {
  operation: string;
  requestId: string;
  httpStatus?: number;
  durationMs?: number;
  retryAfterMs?: number;
}

/**
 * Caller-supplied telemetry hooks (ADR-0028), matching `MetaLlmClient`'s
 * convention (`../meta-llm/config.js`). Hooks MUST NOT receive secrets.
 */
export interface MetaProxyTelemetryHooks {
  onRequestStart?(event: Pick<MetaProxyTelemetryEvent, "operation" | "requestId">): void;
  onRequestEnd?(event: MetaProxyTelemetryEvent): void;
}

/**
 * Fetch-compatible transport hook, injectable for tests. Defaults to
 * `globalThis.fetch`, matching `MetaLlmClient`'s `MetaLlmTransport`.
 */
export type MetaProxyTransport = typeof fetch;

/**
 * Construction config for {@link MetaProxyClient} (ADR-0025a §D3).
 *
 * D6 (authentication and workload capabilities) is explicitly deferred —
 * this pass accepts only the same shared `CredentialProvider` contract
 * (ADR-0022) that `MetaLlmClient` uses, standing in for D3's
 * `local_credential_provider` field. `ProxyCredential`'s
 * `LocalBearerToken | WorkloadCapability` discriminated union and
 * capability minting via an injected `MetaProxyLifecycleProvider` are
 * follow-up work (§D6, ADR-0025b, ADR-0026a).
 */
export interface MetaProxyClientConfig {
  /**
   * Loopback origin for the already-running Meta Proxy sidecar. Defaults to
   * {@link DEFAULT_META_PROXY_ORIGIN} when omitted (ADR-0025a §D3, Context).
   */
  origin?: string;
  /**
   * Opt out of the loopback-only requirement. Dangerous preview per
   * ADR-0025a §D10 ("Non-loopback use remains dangerous preview and
   * requires a separate TLS, remote identity, firewall, restricted CORS,
   * and exposure contract") — never set this against a real deployment.
   */
  allowNonLoopback?: boolean;
  /**
   * Local credential provider (ADR-0025a §D3: "It receives its local
   * credential from the typed provider in ADR-0022"). Required for
   * `status()`/`capabilities()` — the Proxy's `/status` route is
   * authenticated (ADR-0025a Context: "`GET /status` | Authenticated local
   * runtime and routing state").
   */
  localCredentialProvider?: CredentialProvider;
  transport?: MetaProxyTransport;
  defaultRequestContext?: Partial<RequestContext>;
  budgetPolicy?: BudgetPolicy;
  /**
   * Expected Proxy product version, checked against `MetaProxyStatus`'s
   * `compatibleSdkRange`/`productVersion` (ADR-0025a §D2: "Unknown versions
   * receive a minimum-safe set"). A mismatch surfaces as a
   * `MetaProxyResponseMeta.warnings` entry rather than a hard failure —
   * the exact compatibility-range semantics are D11 GA-gate work, not yet
   * published (ADR-0025a §D11 gate #2).
   */
  expectedProxyVersion?: string;
  /**
   * Static compatibility-table entry consulted by `capabilities()`
   * alongside the real `/status` call (ADR-0025a §D4: "Until then it uses
   * exact tested `/status` schema plus ADR-0020's pinned compatibility
   * table").
   */
  capabilitiesSnapshot?: CapabilitySet;
  telemetry?: MetaProxyTelemetryHooks;
}

/** Normalized, defaulted construction state held by {@link MetaProxyClient}. */
export interface ResolvedMetaProxyClientConfig extends MetaProxyClientConfig {
  origin: string;
}

/**
 * One-shot latch so the `allowNonLoopback` escape hatch only ever warns
 * once per process, matching `MetaLlmClient`'s `warnedInsecureHttp` pattern
 * (`../meta-llm/config.js`).
 */
let warnedNonLoopback = false;

/** Test-only hook to reset the one-shot warning latch between test cases. */
export function __resetMetaProxyNonLoopbackWarnLatch(): void {
  warnedNonLoopback = false;
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
 * resolution (e.g. "localhost") is deliberately excluded — ADR-0022 §D3 /
 * ADR-0025a §D10: "Hostnames resolving to loopback are insufficient in
 * default-safe mode."
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "::1") return true;
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  return (
    match.slice(1).every((octet) => Number(octet) >= 0 && Number(octet) <= 255) &&
    Number(match[1]) === 127
  );
}

function warnNonLoopbackOnce(origin: string): void {
  if (warnedNonLoopback) return;
  warnedNonLoopback = true;
  console.warn(
    `[cognitum-sdk/meta-proxy] Non-loopback origin "${origin}" is ENABLED via ` +
      `allowNonLoopback. This is DANGEROUS PREVIEW (ADR-0025a §D10) — the current ` +
      `Proxy has no separate TLS, remote identity, firewall, or restricted-CORS ` +
      `contract for this mode. Never use this in production.`,
  );
}

/**
 * Validate and normalize a {@link MetaProxyClientConfig}. Pure function, no
 * I/O — construction MUST stay side-effect free (ADR-0025a §D1: "Construction
 * never starts, installs, authenticates, probes, or reconfigures a process.").
 */
export function resolveMetaProxyClientConfig(
  config: MetaProxyClientConfig = {},
): ResolvedMetaProxyClientConfig {
  const rawOrigin = config.origin ?? DEFAULT_META_PROXY_ORIGIN;
  if (!rawOrigin) {
    throw new TypeError("MetaProxyClientConfig.origin must not be empty when provided");
  }
  const trimmed = rawOrigin.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new TypeError(
      `MetaProxyClientConfig.origin must be an http(s) URL; got "${config.origin}"`,
    );
  }
  const host = extractHost(trimmed);
  if (!host || !isLoopbackHost(host)) {
    if (!config.allowNonLoopback) {
      throw new TypeError(
        `MetaProxyClientConfig.origin must be a literal IPv4/IPv6 loopback address ` +
          `(ADR-0025a §D10); got "${config.origin}". Hostname resolution to loopback ` +
          `(e.g. "localhost") is insufficient. Set allowNonLoopback: true only for the ` +
          `dangerous-preview remote case described in §D10.`,
      );
    }
    warnNonLoopbackOnce(trimmed);
  }
  return { ...config, origin: trimmed };
}
