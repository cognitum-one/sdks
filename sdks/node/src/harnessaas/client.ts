/**
 * `HarnessaaSClient` (ADR-0027a, ADR-0019 §D2). Issue #67/#68 / M5 start.
 *
 * **Scope (2026-07-19 reconciliation audit, issue #67):** this pass covers
 * ONLY the real, deployed, SYNCHRONOUS surface of `cognitum-one/harnessaas` —
 * construction (zero I/O), `health()`, `solve()`, and `lineage()`. It
 * deliberately does NOT build against ADR-0027a's "Decision" section (an
 * async `SolveHandle`/job/poll/SSE/approval/cancel/artifact contract under
 * `/v1/solves/*`) — that is an explicit PROPOSAL for something that does not
 * exist in the running service yet (`docs/adr/0027a-*.md`'s reconciliation
 * note; `src/server.ts:367-501` at `908e4a99` is one HTTP request in, one
 * `SolveResponse` out, full stop). Also explicitly out of scope this pass:
 * the webhook admin routes, the MicroLoRA flywheel API (`/microlora/*` —
 * confirmed a SEPARATE future decision by the same reconciliation audit,
 * not folded into this ADR), and the authenticated `/api/v1/*` IBO-console
 * relay (unrelated to the SDK-facing solve/lineage contract).
 *
 * **Auth:** a `cog_`-prefixed API key, sent as `X-API-Key` (preferred) or
 * `Authorization: Bearer` (verified at `src/auth.ts:1-24,256-264`) — the
 * SAME shape Meta LLM uses, so `StaticApiKeyCredentialProvider` works as-is
 * (its default `scheme` is already `"X-API-Key"`).
 *
 * **Retry safety (ADR-0023, the Meta Proxy PR #93 lesson):** `solve()` is
 * genuinely non-idempotent from this client's point of view — no
 * `Idempotency-Key` handling of any kind exists anywhere in the upstream
 * service (verified: no reference to "idempoten" in `src/` outside the
 * unrelated webhook-delivery-dedupe module) and there is no in-app rate
 * limiter, so a lost response after a 429/502/503/5xx/transport failure
 * cannot be distinguished from "the sandbox clone/model call/test run
 * already started spending." Automatically retrying would risk exactly the
 * duplicate-spend/duplicate-execution failure mode independent review found
 * in Meta Proxy's non-streaming forwarding (ADR-0025a, PR #93, commit
 * `eb553f7`). `solve()` therefore makes exactly ONE HTTP attempt for every
 * outcome except a verified 401 challenge (auth happens server-side BEFORE
 * any spend — `src/server.ts` calls `authenticate()` as the very first thing
 * in the `POST /solve` handler — so a single credential-refresh-and-retry
 * there is provably zero-spend-safe, unlike a 429/502/503). `lineage()` is a
 * plain `GET` (a safe read per ADR-0023 §D3) and gets a bounded 429/502/503
 * retry; `health()` is a single unauthenticated `GET` with no retry loop,
 * matching `MetaLlmClient.health()`'s pattern.
 */

import {
  AgenticError,
  DEFAULT_RETRY_POLICY,
  equalJitterDelayMs,
  type CapabilitySet,
  type Credential,
  type CredentialProvider,
  type RequestContext,
} from "../agentic/index.js";
import {
  resolveHarnessaaSClientConfig,
  type HarnessaaSClientConfig,
  type ResolvedHarnessaaSClientConfig,
} from "./config.js";
import { parseHarnessaaSHealth, type HarnessaaSHealth } from "./discovery.js";
import type { HarnessaaSResponseMeta, HarnessaaSResult } from "./envelope.js";
import { mapHarnessaaSHttpError } from "./http-errors.js";
import {
  parseLineageResult,
  parseSolveResponse,
  toSolveRequestWire,
  type HarnessaaSLineageResult,
  type HarnessaaSSolveRequest,
  type HarnessaaSSolveResponse,
} from "./types.js";

const PRODUCT = "harnessaas";
const DEFAULT_CAPABILITY_VERSION = "0.0.0";

/** Options accepted by every operation method. */
export interface HarnessaaSCallOptions {
  requestContext?: Partial<RequestContext>;
}

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Client for the real, deployed, synchronous HarnessaaS surface (ADR-0027a).
 * Construction performs no I/O (ADR-0019 §D3). Never composes Meta LLM, Meta
 * Proxy, or MetaHarness (ADR-0019 §D4) — this is HarnessaaS's own
 * bounded-context client, full stop.
 */
export class HarnessaaSClient {
  private readonly config: ResolvedHarnessaaSClientConfig;

  constructor(config: HarnessaaSClientConfig) {
    this.config = resolveHarnessaaSClientConfig(config);
  }

  /** Read-only view of the effective configuration. */
  getConfig(): ResolvedHarnessaaSClientConfig {
    return this.config;
  }

