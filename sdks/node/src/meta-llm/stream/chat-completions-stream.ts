/**
 * `chatCompletionsStream` HTTP + SSE orchestration (ADR-0024a §D5). Issue
 * #58 / M2 continuation — the first (and, this pass, only) protocol wired
 * onto the generic `../../sse/parser.js`. Anthropic Messages streaming and
 * Responses streaming are explicitly DEFERRED to follow-up work; they
 * reuse the same generic parser.
 *
 * Pre-byte behavior mirrors `../nonstream.js`'s `postJsonIdempotent`
 * (credential acquisition, 401-refresh-once, bounded 429/502/503 retry)
 * with one deliberate difference: ADR-0024a §D7 generates an SDK
 * idempotency key only for "a direct nonstream call" — streams are
 * excluded — so no `Idempotency-Key` header is sent here.
 *
 * Post-byte behavior is the ADR-0023 §D6/ADR-0024a §D5 contract: once any
 * response byte has been read, there is NO retry, period — a mid-stream
 * disconnect, parse failure, cancellation, or timeout all surface as a
 * typed terminal error thrown out of the async generator, with whatever
 * events were already `yield`ed standing as the partial result (the SDK
 * never synthesizes a fake terminal event or claims rollback happened).
 *
 * Idle/first-byte/total-time budgets come from the frozen ADR-0023
 * `TimeBudget` type (`../../agentic/index.js`), read from
 * `requestContext.timeBudget`; cancellation from `requestContext.cancellation`
 * (`CancellationToken`) — both already-existing `RequestContext` fields,
 * no new plumbing needed.
 */

import {
  AgenticError,
  DEFAULT_RETRY_POLICY,
  equalJitterDelayMs,
  type CancellationToken,
  type RequestContext,
  type TimeBudget,
} from "../../agentic/index.js";
import { SseParser, type SseEvent } from "../../sse/parser.js";
import { mapMetaLlmHttpError } from "../http-errors.js";
import { applyAuth, newRequestId, requireCredential, type NonstreamDeps } from "../nonstream.js";
import type { ChatCompletionRequest } from "../types/openai.js";
import type { MetaLlmStreamEnvelope } from "./envelope.js";
import { decodeOpenAiSseEvent, type OpenAiStreamEvent } from "./openai-events.js";

const PRODUCT = "meta-llm";
const OPERATION = "chat.completionsStream";

/**
 * `POST /v1/chat/completions` with `stream: true`. Returns an async
 * generator of `MetaLlmStreamEnvelope<OpenAiStreamEvent>` — iterate with
 * `for await`. The generator completes normally only after observing the
 * OpenAI wire terminal condition (`[DONE]` or a `finish_reason`); any
 * other end-of-iteration throws an `AgenticError` describing exactly why,
 * per ADR-0024a §D5.
 */
export async function* chatCompletionsStreamImpl(
  deps: NonstreamDeps,
  request: ChatCompletionRequest,
  requestContext?: Partial<RequestContext>,
): AsyncGenerator<MetaLlmStreamEnvelope<OpenAiStreamEvent>, void, void> {
  const timeBudget: TimeBudget | undefined = requestContext?.timeBudget;
  const cancellation: CancellationToken | undefined = requestContext?.cancellation;
  const requestId = requestContext?.requestId ?? newRequestId();

  // Owns the underlying HTTP request so a budget timeout (see `readSseBody`)
  // can actually abort the hung connection rather than merely giving up on
  // reading it (the socket/response body would otherwise sit open forever).
  const abortController = new AbortController();
  const response = await openStreamWithPreByteRetry(deps, request, requestId, abortController.signal);

  if (!response.body) {
    throw new AgenticError("protocol", `${OPERATION} response had no readable body`, {
      product: PRODUCT,
      operation: OPERATION,
      requestId,
      retryable: false,
      code: "no_response_body",
    });
  }

  yield* readSseBody(response.body, requestId, timeBudget, cancellation, abortController);
}

/**
 * The pre-byte phase: acquire a credential, send the request, and retry
 * per the same bounded policy as `postJsonIdempotent` for 401 (once) and
 * 429/502/503 (bounded) — all BEFORE any response bytes are read. No
 * `Idempotency-Key` header (ADR-0024a §D7 excludes streams).
 */
