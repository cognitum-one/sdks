/**
 * Non-streaming `chat.completions` forwarding for MetaProxyClient
 * (ADR-0025a §D7). Streaming (§D8) is out of scope this pass.
 *
 * ADR-0025a §D7 says Proxy chat/Messages "reuse only the wire types and
 * stream events" from ADR-0024a — so this module imports `ChatCompletion`/
 * `ChatCompletionRequest` from `../meta-llm/types/openai.js` verbatim, but
 * deliberately does NOT call `../meta-llm/nonstream.js`'s `postJsonIdempotent`:
 * that helper carries Proxy-inappropriate behavior (ADR-0024b `routingControls`
 * validation, `cognitum_receipt` decoding into a `MetaLlmReceipt`, and
 * meta-llm error mapping). The surrounding forwarding / retry / error contract
 * is Proxy-specific (§D7), so the idempotency + retry shape is re-implemented
 * lightly here:
 *  - a generated (or caller-supplied) `Idempotency-Key`, stable across the
 *    one possible 401-triggered retry;
 *  - at most one 401 credential refresh after a verified 401 challenge;
 *  - everything else — 429/502/503 included — is NEVER automatically
 *    retried (ADR-0025a §D8: "No Proxy POST is automatically retried while
 *    it drops `Idempotency-Key`"). That sentence is about whether the
 *    *Proxy server* honors the header for dedup — the currently-deployed
 *    Proxy drops it — so attaching one client-side does not make a retry
 *    safe. The Alternatives-considered table rejects "Retry Proxy POSTs"
 *    outright ("Idempotency is dropped and spend can duplicate"). A
 *    non-2xx surfaces as a single terminal, non-retryable `AgenticError`
 *    carrying `retryAfterMs` so the CALLER can retry manually. Bounded
 *    retry is reserved for the read-only status/models/identity routes
 *    (§D8), which this module does not implement.
 *
 * Security posture layered on top (§D6/§D10):
 *  - only an allowlist of caller headers is forwarded; `Authorization`, the
 *    local bearer, `Host`, `Content-Length`, sponsor markers, installation
 *    identity, and training-consent headers are NEVER caller-forwarded — the
 *    bearer comes only from validated local state (the credential provider);
 *  - the bearer is attached only when the origin is literal loopback (or
 *    `allowNonLoopback` was explicitly set) — a defense-in-depth re-check on
 *    top of construction-time validation;
 *  - `redirect: "manual"` on every request; a 3xx / opaque-redirect response
 *    is surfaced as a non-retryable protocol error, never followed;
 *  - ambient HTTP proxy env vars are ignored: the transport is called
 *    directly with only `{ method, headers, body, redirect }` — no dispatcher,
 *    agent, or proxy option is ever wired in.
 */

import {
  AgenticError,
  type Credential,
  type CredentialProvider,
  type RequestContext,
} from "../agentic/index.js";
import type { ChatCompletion, ChatCompletionRequest } from "../meta-llm/types/openai.js";
import { isBearerAttachmentAllowed } from "./config.js";
import type { MetaProxyTelemetryHooks, MetaProxyTransport } from "./config.js";
import type { MetaProxyResponseMeta, MetaProxyResult } from "./envelope.js";
import { mapMetaProxyHttpError } from "./http-errors.js";
import { assertRoutingReceiptMatchesIntent, type RoutingIntent } from "./routing.js";
import type { MetaProxyRoutingReceipt } from "./status.js";

const PRODUCT = "meta-proxy";
const CHAT_PATH = "/v1/chat/completions";
const OPERATION = "chat.completions";
/** Mutating inference scope — distinct from `client.ts`'s `"meta-proxy.status"` read scope. */
const INFERENCE_SCOPE = "meta-proxy.inference";

/**
 * Caller headers the Proxy forwards to the target cloud when supported
 * (ADR-0025a §D7). Anything not on this list is silently dropped before the
 * outgoing request is built — a caller can never inject `Authorization`,
 * `Host`, sponsor markers, etc. Matching is case-insensitive.
 */