  /**
   * Versioned behavior safe for this caller, from the static compatibility
   * snapshot (no I/O — no runtime capabilities endpoint is published for
   * HarnessaaS yet). Unknown server versions receive the intersection of
   * proven-safe capabilities, never the union (ADR-0019 §D6).
   */
  capabilities(): CapabilitySet {
    return (
      this.config.capabilitiesSnapshot ?? {
        product: PRODUCT,
        productVersion: DEFAULT_CAPABILITY_VERSION,
        protocol: "cognitum.harnessaas.http",
        protocolVersion: "1.0",
        features: {},
        limitations: ["no capabilities_snapshot configured"],
        authMethods: [],
        source: "static-compatibility-table",
      }
    );
  }

  /**
   * `GET /health` — process health only, no identity/readiness semantics.
   * Unauthenticated on the real service (`src/server.ts:293-303` never
   * calls `authenticate()` for this route) — never acquires a credential,
   * even when one is configured. Single HTTP attempt, no retry loop,
   * matching `MetaLlmClient.health()`.
   *
   * Calls `GET /health`, NOT `/healthz` — see `./discovery.js`'s module
   * doc comment for why `/healthz` is unreliable from outside the container
   * on Cloud Run.
   */
  async health(options?: HarnessaaSCallOptions): Promise<HarnessaaSResult<HarnessaaSHealth>> {
    const { data, meta } = await this.sendGetOnce("/health", "health", undefined, options);
    return { data: parseHarnessaaSHealth(data), meta };
  }

  /**
   * `POST /solve` — genuinely synchronous: one HTTP request, one full
   * `SolveResponse` back inline. See this module's doc comment for why this
   * makes exactly one HTTP attempt for every outcome except a verified 401
   * (safe to refresh-and-retry once, since auth is checked before any
   * spend) — 429/502/503/5xx/transport failures are NEVER retried
   * automatically.
   *
   * This pass does not perform local ADR-0022 §D5 scope preflight: unlike
   * Meta LLM/Meta Proxy's single required-scope-string convention, the real
   * server-side authorization is a tier-ladder CAP over multiple
   * alternative scopes (any of `completions:low`/`mid`/`high` lets a solve
   * proceed, just at a capped tier — `src/auth.ts`'s `authorizeGenome`),
   * which this client does not replicate client-side. The server remains
   * authoritative; a 403 (`insufficient_scope` or, for
   * `vertical: "security-remediation"`, `scope_required`) surfaces as a
   * `permission_denied` `AgenticError` — see `./http-errors.js`.
   */
  async solve(
    request: HarnessaaSSolveRequest,
    options?: HarnessaaSCallOptions,
  ): Promise<HarnessaaSResult<HarnessaaSSolveResponse>> {
    const body = toSolveRequestWire(request);
    let credential = await this.requireCredential("solve");
    let refreshedOnce = false;

    for (;;) {
      try {
        const { data, meta } = await this.sendPostOnce("/solve", "solve", body, credential, options);
        return { data: parseSolveResponse(data), meta };
      } catch (cause) {
        const err = cause as AgenticError;
        if (err.status === 401 && !refreshedOnce) {
          refreshedOnce = true;
          await this.config.credentialProvider?.invalidate("401 challenge from harnessaas");
          credential = await this.requireCredential("solve");
          continue;
        }
        // Every other outcome — 429/502/503/5xx/transport included — is a
        // single terminal error. See this module's doc comment: no
        // idempotency-key contract exists server-side, so a retry here
        // risks duplicate untrusted-repository execution and duplicate
        // model spend (the exact Meta Proxy PR #93 failure mode).
        throw err;
      }
    }
  }

