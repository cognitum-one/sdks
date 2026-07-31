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
  UnsupportedCapabilityError,
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
  type HarnessaaSVertical,
} from "./types.js";

const PRODUCT = "harnessaas";
const DEFAULT_CAPABILITY_VERSION = "0.0.0";
const DEFAULT_VERTICAL: HarnessaaSVertical = "code-repair";

/**
 * Feature key for the base `solve` operation (ADR-0019 §D6). A
 * caller-supplied `capabilitiesSnapshot` for an unrecognized/future
 * HarnessaaS version that omits this key is treated as unknown/unsupported,
 * never as "assume supported" — see `solve()` below.
 */
const SOLVE_FEATURE = "solve";

/**
 * Feature key for the `lineage` read. Defense in depth only: `lineage()` is
 * a safe read and is not one of ADR-0019 §D6's five gated categories
 * (mutation, spend, consent, installation, code execution), so this flag
 * being false/absent is a soft signal, not itself mandated by the ADR.
 */
const LINEAGE_FEATURE = "lineage";

/**
 * Per-vertical feature key for `solve()` (ADR-0011's `vertical` field, this
 * module's own `HarnessaaSVertical` type). Only `code-repair` is modeled by
 * this SDK pass — `./types.js`'s doc comment explains that the other three
 * verticals each require a compound request field
 * (`finding`/`scanner_command`, `migration`/`build_command`,
 * `test_generation`/`coverage_command`) this client does not type or
 * serialize. Sending one of those verticals without its compound field is
 * real, currently-reachable misuse (a caller can set
 * `vertical: "security-remediation"` today and this client would happily
 * POST an incomplete request), so this is the genuine capability dimension
 * `solve()` gates on locally — not a vacuous always-true check.
 */
function solveVerticalFeature(vertical: HarnessaaSVertical): string {
  return `solve.vertical.${vertical}`;
}

/**
 * The only capability snapshot this SDK can vouch for without a published
 * runtime capabilities endpoint (ADR-0019 §D6: "the SDK may use a checked-in
 * compatibility table keyed by exact tested version"). Verified against
 * `cognitum-one/harnessaas@908e4a99` (see this module's and `./types.ts`'s
 * doc comments): `solve` (code-repair vertical only) and `lineage` are the
 * two confirmed-working synchronous operations; the other three verticals
 * are explicitly NOT modeled this pass and MUST NOT be treated as supported.
 */
const DEFAULT_CAPABILITY_SNAPSHOT: CapabilitySet = {
  product: PRODUCT,
  productVersion: DEFAULT_CAPABILITY_VERSION,
  protocol: "cognitum.harnessaas.http",
  protocolVersion: "1.0",
  features: {
    [SOLVE_FEATURE]: true,
    [LINEAGE_FEATURE]: true,
    [solveVerticalFeature("code-repair")]: true,
    [solveVerticalFeature("security-remediation")]: false,
    [solveVerticalFeature("dependency-migration")]: false,
    [solveVerticalFeature("test-generation")]: false,
  },
  limitations: [
    "solve() is verified only for the code-repair vertical; security-remediation, " +
      "dependency-migration, and test-generation each require a compound request field " +
      "(finding/scanner_command, migration/build_command, test_generation/coverage_command " +
      "respectively) this SDK pass does not model, so those verticals are not locally " +
      "supported even though the server may accept them",
  ],
  authMethods: ["X-API-Key", "Authorization: Bearer"],
  source: "static-compatibility-table",
};

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
    return this.config.capabilitiesSnapshot ?? DEFAULT_CAPABILITY_SNAPSHOT;
  }

  /**
   * Fail closed BEFORE any HTTP call if the resolved capability set (an
   * operator-supplied `capabilitiesSnapshot`, or this SDK's own
   * known-tested default) does not affirmatively mark `solve` and the
   * requested `vertical` as supported (ADR-0019 §D6). `solve()` is
   * simultaneously a mutation, a spend trigger, and — given HarnessaaS's
   * untrusted-repository/command-execution trust boundary — a
   * code-execution trigger, so an unknown or unsupported capability MUST
   * be rejected locally rather than reaching the network.
   */
  private assertSolveCapability(vertical: HarnessaaSVertical): void {
    const caps = this.capabilities();
    if (caps.features[SOLVE_FEATURE] !== true) {
      throw new UnsupportedCapabilityError(
        PRODUCT,
        "solve",
        SOLVE_FEATURE,
        `HarnessaaSClient.solve is unsupported or unknown for the resolved capability set ` +
          `(product_version "${caps.productVersion}"). Refusing to call POST /solve — a ` +
          `mutating, billable, code-execution-triggering operation — before verifying support ` +
          `(ADR-0019 §D6).`,
      );
    }
    const verticalFeature = solveVerticalFeature(vertical);
    if (caps.features[verticalFeature] !== true) {
      throw new UnsupportedCapabilityError(
        PRODUCT,
        "solve",
        verticalFeature,
        `HarnessaaSClient.solve vertical "${vertical}" is unsupported or unknown for the ` +
          `resolved capability set (product_version "${caps.productVersion}"). Only the ` +
          `"code-repair" vertical is modeled/verified by this SDK pass; refusing to send an ` +
          `incomplete request for a vertical whose compound fields this client does not ` +
          `serialize, before any spend or code execution occurs (ADR-0019 §D6).`,
      );
    }
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
    this.assertSolveCapability(request.vertical ?? DEFAULT_VERTICAL);
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
    // Defense in depth only (see `LINEAGE_FEATURE`'s doc comment above):
    // `lineage()` is a safe read, not one of ADR-0019 §D6's five gated
    // categories, but gating it too keeps "unknown version" handling
    // uniform if a future capabilitiesSnapshot narrows what a given
    // HarnessaaS version's response shape supports.
    if (this.capabilities().features[LINEAGE_FEATURE] !== true) {
      throw new UnsupportedCapabilityError(
        PRODUCT,
        "lineage",
        LINEAGE_FEATURE,
        `HarnessaaSClient.lineage is unsupported or unknown for the resolved capability set ` +
          `(product_version "${this.capabilities().productVersion}").`,
      );
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
