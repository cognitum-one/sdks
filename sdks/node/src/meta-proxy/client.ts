/**
 * MetaProxyClient (ADR-0025a). Issue #61 / M3 start.
 *
 * This pass implements exactly §D1 (public topology — only `status` and
 * `capabilities` exist as methods this pass; every other §D1 surface
 * — `chat`, `messages`, `models`, `whoami`, `preview.sponsored.*`,
 * `preview.routing` — is deliberately NOT declared yet, rather than stubbed
 * with a placeholder, since their construction depends on §D6 (auth),
 * §D7 (forwarding), §D9 (consent/sponsor), and §D5 (routing) groundwork
 * that is out of scope here), §D2 (maturity — everything below is preview;
 * see the class doc comment), §D3 (construction, zero I/O), and §D4
 * (`status()`/`capabilities()` as real HTTP calls against the local
 * sidecar's `/status` route, decoding the plane-evidence fields §D4
 * specifies).
 *
 * Construction mirrors `MetaLlmClient`'s conventions exactly
 * (`../meta-llm/client.js`): a resolved config object, an injectable
 * `transport`, a shared `CredentialProvider` for auth, and the same
 * telemetry-hook / request-ID / error-mapping shape. The one structural
 * difference is D3's own explicit instruction: `MetaProxyResult`/
 * `MetaProxyResponseMeta` are their OWN envelope, not a reuse of
 * `MetaLlmResult` — see `./envelope.js`'s doc comment for why.
 *
 * Deferred to follow-up M3 passes (see issue #61 and ADR-0025a):
 *  - §D5 data-plane and policy model (`RoutingIntent`, plane/policy rules);
 *  - §D6 authentication and workload capabilities beyond the minimal
 *    `CredentialProvider` this pass's constructor accepts;
 *  - §D7 inference/forwarding contract (`chat.completions`, `messages`);
 *  - §D8 streaming, errors, cancellation, and retry for the data plane;
 *  - §D9 consent, sponsor budget, and usage;
 *  - §D10 loopback and browser security beyond the loopback-origin
 *    validation already enforced by `./config.js`'s `resolveMetaProxyClientConfig`.
 */

import { AgenticError, type Credential, type CredentialProvider } from "../agentic/index.js";
import {
  resolveMetaProxyClientConfig,
  type MetaProxyClientConfig,
  type ResolvedMetaProxyClientConfig,
} from "./config.js";
import type { MetaProxyResult, MetaProxyResponseMeta } from "./envelope.js";
import { mapMetaProxyHttpError } from "./http-errors.js";
import type { MetaProxyStatus } from "./status.js";

const PRODUCT = "meta-proxy";
const DEFAULT_CAPABILITY_VERSION = "0.0.0";

/**
 * `MetaProxyStatus`'s known top-level keys (both snake_case, as the wire
 * contract in ADR-0025a §D4 is written, and camelCase, in case a future
 * Proxy release serializes camelCase directly) — everything else observed
 * on the response body is preserved verbatim under `raw` (ADR-0025a §D4's
 * `/status` route has no published OpenAPI contract yet, §D11 gate #1).
 */
const KNOWN_STATUS_KEYS = new Set([
  "product_version",
  "productVersion",
  "protocol_version",
  "protocolVersion",
  "compatible_sdk_range",
  "compatibleSdkRange",
  "process_state",
  "processState",
  "bind",
  "configured_plane",
  "configuredPlane",
  "selected_plane",
  "selectedPlane",
  "routing_reason",
  "routingReason",
  "automatic_usage_state",
  "automaticUsageState",
  "utilization",
  "reset_at",
  "resetAt",
  "workload_policy",
  "workloadPolicy",
  "sponsored_available",
  "sponsoredAvailable",
  "cloud_credential_source",
  "cloudCredentialSource",
  "limitations",
  "request_id",
  "requestId",
]);

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function pick(data: Record<string, unknown>, snake: string, camel: string): unknown {
  return data[snake] ?? data[camel];
}