  /**
   * `GET /lineage/:id` — a safe read (ADR-0023 §D3), so bounded 429/502/503
   * retry is appropriate here, unlike `solve()`. A `request_id` from
   * another tenant collapses to the same 404 as an absent one
   * (`src/server.ts`'s cross-tenant deny — anti-enumeration), matching
   * ADR-0019 §D6's "foreign resources map to the same `NotFoundError` as
   * absent resources."
   */
  async lineage(
    requestId: string,
    options?: HarnessaaSCallOptions,
  ): Promise<HarnessaaSResult<HarnessaaSLineageResult>> {
    if (!requestId) {
      throw new AgenticError("validation", "lineage requestId is required", {
        product: PRODUCT,
        operation: "lineage",
        retryable: false,
      });
    }
    const path = `/lineage/${encodeURIComponent(requestId)}`;
    let credential = await this.requireCredential("lineage");
    let refreshedOnce = false;
    const retryPolicy = DEFAULT_RETRY_POLICY;
    let attempt = 0;
    let sleepBudgetUsedMs = 0;

    for (;;) {
      try {
        const { data, meta } = await this.sendGetOnce(path, "lineage", credential, options);
        return { data: parseLineageResult(data), meta };
      } catch (cause) {
        const err = cause as AgenticError;
        if (err.status === 401 && !refreshedOnce) {
          refreshedOnce = true;
          await this.config.credentialProvider?.invalidate("401 challenge from harnessaas");
          credential = await this.requireCredential("lineage");
          continue;
        }
        const isBoundedRetryable = err.status === 429 || err.status === 502 || err.status === 503;
        if (isBoundedRetryable && attempt + 1 < retryPolicy.maxAttempts) {
          const serverHintMs = err.retryAfterMs ?? 0;
          const jitterMs = Math.random() * retryPolicy.baseMs;
          const delayMs = equalJitterDelayMs(attempt, retryPolicy, serverHintMs, jitterMs);
          if (sleepBudgetUsedMs + delayMs > retryPolicy.retrySleepBudgetMs) {
            throw err;
          }
          sleepBudgetUsedMs += delayMs;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          attempt += 1;
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Close local connections and wait only. Never cancels a remote solve
   * (there is no remote job to cancel — `POST /solve` has already returned
   * by the time this client hands back a result).
   */
  async close(): Promise<void> {
    // No persistent local connections are opened by this client (the
    // fetch-based transport has no pool to drain); reserved for a future
    // transport that does.
  }

  // ---------------------------------------------------------------------
  // Internal HTTP glue
  // ---------------------------------------------------------------------

  private async requireCredential(operation: string): Promise<Credential> {
    const provider: CredentialProvider | undefined = this.config.credentialProvider;
    if (!provider) {
      throw new AgenticError(
        "authentication",
        `HarnessaaSClient.${operation} requires a credentialProvider`,
        { product: PRODUCT, operation, retryable: false },
      );
    }
    return provider.acquire({
      product: PRODUCT,
      normalizedOrigin: this.config.baseUrl,
      audience: this.config.baseUrl,
      // No single required-scope string — see `solve()`'s doc comment.
      requiredScopes: [],
      operation,
      interactiveAllowed: false,
    });
  }

  private applyAuth(headers: Record<string, string>, credential?: Credential): void {
    if (!credential) return;
    // Exactly one contracted placement per operation (`src/auth.ts:256-264`
    // accepts EITHER `X-API-Key` OR `Authorization: Bearer`, never both).
    if (credential.scheme.toLowerCase() === "bearer") {
      headers.Authorization = `Bearer ${credential.secret.reveal()}`;
    } else {
      headers[credential.scheme] = credential.secret.reveal();
    }
  }

  /** One GET attempt. Never retries by itself — callers own that (see `lineage()`/`health()`). */
  private async sendGetOnce(
    path: string,
    operation: string,
    credential: Credential | undefined,
    options?: HarnessaaSCallOptions,
  ): Promise<{ data: unknown; meta: HarnessaaSResponseMeta }> {
    const requestId =
      options?.requestContext?.requestId ??
      this.config.defaultRequestContext?.requestId ??
      newRequestId();

    this.config.telemetry?.onRequestStart?.({ operation, requestId });
    const startedAt = Date.now();

    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-Cognitum-Request-Id": requestId,
    };
    this.applyAuth(headers, credential);

    const transport = this.config.transport ?? fetch;
    const url = `${this.config.baseUrl}${path}`;

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
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
    this.config.telemetry?.onRequestEnd?.({
      operation,
      requestId,
      httpStatus: response.status,
      durationMs,
      retryAfterMs,
    });

    if (!response.ok) {
      const err = await mapHarnessaaSHttpError(response, operation, requestId);
      if (err.retryAfterMs === undefined && retryAfterMs !== undefined) {
        (err as { retryAfterMs?: number }).retryAfterMs = retryAfterMs;
      }
      throw err;
    }

    const data: unknown = await response.json();
    const meta: HarnessaaSResponseMeta = {
      requestId: response.headers.get("x-cognitum-request-id") ?? requestId,
      httpStatus: response.status,
      retryAfterMs,
    };
    return { data, meta };
  }

  /** One POST attempt. Never retries by itself — the caller (`solve()`) owns that. */
  private async sendPostOnce(
    path: string,
    operation: string,
    body: unknown,
    credential: Credential,
    options?: HarnessaaSCallOptions,
  ): Promise<{ data: unknown; meta: HarnessaaSResponseMeta }> {
    const requestId =
      options?.requestContext?.requestId ??
      this.config.defaultRequestContext?.requestId ??
      newRequestId();

    this.config.telemetry?.onRequestStart?.({ operation, requestId });
    const startedAt = Date.now();

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Cognitum-Request-Id": requestId,
    };
    this.applyAuth(headers, credential);

    const transport = this.config.transport ?? fetch;
    const url = `${this.config.baseUrl}${path}`;

    let response: Response;
    try {
      response = await transport(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
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
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
    this.config.telemetry?.onRequestEnd?.({
      operation,
      requestId,
      httpStatus: response.status,
      durationMs,
      retryAfterMs,
    });

    if (!response.ok) {
      const err = await mapHarnessaaSHttpError(response, operation, requestId);
      if (err.retryAfterMs === undefined && retryAfterMs !== undefined) {
        (err as { retryAfterMs?: number }).retryAfterMs = retryAfterMs;
      }
      throw err;
    }

    const data: unknown = await response.json();
    const meta: HarnessaaSResponseMeta = {
      requestId: response.headers.get("x-cognitum-request-id") ?? requestId,
      httpStatus: response.status,
      retryAfterMs,
    };
    return { data, meta };
  }
}