async function openStreamWithPreByteRetry(
  deps: NonstreamDeps,
  request: ChatCompletionRequest,
  requestId: string,
  signal: AbortSignal,
): Promise<Response> {
  let credential = await requireCredential(deps, OPERATION);
  const body = JSON.stringify({ ...request, stream: true });

  const retryPolicy = DEFAULT_RETRY_POLICY;
  let attempt = 0;
  let sleepBudgetUsedMs = 0;
  let refreshedOnce = false;

  for (;;) {
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "X-Cognitum-Request-Id": requestId,
    };
    applyAuth(headers, credential);

    const url = `${deps.baseUrl}/v1/chat/completions`;
    let response: Response;
    try {
      response = await deps.transport(url, { method: "POST", headers, body, signal });
    } catch (cause) {
      throw new AgenticError("transport", `${OPERATION} request failed: ${cause}`, {
        product: PRODUCT,
        operation: OPERATION,
        requestId,
        retryable: true,
        cause,
      });
    }

    if (response.ok) return response;

    const err = await mapMetaLlmHttpError(response, OPERATION, requestId);
    if (err.status === 401 && !refreshedOnce) {
      refreshedOnce = true;
      await deps.credentialProvider?.invalidate("401 challenge from meta-llm");
      credential = await requireCredential(deps, OPERATION);
      continue;
    }

    const isBoundedRetryable = err.status === 429 || err.status === 502 || err.status === 503;
    if (isBoundedRetryable && attempt + 1 < retryPolicy.maxAttempts) {
      const serverHintMs = err.retryAfterMs ?? 0;
      const jitterMs = Math.random() * retryPolicy.baseMs;
      const delayMs = equalJitterDelayMs(attempt, retryPolicy, serverHintMs, jitterMs);
      if (sleepBudgetUsedMs + delayMs > retryPolicy.retrySleepBudgetMs) throw err;
      sleepBudgetUsedMs += delayMs;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
      continue;
    }

    throw err;
  }
}

function deadlineError(operation: string, requestId: string, code: string, message: string, sequence: number): AgenticError {
  return new AgenticError("deadline_exceeded", message, {
    product: PRODUCT,
    operation,
    requestId,
    retryable: false,
    code,
    details: { partial: true, eventsReceived: sequence },
  });
}

/** Decodes one raw SSE event into its typed envelopes, assigning each a fresh sequence number via `nextSequence`. */
function buildEnvelopes(
  rawEvent: SseEvent,
  requestId: string,
  nextSequence: () => number,
): MetaLlmStreamEnvelope<OpenAiStreamEvent>[] {
  const { events, unknownFields } = decodeOpenAiSseEvent(rawEvent);
  return events.map((event) => ({
    event,
    sequence: nextSequence(),
    receivedAt: new Date().toISOString(),
    requestId,
    rawEventName: rawEvent.event,
    unknownFields,
  }));
}

/**
 * The smallest remaining budget (in ms) that must elapse before the NEXT
 * chunk read is timed out, or `undefined` if no relevant budget is
 * configured at all. Mirrors whichever of the top-of-loop precise checks
 * below would fire first — used only to bound the otherwise-unbounded
 * `reader.read()` call; the precise check re-run after a race timeout is
 * what actually decides (and codes) the error.
 */