/** Parse a raw `/status` JSON body into {@link MetaProxyStatus}, preserving unknown fields. */
function parseStatus(data: Record<string, unknown>): MetaProxyStatus {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!KNOWN_STATUS_KEYS.has(key)) raw[key] = value;
  }
  return {
    productVersion: String(pick(data, "product_version", "productVersion") ?? ""),
    protocolVersion: pick(data, "protocol_version", "protocolVersion") as string | undefined,
    compatibleSdkRange: pick(data, "compatible_sdk_range", "compatibleSdkRange") as
      | string
      | undefined,
    processState: String(pick(data, "process_state", "processState") ?? "unknown"),
    bind: data.bind as string | undefined,
    configuredPlane: String(pick(data, "configured_plane", "configuredPlane") ?? ""),
    selectedPlane: String(pick(data, "selected_plane", "selectedPlane") ?? ""),
    routingReason: pick(data, "routing_reason", "routingReason") as string | undefined,
    automaticUsageState: pick(data, "automatic_usage_state", "automaticUsageState") as
      | string
      | undefined,
    utilization: data.utilization as number | undefined,
    resetAt: pick(data, "reset_at", "resetAt") as string | undefined,
    workloadPolicy: pick(data, "workload_policy", "workloadPolicy") as string | undefined,
    sponsoredAvailable: pick(data, "sponsored_available", "sponsoredAvailable") as
      | boolean
      | undefined,
    cloudCredentialSource: pick(data, "cloud_credential_source", "cloudCredentialSource") as
      | string
      | undefined,
    limitations: (data.limitations as string[] | undefined) ?? [],
    requestId: String(pick(data, "request_id", "requestId") ?? ""),
    ...(Object.keys(raw).length > 0 ? { raw } : {}),
  };
}

/** Options accepted by every operation method (mirrors `MetaLlmCallOptions`). */
export interface MetaProxyCallOptions {
  requestContext?: Record<string, unknown>;
}

/**
 * Client for an already-running, authenticated, loopback Meta Proxy sidecar
 * (ADR-0025a). Independent of `MetaProxyManager` (ADR-0025b) — construction
 * never starts, installs, authenticates, probes, or reconfigures a process
 * (ADR-0025a §D1).
 *
 * Every method on this class is `preview` maturity (ADR-0025a §D2: "All
 * current methods begin preview until a complete contract bundle exists").
 * `status`/`capabilities` are the group with a defined path to `Stable`
 * ("Versioned schema, plane evidence, limitations, and compatibility range
 * published") but have not reached it yet — no D11 GA gate has passed.
 */
export class MetaProxyClient {
  private readonly config: ResolvedMetaProxyClientConfig;

  constructor(config: MetaProxyClientConfig = {}) {
    this.config = resolveMetaProxyClientConfig(config);
  }

  /** Read-only view of the effective configuration. */
  getConfig(): ResolvedMetaProxyClientConfig {
    return this.config;
  }

  /**
   * `GET /status` — authenticated local runtime and routing state
   * (ADR-0025a Context, §D4). `proxy_token_valid: true` (surfaced only as
   * a successful auth, never as a raw token) means only that auth
   * succeeded — this method never returns tokens, keys, OAuth data, unsafe
   * paths, or full account identifiers (§D4).
   */
  async status(options?: MetaProxyCallOptions): Promise<MetaProxyResult<MetaProxyStatus>> {
    const { data, meta } = await this.getJson("/status", "status", options);
    return { data: parseStatus(data), meta };
  }

  /**
   * Versioned behavior safe for this caller (ADR-0025a §D4: "`capabilities()`
   * uses an authenticated endpoint when available. Until then it uses exact
   * tested `/status` schema plus ADR-0020's pinned compatibility table. It
   * never discovers support by sending a prompt."). No dedicated
   * `/capabilities` route is published, so this calls the same
   * authenticated `/status` endpoint `status()` uses and merges it with
   * `config.capabilitiesSnapshot` — it never sends an inference request to
   * probe support.
   */
  async capabilities(
    options?: MetaProxyCallOptions,
  ): Promise<MetaProxyResult<CapabilitiesResult>> {
    const { data: status, meta } = await this.status(options);
    const snapshot = this.config.capabilitiesSnapshot;
    const warnings: string[] = [...(meta.warnings ?? [])];

    if (
      this.config.expectedProxyVersion &&
      this.config.expectedProxyVersion !== status.productVersion
    ) {
      warnings.push(
        `expectedProxyVersion "${this.config.expectedProxyVersion}" does not match the ` +
          `Proxy's reported productVersion "${status.productVersion}" (ADR-0025a §D2: ` +
          `unknown versions receive a minimum-safe set)`,
      );
    }

    const capabilities: CapabilitiesResult = {
      product: PRODUCT,
      productVersion: status.productVersion || DEFAULT_CAPABILITY_VERSION,
      protocol: snapshot?.protocol ?? "cognitum.meta-proxy.http",
      protocolVersion: status.protocolVersion ?? snapshot?.protocolVersion ?? "1.0",
      features: snapshot?.features ?? {},
      limitations: [...status.limitations, ...(snapshot?.limitations ?? [])],
      authMethods: snapshot?.authMethods ?? [],
      source: "server",
      compatibleSdkRange: status.compatibleSdkRange,
      selectedPlane: status.selectedPlane,
      configuredPlane: status.configuredPlane,
    };

    return {
      data: capabilities,
      meta: { ...meta, warnings: warnings.length > 0 ? warnings : meta.warnings },
    };
  }

