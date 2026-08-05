/**
 * `HarnessaaSClient` construction and deployment ownership (ADR-0027a,
 * ADR-0019 §D2). Issue #67/#68 / M5 start.
 *
 * **Scope note (2026-07-19 reconciliation audit, issue #67):** the upstream
 * `cognitum-one/harnessaas` service is genuinely SYNCHRONOUS today — `POST
 * /solve` is one HTTP request/response with no job/poll/SSE/approval
 * contract anywhere in the running service (see
 * `docs/adr/0027a-harnessaas-jobs-events-approvals-and-artifacts.md`'s
 * "2026-07-19 reconciliation audit" context-section note). ADR-0027a's
 * "Decision" section (an async `SolveHandle`/`/v1/solves/*` job resource) is
 * an explicit PROPOSAL for something that does not exist upstream yet — this
 * module intentionally does NOT build against it. This pass covers only
 * construction, `health()`, `solve()`, and `lineage()` against the real,
 * deployed, synchronous route surface (`GET /health`, `POST /solve`, `GET
 * /lineage/:id`).
 *
 * Construction performs NO I/O (ADR-0019 §D3), mirroring
 * `MetaLlmClient`/`MetaProxyClient`/`MetaHarnessClient`'s construction
 * conventions exactly (`../meta-llm/config.js`).
 */

import type { BudgetPolicy, CredentialProvider, RequestContext } from "../agentic/index.js";
import type { CapabilitySet } from "../agentic/index.js";

/** A single telemetry observation emitted around one HarnessaaSClient operation. */
export interface HarnessaaSTelemetryEvent {
  operation: string;
  requestId: string;
  httpStatus?: number;
  durationMs?: number;
  retryAfterMs?: number;
}

/**
 * Caller-supplied telemetry hooks (ADR-0028). Hooks MUST NOT receive
 * secrets; callers wire redaction via `SecretRedactor` from
 * `../agentic/index.js` before logging anything derived from these events.
 */
export interface HarnessaaSTelemetryHooks {
  onRequestStart?(event: Pick<HarnessaaSTelemetryEvent, "operation" | "requestId">): void;
  onRequestEnd?(event: HarnessaaSTelemetryEvent): void;
}

/**
 * Fetch-compatible transport hook, injectable for tests. Defaults to
 * `globalThis.fetch`.
 */
export type HarnessaaSTransport = typeof fetch;

/** Construction config for {@link HarnessaaSClient} (ADR-0027a, ADR-0019 §D1). */
export interface HarnessaaSClientConfig {
  /**
   * Explicit HTTPS origin. No built-in default here — the same rule as
   * `MetaLlmClientConfig.baseUrl` (ADR-0024a §D1) applies: a production URL
   * becomes a default only after publication in a contract bundle, which
   * does not exist for HarnessaaS yet (ADR-0027a §D11 blocker #1).
   */
  baseUrl: string;
  /**
   * Opt out of the HTTPS-origin requirement for local development and
   * tests only (e.g. a local `harnessaas serve --mock` on
   * `http://127.0.0.1`). Never set this against a real deployment.
   */
  allowInsecureHttp?: boolean;
  credentialProvider?: CredentialProvider;
  transport?: HarnessaaSTransport;
  defaultRequestContext?: Partial<RequestContext>;
  budgetPolicy?: BudgetPolicy;
  /**
   * Static compatibility-table entry consulted by `capabilities()`. No
   * runtime capabilities endpoint is published for HarnessaaS yet.
   */
  capabilitiesSnapshot?: CapabilitySet;
  telemetry?: HarnessaaSTelemetryHooks;
}

/** Normalized, defaulted construction state held by {@link HarnessaaSClient}. */
export interface ResolvedHarnessaaSClientConfig extends HarnessaaSClientConfig {
  baseUrl: string;
}

/**
 * One-shot latch so the `allowInsecureHttp` escape hatch only ever warns
 * once per process, matching `MetaLlmClient`'s identical pattern
 * (`../meta-llm/config.js`).
 */
let warnedInsecureHttp = false;

/** Test-only hook to reset the one-shot warning latch between test cases. */
export function __resetHarnessaaSInsecureHttpWarnLatch(): void {
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
 * `true` only for a literal IPv4/IPv6 loopback address. Hostname resolution
 * (e.g. "localhost") is deliberately excluded — ADR-0022 §D3: "Hostname
 * resolution to loopback is insufficient for the default-safe mode because
 * rebinding can change the destination."
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
    `[cognitum-sdk/harnessaas] HTTP (non-TLS) transport is ENABLED via allowInsecureHttp ` +
      `for loopback baseUrl "${baseUrl}". Never use this in production — see ADR-0022 §D3.`,
  );
}

/**
 * Validate and normalize a {@link HarnessaaSClientConfig}. Pure function, no
 * I/O — construction MUST stay side-effect free (ADR-0019 §D3).
 */
export function resolveHarnessaaSClientConfig(
  config: HarnessaaSClientConfig,
): ResolvedHarnessaaSClientConfig {
  if (!config.baseUrl) {
    throw new TypeError("HarnessaaSClientConfig.baseUrl is required");
  }
  let end = config.baseUrl.length;
  while (end > 0 && config.baseUrl.charCodeAt(end - 1) === 47) end--;
  const trimmed = config.baseUrl.slice(0, end);
  const isHttps = /^https:\/\//i.test(trimmed);
  if (!isHttps) {
    if (!config.allowInsecureHttp) {
      throw new TypeError(
        `HarnessaaSClientConfig.baseUrl must be an explicit HTTPS origin (ADR-0027a); ` +
          `got "${config.baseUrl}". Set allowInsecureHttp: true for local development only.`,
      );
    }
    // ADR-0022 §D3: disabling TLS is allowed only for loopback
    // development, emits a local warning hook, and cannot be enabled
    // through a generic environment variable in production builds.
    const host = extractHost(trimmed);
    if (!host || !isLoopbackHost(host)) {
      throw new TypeError(
        `HarnessaaSClientConfig.allowInsecureHttp is only permitted for literal IPv4/IPv6 ` +
          `loopback base URLs (ADR-0022 §D3); got "${config.baseUrl}". Hostname resolution ` +
          `to loopback (e.g. "localhost") is insufficient.`,
      );
    }
    warnInsecureHttpOnce(trimmed);
  }
  return { ...config, baseUrl: trimmed };
}