export const PROXY_CHAT_FORWARD_HEADER_ALLOWLIST = [
  "Idempotency-Key",
  "X-Request-ID",
  "traceparent",
  "tracestate",
  "X-Cognitum-Fallback-Policy",
  "X-Cognitum-Min-Tier",
  "X-Cognitum-Max-Tier",
  "X-Cognitum-Escalation",
  "X-Cognitum-Cache",
  "X-Cognitum-Safety",
  "X-Cognitum-Sub-Tenant",
  "anthropic-version",
  "anthropic-beta",
] as const;

const ALLOWLIST_LOWER = new Set(
  PROXY_CHAT_FORWARD_HEADER_ALLOWLIST.map((h) => h.toLowerCase()),
);

/** Options accepted by `MetaProxyClient.chat.completions`. */
export interface MetaProxyChatCallOptions {
  requestContext?: Record<string, unknown>;
  /**
   * Supported routing intent (ADR-0025a §D5). When `requiredPlane` is set the
   * returned receipt is verified against it and a mismatch throws a
   * non-retryable protocol error — even on an otherwise-valid 200.
   */
  routingIntent?: RoutingIntent;
  /**
   * Caller headers to forward. Only members of
   * {@link PROXY_CHAT_FORWARD_HEADER_ALLOWLIST} are passed through (case-
   * insensitive); everything else is dropped before the request is sent, so a
   * caller cannot syntactically inject `Authorization` or any other protected
   * header into the outgoing request.
   */
  forwardHeaders?: Record<string, string>;
}

/** Dependency bag `forwardChatCompletion` needs from `MetaProxyClient`. */
export interface ChatForwardDeps {
  origin: string;
  transport: MetaProxyTransport;
  credentialProvider?: CredentialProvider;
  allowNonLoopback?: boolean;
  defaultRequestContext?: Partial<RequestContext>;
  telemetry?: MetaProxyTelemetryHooks;
}

/** Exported so `./stream/chat-completions-stream.js` can mint the same shape of request ID. */
export function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/** Exported so `./stream/chat-completions-stream.js` can mint a stable idempotency key. */
export function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : newRequestId();
}

/**
 * Reject a redirect response outright (ADR-0025a §D6/§D10: "Cross-origin
 * redirects, rebinding hostnames, embedded credentials, and downgrade
 * redirects are rejected"). Handles both a real `fetch` opaque redirect
 * (`type === "opaqueredirect"`, `status === 0`, produced by
 * `redirect: "manual"`) and an explicit 3xx surfaced by a mock transport.
 * Exported so `client.ts`'s GET path applies the identical rule.
 */
export function rejectRedirectResponse(
  response: { status: number; type?: string; headers: { get(name: string): string | null } },
  operation: string,
  requestId: string,
): void {
  const isRedirect =
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400);
  if (!isRedirect) return;
  throw new AgenticError(
    "protocol",
    `${operation} received a redirect (status ${response.status}) — redirects are ` +
      `rejected, not followed (ADR-0025a §D6/§D10)`,
    { product: PRODUCT, operation, status: response.status, requestId, retryable: false },
  );
}

/**
 * Filter a caller header bag down to the forwarding allowlist (case-insensitive).
 * Exported so `./stream/chat-completions-stream.js` applies the identical filter.
 */
export function filterForwardHeaders(
  bag: Record<string, string> | undefined,
): { forwarded: Record<string, string>; idempotencyKey?: string } {
  const forwarded: Record<string, string> = {};
  let idempotencyKey: string | undefined;
  if (!bag) return { forwarded };
  for (const [key, value] of Object.entries(bag)) {
    const lower = key.toLowerCase();
    if (!ALLOWLIST_LOWER.has(lower)) continue; // protected / unknown header — dropped
    if (lower === "idempotency-key") {
      // Handled explicitly so it is stable across retries; not merged raw.
      idempotencyKey = value;
      continue;
    }
    forwarded[key] = value;
  }
  return { forwarded, idempotencyKey };
}