  /**
   * Close local connections and wait only. Never stops the sidecar process
   * (ADR-0025a §D3: "Closing it releases connections only and never stops
   * the sidecar.").
   */
  async close(): Promise<void> {
    // No persistent local connections are opened by this client (the
    // fetch-based transport has no pool to drain); reserved for a future
    // transport that does.
  }

  // ---------------------------------------------------------------------
  // Internal HTTP glue shared by status()/capabilities()
  // ---------------------------------------------------------------------

  private async resolveCredential(operation: string): Promise<Credential | undefined> {
    const provider: CredentialProvider | undefined = this.config.localCredentialProvider;
    if (!provider) return undefined;
    return provider.acquire({
      product: PRODUCT,
      normalizedOrigin: this.config.origin,
      audience: this.config.origin,
      requiredScopes: ["meta-proxy.status"],
      operation,
      interactiveAllowed: false,
    });
  }

  private applyAuth(headers: Record<string, string>, credential?: Credential): void {
    if (!credential) return;
    // ADR-0025a §D6 (deferred, minimal auth only this pass): exactly one
    // contracted placement per operation, mirroring `MetaLlmClient`'s
    // `applyAuth` (`../meta-llm/client.js`). `credential.scheme` is either
    // the literal header name or "bearer", mapped to `Authorization`.
    if (credential.scheme.toLowerCase() === "bearer") {
      headers.Authorization = `Bearer ${credential.secret.reveal()}`;
    } else {
      headers[credential.scheme] = credential.secret.reveal();
    }
  }

  private async getJson(
    path: string,
    operation: string,
    options: MetaProxyCallOptions | undefined,
  ): Promise<{ data: Record<string, unknown>; meta: MetaProxyResponseMeta }> {
    const requestId =
      (options?.requestContext?.requestId as string | undefined) ?? newRequestId();

    this.config.telemetry?.onRequestStart?.({ operation, requestId });
    const startedAt = Date.now();

    // ADR-0025a Context: `/status` is authenticated — unlike `MetaLlmClient`'s
    // `health()`, there is no unauthenticated Proxy status route to fall
    // back to, so a missing `localCredentialProvider` fails closed here.
    let credential: Credential | undefined;
    try {
      credential = await this.resolveCredential(operation);
    } catch (cause) {
      throw new AgenticError("authentication", `failed to acquire local credential: ${cause}`, {
        product: PRODUCT,
        operation,
        requestId,
        retryable: false,
        cause,
      });
    }
    if (!credential) {
      throw new AgenticError(
        "authentication",
        `MetaProxyClient.${operation} requires a localCredentialProvider (ADR-0025a Context: ` +
          `"GET /status | Authenticated local runtime and routing state")`,
        { product: PRODUCT, operation, requestId, retryable: false },
      );
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-Cognitum-Request-Id": requestId,
    };
    this.applyAuth(headers, credential);

    const transport = this.config.transport ?? fetch;
    const url = `${this.config.origin}${path}`;

    let response: Response;
    try {
      response = await transport(url, { method: "GET", headers });
    } catch (cause) {
      this.config.telemetry?.onRequestEnd?.({
        operation,
        requestId,
        durationMs: Date.now() - startedAt,
      });
      throw new AgenticError("transport", `${operation} request failed: ${cause}`, {
        product: PRODUCT,
        operation,
        requestId,
        retryable: true,
        cause,
      });
    }

    const durationMs = Date.now() - startedAt;
    this.config.telemetry?.onRequestEnd?.({
      operation,
      requestId,
      httpStatus: response.status,
      durationMs,
    });

    if (!response.ok) {
      throw await mapMetaProxyHttpError(response, operation, requestId);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const retryAfterHeader = response.headers.get("retry-after");
    const meta: MetaProxyResponseMeta = {
      requestId: response.headers.get("x-cognitum-request-id") ?? requestId,
      productVersion: response.headers.get("x-cognitum-product-version") ?? undefined,
      protocolVersion: response.headers.get("x-cognitum-protocol-version") ?? undefined,
      httpStatus: response.status,
      retryAfter: retryAfterHeader ? Number(retryAfterHeader) : undefined,
    };
    return { data, meta };
  }
}

/**
 * `capabilities()` result shape — the shared `CapabilitySet` (ADR-0019 §D6)
 * plus the Proxy-specific plane evidence ADR-0025a §D4 says `capabilities()`
 * must be able to expose alongside it.
 */
export interface CapabilitiesResult {
  product: string;
  productVersion: string;
  protocol: string;
  protocolVersion: string;
  features: Record<string, boolean>;
  limitations: string[];
  authMethods: string[];
  source: "server" | "static-compatibility-table";
  compatibleSdkRange?: string;
  configuredPlane?: string;
  selectedPlane?: string;
}
