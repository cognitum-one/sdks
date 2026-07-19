/**
 * Non-streaming HTTP call logic for the two "direct nonstream call[s]
 * whose accepted contract declares safe replay" named in ADR-0024a §D7:
 * `chat.completions` and `messages.create`. Issue #58 / M2 continuation.
 *
 * Deliberately out of scope here (see the tracking issue): streaming/SSE
 * parsing (§D5), the other three protocol operations (`completions`,
 * `responses`, `embeddings`), and ADR-0024b routing controls.
 *
 * Retry (ADR-0023 §D3/§D4, ADR-0024a §D6):
 * - 401: at most one credential refresh after a verified challenge (the
 *   401 response itself), then retry once with the same idempotency key
 *   and body. A second 401 is returned as-is.
 * - 429/502/503: bounded retry using the frozen `RetryPolicy` /
 *   `equalJitterDelayMs` (ADR-0005/ADR-0023 verbatim), gated on the
 *   idempotency-with-key binding built in `./idempotency.js` — this is
 *   what makes the replay safe. Issue #100: before each bounded-retry
 *   attempt (not just the initial acquire), the credential is checked for
 *   local expiry (`Credential.expiresAt`) and proactively re-acquired if
 *   it has already expired locally — see `isCredentialLocallyExpired`
 *   below — rather than resending a known-expired bearer token and
 *   waiting for the guaranteed 401.
 * - 400/403/404/409/402/422 and anything else: never retried.
 */

import {
  AgenticError,
  DEFAULT_RETRY_POLICY,
  assertScopeGranted,
  equalJitterDelayMs,
  type Credential,
  type CredentialProvider,
  type RequestContext,
} from "../agentic/index.js";
import type { MetaLlmTelemetryHooks, MetaLlmTransport } from "./config.js";
import type { MetaLlmResponseMeta, MetaLlmResult } from "./envelope.js";
import { mapMetaLlmHttpError } from "./http-errors.js";
import { buildIdempotencyBinding, canonicalRequestSha256 } from "./idempotency.js";
import { parseMetaLlmReceipt } from "./types/receipt.js";
import { assertSendableRoutingControls, type MetaLlmRoutingControls } from "./types/routing.js";

const PRODUCT = "meta-llm";
/**
 * Required scope for the inference-serving operations in this pass.
 * Distinct from `client.ts`'s `"meta-llm.read"` — these are mutating
 * generation calls, not discovery reads (ADR-0024a §D8).
 */
const INFERENCE_SCOPE = "meta-llm.inference";

/**
 * Per-operation required-scope map for ADR-0022 §D5's scope preflight,
 * covering every "completion-family route" per ADR-0024a §D8 that shares
 * this module's `postJsonIdempotent`/credential path.
 *
 * PROVISIONAL: no ADR-0020 OpenAPI/JSON-Schema contract bundle publishing
 * a real scope-token vocabulary exists yet (ADR-0024a §D9 gate #1/#8), so
 * every completion-family operation maps to the same literal
 * `INFERENCE_SCOPE` already used in the `CredentialRequest` sent to
 * `acquire()` above — this is not a richer taxonomy, just naming the
 * mapping explicitly so a real per-operation vocabulary can slot in later
 * without changing the preflight call site.
 */
const OPERATION_REQUIRED_SCOPE: Record<string, string> = {
  "chat.completions": INFERENCE_SCOPE,
  "chat.completionsStream": INFERENCE_SCOPE,
  "messages.create": INFERENCE_SCOPE,
  "messages.countTokens": INFERENCE_SCOPE,
  completions: INFERENCE_SCOPE,
  responses: INFERENCE_SCOPE,
  embeddings: INFERENCE_SCOPE,
};

/**
 * Exported (rather than kept module-private) so `./stream/chat-completions-stream.js`
 * can generate request IDs the same way, without duplicating this logic —
 * streaming reuses this module's credential/auth helpers verbatim (issue #58,
 * D5 streaming pass).
 */
export function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/** Minimal dependency bag `postJsonIdempotent` needs from `MetaLlmClient`. */
export interface NonstreamDeps {
  baseUrl: string;
  transport: MetaLlmTransport;
  credentialProvider?: CredentialProvider;
  defaultRequestContext?: Partial<RequestContext>;
  telemetry?: MetaLlmTelemetryHooks;
}