/** Exported so `./stream/chat-completions-stream.js` places the bearer identically. */
export function applyBearer(deps: ChatForwardDeps, headers: Record<string, string>, credential: Credential): void {
  // Defense in depth (ADR-0025a §D6/§D10): never attach the bearer to a
  // non-loopback origin unless allowNonLoopback was explicitly set. Construction
  // already guarantees this, so reaching the throw means config was mutated.
  if (!isBearerAttachmentAllowed(deps.origin, deps.allowNonLoopback)) {
    throw new AgenticError(
      "protocol",
      `refusing to attach the local bearer to non-loopback origin "${deps.origin}" ` +
        `(ADR-0025a §D6/§D10: the bearer is sent only to literal loopback)`,
      { product: PRODUCT, operation: OPERATION, retryable: false },
    );
  }
  // Exactly one contracted placement — the local bearer maps to Authorization.
  headers.Authorization = `Bearer ${credential.secret.reveal()}`;
}

/** Exported so `./stream/chat-completions-stream.js` acquires a credential identically. */
export async function requireCredential(deps: ChatForwardDeps): Promise<Credential> {
  const provider = deps.credentialProvider;
  if (!provider) {
    throw new AgenticError(
      "authentication",
      `MetaProxyClient.${OPERATION} requires a localCredentialProvider (ADR-0025a §D6)`,
      { product: PRODUCT, operation: OPERATION, retryable: false },
    );
  }
  return provider.acquire({
    product: PRODUCT,
    normalizedOrigin: deps.origin,
    audience: deps.origin,
    requiredScopes: [INFERENCE_SCOPE],
    operation: OPERATION,
    interactiveAllowed: false,
  });
}

function pick(data: Record<string, unknown>, snake: string, camel: string): unknown {
  return data[snake] ?? data[camel];
}

/**
 * Decode a Proxy routing receipt from an inference body (ADR-0025a §D4/§D7).
 * Exported so `./stream/chat-completions-stream.js` decodes a streaming
 * terminal receipt with the identical logic.
 */
export function parseRoutingReceipt(value: unknown): MetaProxyRoutingReceipt | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  return {
    requestId: String(pick(r, "request_id", "requestId") ?? ""),
    configuredPlane: String(pick(r, "configured_plane", "configuredPlane") ?? ""),
    selectedPlane: String(pick(r, "selected_plane", "selectedPlane") ?? ""),
    routingReason: pick(r, "routing_reason", "routingReason") as string | undefined,
    automatic: Boolean(r.automatic),
    workloadPolicy: pick(r, "workload_policy", "workloadPolicy") as string | undefined,
    consentEvidenceId: pick(r, "consent_evidence_id", "consentEvidenceId") as string | undefined,
    upstreamReceipt: pick(r, "upstream_receipt", "upstreamReceipt"),
    localUsage: pick(r, "local_usage", "localUsage") as Record<string, unknown> | undefined,
    degraded: Boolean(r.degraded),
    warnings: r.warnings as string[] | undefined,
  };
}

interface SendResult {
  data: ChatCompletion;
  meta: MetaProxyResponseMeta;
}