function remainingBudgetMs(
  now: number,
  streamStartedAt: number,
  lastByteAt: number,
  receivedFirstByte: boolean,
  timeBudget: TimeBudget | undefined,
): number | undefined {
  if (!timeBudget) return undefined;
  const candidates: number[] = [];
  if (timeBudget.requestDeadlineMs !== undefined) {
    candidates.push(Math.max(0, timeBudget.requestDeadlineMs - (now - streamStartedAt)));
  }
  const idleLimit = receivedFirstByte ? timeBudget.idleTimeoutMs : timeBudget.firstByteTimeoutMs;
  if (idleLimit !== undefined) {
    candidates.push(Math.max(0, idleLimit - (now - lastByteAt)));
  }
  return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

/**
 * Races `reader.read()` against a timer for `remainingMs` (or reads
 * unbounded if `remainingMs` is `undefined`, i.e. no budget configured).
 * Returns `"timeout"` if the timer wins — the caller re-checks the precise
 * budgets at the top of the loop (with a fresh `Date.now()`) to throw the
 * correctly-coded error, exactly the pattern already used by the Python
 * implementation of this same function ("the top-of-loop deadline check
 * will raise precisely").
 */
function raceReadAgainstBudget(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  remainingMs: number | undefined,
): Promise<ReadableStreamReadResult<Uint8Array> | "timeout"> {
  const readPromise = reader.read();
  if (remainingMs === undefined) return readPromise;
  // A rejection here is otherwise unhandled if the timer wins the race
  // below — attach a no-op handler so Node doesn't report it, while still
  // letting `Promise.race` observe (and propagate) the same rejection if
  // the read settles first.
  readPromise.catch(() => {});

  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), remainingMs);
  });

  return Promise.race([readPromise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/** Post-byte phase: read the SSE body, applying idle/first-byte/total budgets and cooperative cancellation. */
async function* readSseBody(
  body: ReadableStream<Uint8Array>,
  requestId: string,
  timeBudget: TimeBudget | undefined,
  cancellation: CancellationToken | undefined,
  abortController: AbortController,
): AsyncGenerator<MetaLlmStreamEnvelope<OpenAiStreamEvent>, void, void> {
  const reader = body.getReader();
  const parser = new SseParser();
  let sequence = 0;
  let sawTerminal = false;
  const streamStartedAt = Date.now();
  let lastByteAt = streamStartedAt;
  let receivedFirstByte = false;

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
      if (timeBudget?.requestDeadlineMs !== undefined && now - streamStartedAt > timeBudget.requestDeadlineMs) {
        throw deadlineError(
          OPERATION,
          requestId,
          "request_deadline_exceeded",
          `${OPERATION} exceeded requestDeadlineMs (${timeBudget.requestDeadlineMs}ms)`,
          sequence,
        );
      }
      const idleLimit = receivedFirstByte ? timeBudget?.idleTimeoutMs : timeBudget?.firstByteTimeoutMs;
      if (idleLimit !== undefined && now - lastByteAt > idleLimit) {
        throw deadlineError(
          OPERATION,
          requestId,
          receivedFirstByte ? "idle_timeout" : "first_byte_timeout",
          `${OPERATION} exceeded ${receivedFirstByte ? "idleTimeoutMs" : "firstByteTimeoutMs"} (${idleLimit}ms)`,
          sequence,
        );
      }

      // Bound the otherwise-unbounded blocking read against whichever
      // budget is smallest, so a server that accepts the connection and
      // then goes silent without closing the socket cannot hang this
      // generator forever (issue: idle/first-byte/deadline timeouts were
      // previously only checked *before* this read, never enforced against
      // it).
      const remainingMs = remainingBudgetMs(now, streamStartedAt, lastByteAt, receivedFirstByte, timeBudget);

      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        const raced = await raceReadAgainstBudget(reader, remainingMs);
        if (raced === "timeout") {
          // Abort the underlying fetch so the hung connection is actually
          // released, then loop back to the top: the precise checks above
          // (now using a fresh `Date.now()`) determine and throw the
          // correctly-coded error (request_deadline_exceeded / idle_timeout
          // / first_byte_timeout).
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
      lastByteAt = Date.now();

      let rawEvents;
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
        for (const envelope of buildEnvelopes(rawEvent, requestId, () => (sequence += 1))) {
          if (envelope.event.type === "done" || envelope.event.type === "finish_reason") sawTerminal = true;
          yield envelope;
        }
      }
    }

    // The underlying source ended (`readResult.done`). One final ambiguity
    // can only resolve at true EOF: a trailing lone CR that `feed()`
    // withheld judgement on (it could still have turned out to be half of
    // a CRLF pair) — see `SseParser.finish()`.
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
      for (const envelope of buildEnvelopes(rawEvent, requestId, () => (sequence += 1))) {
        if (envelope.event.type === "done" || envelope.event.type === "finish_reason") sawTerminal = true;
        yield envelope;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!sawTerminal) {
    throw new AgenticError("protocol", `${OPERATION} stream ended without ever observing a terminal event`, {
      product: PRODUCT,
      operation: OPERATION,
      requestId,
      retryable: false,
      code: "stream_ended_without_terminal_event",
      details: { partial: true, eventsReceived: sequence },
    });
  }
}