/** Exported for reuse by `./stream/chat-completions-stream.js` (issue #58 D5 streaming pass). */
export function applyAuth(headers: Record<string, string>, credential: Credential): void {
  // The SDK sends exactly one contracted placement per operation
  // (ADR-0024a §D8) — same rule as `client.ts`'s GET path.
  if (credential.scheme.toLowerCase() === "bearer") {
    headers.Authorization = `Bearer ${credential.secret.reveal()}`;
  } else {
    headers[credential.scheme] = credential.secret.reveal();
  }
}

/** Exported for reuse by `./stream/chat-completions-stream.js` (issue #58 D5 streaming pass). */
export async function requireCredential(deps: NonstreamDeps, operation: string): Promise<Credential> {
  const provider = deps.credentialProvider;
  if (!provider) {
    throw new AgenticError(
      "authentication",
      `MetaLlmClient.${operation} requires a credentialProvider`,
      { product: PRODUCT, operation, retryable: false },
    );
  }
  const requiredScope = OPERATION_REQUIRED_SCOPE[operation] ?? INFERENCE_SCOPE;
  const credential = await provider.acquire({
    product: PRODUCT,
    normalizedOrigin: deps.baseUrl,
    audience: deps.baseUrl,
    requiredScopes: [requiredScope],
    operation,
    interactiveAllowed: false,
  });
  // ADR-0022 §D5 scope preflight: fail closed BEFORE any I/O when the
  // credential's granted scopes are known and insufficient. A credential
  // with unknown (`undefined`) granted scopes — e.g.
  // `StaticApiKeyCredentialProvider`'s today — is sent through unchecked;
  // the server remains authoritative for that case.
  assertScopeGranted(PRODUCT, operation, requiredScope, credential);
  return credential;
}

/**
 * True when `credential.expiresAt` is set and already at or before "now"
 * (issue #100). Checked before each bounded 429/502/503 retry attempt so
 * an OAuth credential (unlike a static API key, it carries a real
 * `expiresAt`) that expired during the retry-delay window is proactively
 * re-acquired — triggering a refresh via the provider's callback, if one
 * is configured — instead of resending an already-locally-known-expired
 * bearer token and waiting for the guaranteed 401 on the next attempt. A
 * missing or unparsable `expiresAt` is never treated as expired here — the
 * server remains authoritative, same as the scope-preflight check above.
 */