/** One HTTP attempt. Never retries by itself — the caller owns that. */
async function sendOnce(
  deps: ChatForwardDeps,
  body: ChatCompletionRequest,
  credential: Credential,
  idempotencyKey: string,
  forwarded: Record<string, string>,
): Promise<SendResult> {
  const requestId = newRequestId();
  deps.telemetry?.onRequestStart?.({ operation: OPERATION, requestId });
  const startedAt = Date.now();

  const headers: Record<string, string> = {
    // Allowlisted caller headers first, so SDK-owned headers below always win.
    ...forwarded,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Cognitum-Request-Id": requestId,
    "Idempotency-Key": idempotencyKey,
  };
  applyBearer(deps, headers, credential);

  const url = `${deps.origin}${CHAT_PATH}`;
  let response: Response;
  try {
    response = await deps.transport(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // Never follow redirects (ADR-0025a §D6/§D10). No proxy/dispatcher/agent
      // option is passed — ambient HTTP_PROXY/HTTPS_PROXY/NO_PROXY are ignored.
      redirect: "manual",
    });
  } catch (cause) {
    deps.telemetry?.onRequestEnd?.({ operation: OPERATION, requestId, durationMs: Date.now() - startedAt });
    throw new AgenticError("transport", `${OPERATION} request failed: ${cause}`, {
      product: PRODUCT,
      operation: OPERATION,
      requestId,
      retryable: true,
      cause,
    });
  }

  const durationMs = Date.now() - startedAt;
  const retryAfterHeader = response.headers.get("retry-after");
  deps.telemetry?.onRequestEnd?.({
    operation: OPERATION,
    requestId,
    httpStatus: response.status,
    durationMs,
    retryAfterMs: retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined,
  });

  rejectRedirectResponse(response, OPERATION, requestId);

  if (!response.ok) {
    const err = await mapMetaProxyHttpError(response, OPERATION, requestId);
    if (err.retryAfterMs === undefined && retryAfterHeader) {
      (err as { retryAfterMs?: number }).retryAfterMs = Number(retryAfterHeader) * 1000;
    }
    throw err;
  }

  const rawJson = (await response.json()) as Record<string, unknown>;
  const routingReceipt = parseRoutingReceipt(
    pick(rawJson, "cognitum_routing_receipt", "cognitumRoutingReceipt"),
  );
  const upstreamReceipt = pick(rawJson, "cognitum_upstream_receipt", "cognitumUpstreamReceipt");

  const meta: MetaProxyResponseMeta = {
    requestId: response.headers.get("x-cognitum-request-id") ?? requestId,
    productVersion: response.headers.get("x-cognitum-product-version") ?? undefined,
    protocolVersion: response.headers.get("x-cognitum-protocol-version") ?? undefined,
    httpStatus: response.status,
    retryAfter: retryAfterHeader ? Number(retryAfterHeader) : undefined,
    routingReceipt,
    upstreamReceipt,
  };
  return { data: rawJson as unknown as ChatCompletion, meta };
}

/**
 * `POST /v1/chat/completions` through the Proxy (ADR-0025a §D7, non-streaming).
 * Returns a Proxy result whose `meta` carries the selected-plane routing
 * receipt; verifies it against `options.routingIntent.requiredPlane` (§D5
 * rule 7) before returning.
 */
export async function forwardChatCompletion(
  deps: ChatForwardDeps,
  request: ChatCompletionRequest,
  options?: MetaProxyChatCallOptions,
): Promise<MetaProxyResult<ChatCompletion>> {
  const { forwarded, idempotencyKey: callerKey } = filterForwardHeaders(options?.forwardHeaders);
  const idempotencyKey = callerKey ?? newIdempotencyKey();

  let credential = await requireCredential(deps);

  let refreshedOnce = false;

  for (;;) {
    let result: SendResult;
    try {
      result = await sendOnce(deps, request, credential, idempotencyKey, forwarded);
    } catch (cause) {
      const err = cause as AgenticError;
      if (err.status === 401 && !refreshedOnce) {
        refreshedOnce = true;
        await deps.credentialProvider?.invalidate("401 challenge from meta-proxy");
        credential = await requireCredential(deps);
        continue;
      }
      // ADR-0025a §D8: "No Proxy POST is automatically retried while it
      // drops `Idempotency-Key`" — the currently-deployed Proxy does not
      // honor the header for server-side dedup, so attaching one does not
      // make a retry safe. 429/502/503 (and every other status) surface as
      // a single terminal error; `err.retryAfterMs` lets the caller retry
      // manually.
      throw err;
    }

    // Success path — verify the returned plane against caller intent (§D5 rule
    // 7). This throws on mismatch even though the HTTP call was a valid 200.
    assertRoutingReceiptMatchesIntent(options?.routingIntent, result.meta.routingReceipt);
    return result;
  }
}
