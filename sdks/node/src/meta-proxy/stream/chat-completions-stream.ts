/**
 * `chat.completionsStream` HTTP + SSE orchestration for `MetaProxyClient`
 * (ADR-0025a §D8, M3 continuation of issue #61).
 *
 * §D8: "Chat and Messages use ADR-0024a's lossless protocol streams and add
 * plane and Proxy version metadata." This module REUSES, rather than
 * reimplements:
 *  - PR #88's generic byte-level SSE parser (`../../sse/parser.js`);
 *  - PR #88/#93's OpenAI event decoder (`../../meta-llm/stream/openai-events.js`)
 *    — the byte-forwarded stream is decoded exactly like direct Meta LLM
 *    streaming (the Proxy forwards the same OpenAI wire shape verbatim,
 *    §D7: "reuse only the wire types and stream events");
 *  - `../forwarding.js`'s §D7 header allowlist, credential acquisition,
 *    bearer placement, idempotency-key minting, and routing-receipt decode
 *    helpers, so a caller sees byte-for-byte identical forwarding behavior
 *    whether they call the streaming or non-streaming method.
 *
 * On top of the reused pieces, this module adds exactly what §D8 asks for
 * beyond ADR-0024a's stream contract:
 *  - `MetaProxyStreamEnvelope.proxyMeta` (plane/version metadata, `./envelope.js`);
 *  - `ProxyTimeBudget`'s `connectTimeoutMs`/`overallDeadlineMs` (`../time-budget.js`),
 *    raced around the pre-byte HTTP attempt(s) in addition to the
 *    firstByte/idle races PR #88 already proved correct for the post-byte
 *    read loop;
 *  - the §D5 rule 7 required-plane check (`../routing.js`'s
 *    `assertRoutingReceiptMatchesIntent`, the SAME function the
 *    non-streaming path uses), applied to the LAST routing receipt observed
 *    on the wire before the stream's native terminal event.
 *
 * Retry contract (ADR-0025a §D8, and the just-fixed eb553f7 bug this MUST
 * NOT reintroduce): the pre-byte phase performs at most one 401-triggered
 * credential refresh and NEVER bounded-retries a 429/502/503 — "No Proxy
 * POST is automatically retried while it drops `Idempotency-Key`" describes
 * the currently-deployed Proxy dropping the header server-side, not whether
 * the SDK attaches one; attaching one client-side does not make a retry
 * safe. A non-2xx pre-byte response is therefore always a single terminal,
 * non-retryable error (`err.retryAfterMs` lets the CALLER retry manually).
 * Once any response byte has been read, there is NO retry at all, period —
 * "A pre-response disconnect may already have incurred work" only applies
 * pre-byte; post-byte a disconnect is unconditionally terminal, mirroring
 * PR #88's `../../meta-llm/stream/chat-completions-stream.js` exactly.
 *
 * Sponsored streaming (`stream: true` on a sponsored-plane call) is
 * explicitly OUT of scope this pass — see `../client.js`'s
 * `previewSponsoredChatCompletions` for the fail-fast guard (§D8: "Sponsored
 * `stream = true` fails locally until an end-to-end stream capability
 * exists").
 */

import {
  AgenticError,
  type CancellationToken,
  type RequestContext,
} from "../../agentic/index.js";
import { decodeOpenAiSseEvent, type OpenAiStreamEvent } from "../../meta-llm/stream/openai-events.js";
import { SseParser, type SseEvent } from "../../sse/parser.js";
import type { ChatCompletionRequest } from "../../meta-llm/types/openai.js";
import { rejectRedirectResponse } from "../forwarding.js";
import {
  applyBearer,
  filterForwardHeaders,
  newIdempotencyKey,
  newRequestId,
  parseRoutingReceipt,
  requireCredential,
  type ChatForwardDeps,
  type MetaProxyChatCallOptions,
} from "../forwarding.js";
import { mapMetaProxyHttpError } from "../http-errors.js";
import { assertRoutingReceiptMatchesIntent } from "../routing.js";
import type { MetaProxyRoutingReceipt } from "../status.js";
import {
  resolveProxyTimeBudget,
  type ProxyTimeBudget,
  type ResolvedProxyTimeBudget,
} from "../time-budget.js";
import type { MetaProxyStreamEnvelope } from "./envelope.js";