function isCredentialLocallyExpired(credential: Credential, now: () => number = Date.now): boolean {
  if (credential.expiresAt === undefined) {
    return false;
  }
  const expiresAtMs = Date.parse(credential.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= now();
}

/** One HTTP attempt. Never retries by itself — the caller owns that. */
async function sendPostOnce<T>(
  deps: NonstreamDeps,
  path: string,
  operation: string,
  body: unknown,
  credential: Credential,
  idempotencyKey: string,
): Promise<{ data: T; meta: MetaLlmResponseMeta }> {
  const requestId = newRequestId();
  deps.telemetry?.onRequestStart?.({ operation, requestId });
  const startedAt = Date.now();

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Cognitum-Request-Id": requestId,
    // ADR-0024a §D7 / ADR-0005: the caller-attested idempotency key,
    // stable across every retry of one logical call.
    "Idempotency-Key": idempotencyKey,
  };
  applyAuth(headers, credential);

  const url = `${deps.baseUrl}${path}`;
  let response: Response;
  try {
    response = await deps.transport(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (cause) {
    deps.telemetry?.onRequestEnd?.({ operation, requestId, durationMs: Date.now() - startedAt });
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
  const idempotentReplayHeader = response.headers.get("x-cognitum-idempotent-replay");
  const idempotentReplay =
    idempotentReplayHeader !== null ? idempotentReplayHeader.toLowerCase() === "true" : undefined;

  deps.telemetry?.onRequestEnd?.({
    operation,
    requestId,
    httpStatus: response.status,
    durationMs,
    retryAfterMs,
    idempotentReplay,
  });

  if (!response.ok) {
    const err = await mapMetaLlmHttpError(response, operation, requestId);
    if (err.retryAfterMs === undefined) {
      (err as { retryAfterMs?: number }).retryAfterMs = retryAfterMs;
    }
    throw err;
  }

  const rawJson: unknown = await response.json();
  const data = rawJson as T;
  // ADR-0024b §D3/§D11 step 1: decode a `cognitum_receipt` field embedded in
  // the response body, if present, into the typed `MetaLlmReceipt` — same
  // wire key the SSE path already recognizes (`./stream/openai-events.ts`).
  const receipt =
    rawJson !== null && typeof rawJson === "object" && !Array.isArray(rawJson)
      ? parseMetaLlmReceipt((rawJson as Record<string, unknown>).cognitum_receipt)
      : undefined;
  const meta: MetaLlmResponseMeta = {
    requestId: response.headers.get("x-cognitum-request-id") ?? requestId,
    httpStatus: response.status,
    protocolVersion: response.headers.get("x-cognitum-protocol-version") ?? undefined,
    retryAfterMs,
    idempotentReplay,
    receipt,
  };
  return { data, meta };
}

/**
 * Shared idempotent-with-key POST used by `chat.completions` and
 * `messages.create`. Returns the parsed JSON body plus response metadata;
 * callers cast/validate into their own protocol-specific response type.
 */
export async function postJsonIdempotent<T>(
  deps: NonstreamDeps,
  path: string,
  operation: string,
  body: unknown,
): Promise<MetaLlmResult<T>> {
  // ADR-0024b §D2: fail locally, before any network I/O or credential
  // acquisition, rather than sending an unrecognized enum member or a raw
  // provider model ID the resolver would reject anyway. `routingControls`
  // is an optional field on the request body itself (§D2: "Body controls
  // win over `X-Cognitum-*` headers" — there is no separate header path to
  // validate), so every operation that might carry one is covered here in
  // one place rather than duplicated per call site in `./client.ts`.
  const bodyRoutingControls = (body as { routingControls?: MetaLlmRoutingControls } | null | undefined)
    ?.routingControls;
  try {
    assertSendableRoutingControls(bodyRoutingControls);
  } catch (cause) {
    throw new AgenticError("validation", `${operation} routingControls rejected: ${(cause as Error).message}`, {
      product: PRODUCT,
      operation,
      retryable: false,
      cause,
    });
  }

  let credential = await requireCredential(deps, operation);
  const idempotencyKey =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : newRequestId();
  const canonicalSha256 = canonicalRequestSha256(body);
  const tenant = deps.defaultRequestContext?.tenant;

  const retryPolicy = DEFAULT_RETRY_POLICY;
  let attempt = 0;
  let sleepBudgetUsedMs = 0;
  let refreshedOnce = false;

  for (;;) {
    // Binding is (re)built each attempt so a refreshed credential's
    // principal/tenant is reflected, but `idempotencyKey`/`canonicalSha256`
    // (and therefore the binding's identity) never change across retries.
    const binding = buildIdempotencyBinding(
      operation,
      path,
      credential,
      tenant,
      canonicalSha256,
      idempotencyKey,
    );

    try {
      return await sendPostOnce<T>(deps, path, operation, body, credential, idempotencyKey);
    } catch (cause) {
      const err = cause as AgenticError;
      // ADR-0023 §D5: a 409 means the server detected a changed binding
      // for a reused key. Surface the client's own binding identity in
      // `details` (non-secret) so callers can see exactly what was bound
      // without a second round trip.
      if (err.status === 409 && err.details === undefined) {
        (err as { details?: unknown }).details = {
          idempotencyKey: binding.idempotencyKey,
          normalizedRouteIdentity: binding.normalizedRouteIdentity,
          contractMajor: binding.contractMajor,
        };
      }
      if (err.status === 401 && !refreshedOnce) {
        refreshedOnce = true;
        await deps.credentialProvider?.invalidate("401 challenge from meta-llm");
        credential = await requireCredential(deps, operation);
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
        // Issue #100: the delay above may have crossed the credential's
        // expiry. Proactively re-acquire instead of resending an
        // already-locally-expired bearer token and waiting for the wasted
        // 401 round trip.
        if (isCredentialLocallyExpired(credential)) {
          credential = await requireCredential(deps, operation);
        }
        continue;
      }

      throw err;
    }
  }
}