const PRODUCT = "meta-proxy";
const CHAT_PATH = "/v1/chat/completions";
const OPERATION = "chat.completionsStream";

/** Options accepted by `MetaProxyClient.chat.completionsStream`. */
export interface MetaProxyChatStreamCallOptions extends MetaProxyChatCallOptions {
  timeBudget?: ProxyTimeBudget;
  cancellation?: CancellationToken;
  /** Falls back to `requestContext.requestId` when provided, then a fresh UUID. */
  requestContext?: Partial<RequestContext>;
}

function deadlineError(requestId: string, code: string, message: string, sequence: number): AgenticError {
  return new AgenticError("deadline_exceeded", message, {
    product: PRODUCT,
    operation: OPERATION,
    requestId,
    retryable: false,
    code,
    details: { partial: true, eventsReceived: sequence },
  });
}

/**
 * Races `promise` against a timer for `ms` (or awaits unbounded when `ms`
 * is `undefined`). Returns `"timeout"` if the timer wins.
 */
function raceAgainstTimeout<T>(promise: Promise<T>, ms: number | undefined): Promise<T | "timeout"> {
  if (ms === undefined) return promise;
  // Avoid an unhandled rejection if the timer wins and `promise` later rejects.
  promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * The pre-byte phase: acquire a credential, send the request, and retry ONLY
 * on a verified 401 (once) — never on 429/502/503 (ADR-0025a §D8, the
 * just-fixed eb553f7 bug this must not reintroduce). Each attempt is raced
 * against `min(connectTimeoutMs, overallDeadlineMs remaining)`; a timeout
 * aborts that attempt's connection and throws a non-retryable
 * `deadline_exceeded` error — never a silent retry.
 */
async function openStreamWithPreByteRetry(
  deps: ChatForwardDeps,
  request: ChatCompletionRequest,
  requestId: string,
  idempotencyKey: string,
  forwarded: Record<string, string>,
  budget: ResolvedProxyTimeBudget,
  overallStartedAt: number,
): Promise<{ response: Response; abortController: AbortController }> {
  let credential = await requireCredential(deps);
  const body = JSON.stringify({ ...request, stream: true });

  let refreshedOnce = false;

  for (;;) {
    const now = Date.now();
    if (budget.overallDeadlineMs !== undefined && now - overallStartedAt > budget.overallDeadlineMs) {
      throw deadlineError(
        requestId,
        "overall_deadline_exceeded",
        `${OPERATION} exceeded overallDeadlineMs (${budget.overallDeadlineMs}ms) before a response was received`,
        0,
      );
    }
    const overallRemaining =
      budget.overallDeadlineMs !== undefined
        ? Math.max(0, budget.overallDeadlineMs - (now - overallStartedAt))
        : undefined;
    const connectRemaining =
      overallRemaining !== undefined ? Math.min(budget.connectTimeoutMs, overallRemaining) : budget.connectTimeoutMs;

    const headers: Record<string, string> = {
      ...forwarded,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "X-Cognitum-Request-Id": requestId,
      "Idempotency-Key": idempotencyKey,
    };
    applyBearer(deps, headers, credential);

    const url = `${deps.origin}${CHAT_PATH}`;
    const abortController = new AbortController();
    let response: Response;
    try {
      const raced = await raceAgainstTimeout(
        deps.transport(url, { method: "POST", headers, body, redirect: "manual", signal: abortController.signal }),
        connectRemaining,
      );
      if (raced === "timeout") {
        abortController.abort();
        const overallExceeded =
          budget.overallDeadlineMs !== undefined && Date.now() - overallStartedAt > budget.overallDeadlineMs;
        throw deadlineError(
          requestId,
          overallExceeded ? "overall_deadline_exceeded" : "connect_timeout",
          overallExceeded
            ? `${OPERATION} exceeded overallDeadlineMs (${budget.overallDeadlineMs}ms) before a response was received`
            : `${OPERATION} exceeded connectTimeoutMs (${budget.connectTimeoutMs}ms) waiting for a response`,
          0,
        );
      }
      response = raced;
    } catch (cause) {
      if (cause instanceof AgenticError) throw cause;
      throw new AgenticError("transport", `${OPERATION} request failed: ${cause}`, {
        product: PRODUCT,
        operation: OPERATION,
        requestId,
        retryable: true,
        cause,
      });
    }

    rejectRedirectResponse(response, OPERATION, requestId);

    if (response.ok) return { response, abortController };

    const err = await mapMetaProxyHttpError(response, OPERATION, requestId);
    const retryAfterHeader = response.headers.get("retry-after");
    if (err.retryAfterMs === undefined && retryAfterHeader) {
      (err as { retryAfterMs?: number }).retryAfterMs = Number(retryAfterHeader) * 1000;
    }
    if (err.status === 401 && !refreshedOnce) {
      refreshedOnce = true;
      await deps.credentialProvider?.invalidate("401 challenge from meta-proxy");
      credential = await requireCredential(deps);
      continue;
    }

    // ADR-0025a §D8 / eb553f7: NEVER bounded-retry 429/502/503 (or any other
    // status) here — a single terminal error, exactly matching non-streaming
    // `forwardChatCompletion` in `../forwarding.js`.
    throw err;
  }
}

/** Decodes one raw SSE event, extracting any Proxy routing/upstream receipt from its unknown fields. */
function decodeProxyChunk(rawEvent: SseEvent): {
  events: OpenAiStreamEvent[];
  unknownFields?: Record<string, unknown>;
  routingReceipt?: MetaProxyRoutingReceipt;
  upstreamReceipt?: unknown;
} {
  const decoded = decodeOpenAiSseEvent(rawEvent);
  const routingReceipt = parseRoutingReceipt(decoded.unknownFields?.cognitum_routing_receipt);
  const upstreamReceipt = decoded.unknownFields?.cognitum_upstream_receipt;
  return { ...decoded, routingReceipt, upstreamReceipt };
}

/** The smallest remaining post-byte budget (ms), or `undefined` if none is configured. */
function remainingPostByteBudgetMs(
  now: number,
  overallStartedAt: number,
  lastByteAt: number,
  receivedFirstByte: boolean,
  budget: ResolvedProxyTimeBudget,
): number | undefined {
  const candidates: number[] = [];
  if (budget.overallDeadlineMs !== undefined) {
    candidates.push(Math.max(0, budget.overallDeadlineMs - (now - overallStartedAt)));
  }
  const idleLimit = receivedFirstByte ? budget.idleStreamTimeoutMs : budget.firstByteTimeoutMs;
  if (idleLimit !== undefined) {
    candidates.push(Math.max(0, idleLimit - (now - lastByteAt)));
  }
  return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

/**
 * Post-byte phase: read the SSE body, decode into `MetaProxyStreamEnvelope`s,
 * applying `idleStreamTimeoutMs`/`firstByteTimeoutMs`/`overallDeadlineMs` and
 * cooperative cancellation. The blocking chunk read is ALWAYS raced against
 * the smallest remaining budget (never merely checked before/after) —
 * PR #88 shipped an initial version that only checked-before, letting a
 * server that goes silent without closing hang forever; this mirrors the
 * fixed pattern from the start.
 */
async function* readProxySseBody(
  body: ReadableStream<Uint8Array>,
  requestId: string,
  headers: Headers,
  budget: ResolvedProxyTimeBudget,
  overallStartedAt: number,
  cancellation: CancellationToken | undefined,
  abortController: AbortController,
  routingIntent: MetaProxyChatCallOptions["routingIntent"],
): AsyncGenerator<MetaProxyStreamEnvelope<OpenAiStreamEvent>, void, void> {
  const reader = body.getReader();
  const parser = new SseParser();
  let sequence = 0;
  let sawNativeTerminal = false;
  const lastByteAtBox = { value: overallStartedAt };
  let receivedFirstByte = false;
  let latestRoutingReceipt: MetaProxyRoutingReceipt | undefined;
  let latestUpstreamReceipt: unknown;

  const proxyMetaBase = {
    productVersion: headers.get("x-cognitum-product-version") ?? undefined,
    protocolVersion: headers.get("x-cognitum-protocol-version") ?? undefined,
  };

  function buildEnvelopes(rawEvent: SseEvent): MetaProxyStreamEnvelope<OpenAiStreamEvent>[] {
    const decoded = decodeProxyChunk(rawEvent);
    if (decoded.routingReceipt) latestRoutingReceipt = decoded.routingReceipt;
    if (decoded.upstreamReceipt !== undefined) latestUpstreamReceipt = decoded.upstreamReceipt;
    return decoded.events.map((event) => {
      sequence += 1;
      return {
        event,
        sequence,
        receivedAt: new Date().toISOString(),
        requestId,
        rawEventName: rawEvent.event,
        unknownFields: decoded.unknownFields,
        proxyMeta: {
          ...proxyMetaBase,
          routingReceipt: latestRoutingReceipt,
          upstreamReceipt: latestUpstreamReceipt,
        },
      };
    });
  }

  try {
    for (;;) {
      if (cancellation?.isCancelled) {
        throw new AgenticError("cancelled", `${OPERATION} was cancelled locally`, {
          product: PRODUCT,
          operation: OPERATION,
          requestId,
          retryable: false,
          code: "local_cancellation",
          details: { partial: true, eventsReceived: sequence },
        });
      }
      const now = Date.now();
      if (budget.overallDeadlineMs !== undefined && now - overallStartedAt > budget.overallDeadlineMs) {
        throw deadlineError(
          requestId,
          "overall_deadline_exceeded",
          `${OPERATION} exceeded overallDeadlineMs (${budget.overallDeadlineMs}ms)`,
          sequence,
        );
      }
      const idleLimit = receivedFirstByte ? budget.idleStreamTimeoutMs : budget.firstByteTimeoutMs;
      if (idleLimit !== undefined && now - lastByteAtBox.value > idleLimit) {
        throw deadlineError(
          requestId,
          receivedFirstByte ? "idle_stream_timeout" : "first_byte_timeout",
          `${OPERATION} exceeded ${receivedFirstByte ? "idleStreamTimeoutMs" : "firstByteTimeoutMs"} (${idleLimit}ms)`,
          sequence,
        );
      }

      // Bound the otherwise-unbounded blocking read against whichever budget
      // is smallest, so a server that accepts the connection and then goes
      // silent without closing the socket cannot hang this generator forever.
      const remainingMs = remainingPostByteBudgetMs(
        now,
        overallStartedAt,
        lastByteAtBox.value,
        receivedFirstByte,
        budget,
      );

      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        const raced = await raceAgainstTimeout(reader.read(), remainingMs);
        if (raced === "timeout") {
          // Abort the underlying fetch so the hung connection is actually
          // released, then loop back to the top: the precise checks above
          // (using a fresh `Date.now()`) determine and throw the correctly
          // coded error.
          abortController.abort();
          continue;
        }
        readResult = raced;
      } catch (cause) {
        throw new AgenticError("transport", `${OPERATION} stream read failed: ${cause}`, {
          product: PRODUCT,
          operation: OPERATION,
          requestId,
          retryable: false,
          code: "stream_disconnected",
          details: { partial: true, eventsReceived: sequence },
          cause,
        });
      }
      if (readResult.done) break;

      receivedFirstByte = true;
      lastByteAtBox.value = Date.now();

      let rawEvents: SseEvent[];
      try {
        rawEvents = parser.feed(readResult.value);
      } catch (cause) {
        throw new AgenticError("protocol", `${OPERATION} SSE parse failure: ${cause}`, {
          product: PRODUCT,
          operation: OPERATION,
          requestId,
          retryable: false,
          code: "sse_parse_error",
          details: { partial: true, eventsReceived: sequence },
          cause,
        });
      }

      for (const rawEvent of rawEvents) {
        for (const envelope of buildEnvelopes(rawEvent)) {
          // A wire-level terminal error event is ALSO a valid stream
          // terminus (ADR-0025a §D8: "still requires ... terminal error") —
          // not just the clean done/finish_reason path.
          if (
            envelope.event.type === "done" ||
            envelope.event.type === "finish_reason" ||
            envelope.event.type === "error"
          ) {
            sawNativeTerminal = true;
          }
          yield envelope;
        }
      }
    }

    let finishResult;
    try {
      finishResult = parser.finish();
    } catch (cause) {
      throw new AgenticError("protocol", `${OPERATION} SSE parse failure at end of stream: ${cause}`, {
        product: PRODUCT,
        operation: OPERATION,
        requestId,
        retryable: false,
        code: "sse_parse_error",
        details: { partial: true, eventsReceived: sequence },
        cause,
      });
    }
    for (const rawEvent of finishResult.events) {
      for (const envelope of buildEnvelopes(rawEvent)) {
        if (
          envelope.event.type === "done" ||
          envelope.event.type === "finish_reason" ||
          envelope.event.type === "error"
        ) {
          sawNativeTerminal = true;
        }
        yield envelope;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!sawNativeTerminal) {
    throw new AgenticError("protocol", `${OPERATION} stream ended without ever observing a terminal event`, {
      product: PRODUCT,
      operation: OPERATION,
      requestId,
      retryable: false,
      code: "stream_ended_without_terminal_event",
      details: { partial: true, eventsReceived: sequence },
    });
  }

  // ADR-0025a §D5 rule 7, applied to the streaming case exactly like
  // non-streaming `forwardChatCompletion` (`../forwarding.js`): a caller
  // `requiredPlane` that the final observed receipt contradicts (or that no
  // receipt ever arrived to verify) is a protocol violation even though the
  // stream otherwise completed normally.
  assertRoutingReceiptMatchesIntent(routingIntent, latestRoutingReceipt);
}

/**
 * `POST /v1/chat/completions` through the Proxy with `stream: true`
 * (ADR-0025a §D8). Returns an async generator of
 * `MetaProxyStreamEnvelope<OpenAiStreamEvent>` — iterate with `for await`.
 */
export async function* forwardChatCompletionStream(
  deps: ChatForwardDeps,
  request: ChatCompletionRequest,
  options?: MetaProxyChatStreamCallOptions,
): AsyncGenerator<MetaProxyStreamEnvelope<OpenAiStreamEvent>, void, void> {
  const { forwarded, idempotencyKey: callerKey } = filterForwardHeaders(options?.forwardHeaders);
  const idempotencyKey = callerKey ?? newIdempotencyKey();
  const requestId = (options?.requestContext?.requestId as string | undefined) ?? newRequestId();
  const budget = resolveProxyTimeBudget(options?.timeBudget);
  const overallStartedAt = Date.now();

  const { response, abortController } = await openStreamWithPreByteRetry(
    deps,
    request,
    requestId,
    idempotencyKey,
    forwarded,
    budget,
    overallStartedAt,
  );

  if (!response.body) {
    throw new AgenticError("protocol", `${OPERATION} response had no readable body`, {
      product: PRODUCT,
      operation: OPERATION,
      requestId,
      retryable: false,
      code: "no_response_body",
    });
  }

  yield* readProxySseBody(
    response.body,
    requestId,
    response.headers,
    budget,
    overallStartedAt,
    options?.cancellation,
    abortController,
    options?.routingIntent,
  );
}
