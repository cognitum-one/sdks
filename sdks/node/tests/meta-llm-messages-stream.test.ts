import { describe, expect, it, vi } from "vitest";

import { StaticApiKeyCredentialProvider } from "../src/agentic/static-api-key-provider.js";
import { MetaLlmClient } from "../src/meta-llm/client.js";

/**
 * `messages.createStream` tests (ADR-0024a §D5) — issue #58 M2
 * continuation, item 2 of the tracked "what's left" list. Mirrors
 * `meta-llm-chat-completions-stream.test.ts`'s scope and helpers exactly,
 * substituting the Anthropic Messages wire protocol: `message_start`
 * through `message_stop` (the wire terminal condition — there is no
 * `[DONE]` sentinel), `ping` decoding to a real event (not `unknown`),
 * malformed-JSON tolerance, early-termination without `message_stop`, an
 * idle-timeout budget case, and confirmation that no `Idempotency-Key`
 * header is ever sent.
 */

const BASE_URL = "https://meta-llm.test.cognitum.one";
const enc = new TextEncoder();

function makeCredentialProvider(): StaticApiKeyCredentialProvider {
  return new StaticApiKeyCredentialProvider({
    apiKey: "sk-test-canary-1234",
    product: "meta-llm",
    normalizedOrigin: BASE_URL,
    audience: BASE_URL,
  });
}

function messageRequest() {
  return {
    model: "meta-llm-large",
    messages: [{ role: "user" as const, content: "hello" }],
    maxTokens: 256,
  };
}

/** Builds a fetch-compatible streaming Response whose body enqueues `chunks` then closes normally. */
function streamingResponse(chunks: string[], options: { failAfter?: number } = {}): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (options.failAfter !== undefined && i === options.failAfter) {
        controller.error(new Error("simulated socket reset"));
        return;
      }
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i]));
      i += 1;
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "text/event-stream" }),
    body,
    text: () => Promise.resolve(""),
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

/**
 * Builds a fetch-compatible streaming Response whose body enqueues `chunks`
 * once (via `start`, not `pull`) and then deliberately NEVER closes or
 * errors — simulating a server that accepted the connection, sent some
 * bytes (or none at all, if `chunks` is empty), and then went silent
 * without ever closing the socket.
 */
function hangingStreamResponse(
  chunks: string[],
  signal: AbortSignal,
  abortState: { aborted: boolean },
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      // No controller.close() / controller.error() call, ever — the
      // "hang" is the whole point of this helper.
    },
  });
  signal.addEventListener("abort", () => {
    abortState.aborted = true;
  });
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "text/event-stream" }),
    body,
    text: () => Promise.resolve(""),
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

async function collect<T>(iterable: AsyncGenerator<T, void, void>): Promise<{ values: T[]; error?: unknown }> {
  const values: T[] = [];
  try {
    for await (const value of iterable) values.push(value);
  } catch (error) {
    return { values, error };
  }
  return { values };
}

/** `event: X\ndata: {...}\n\n` — the real Anthropic wire shape (an explicit `event:` field, unlike OpenAI). */
function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("MetaLlmClient.messages.createStream() — full successful stream", () => {
  it("yields message_start/content_block_*/message_delta/message_stop and completes without throwing", async () => {
    const chunks = [
      sseFrame("message_start", {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [],
          model: "meta-llm-large",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      }),
      sseFrame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      }),
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " world" },
      }),
      sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
      sseFrame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      }),
      sseFrame("message_stop", { type: "message_stop" }),
    ];
    const fetchSpy = vi.fn().mockResolvedValue(streamingResponse(chunks));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const { values, error } = await collect(client.messages.createStream(messageRequest()));

    expect(error).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    expect(values.map((v) => v.event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const messageStart = values[0].event;
    if (messageStart.type === "message_start") {
      expect(messageStart.message.usage).toEqual({ inputTokens: 10, outputTokens: 0 });
    }

    const messageDelta = values[5].event;
    if (messageDelta.type === "message_delta") {
      expect(messageDelta.delta.stopReason).toBe("end_turn");
      expect(messageDelta.usage).toEqual({ outputTokens: 5 });
    }

    // Sequence numbers are strictly increasing.
    const sequences = values.map((v) => v.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });
});

describe("MetaLlmClient.messages.createStream() — ping decodes to a real event", () => {
  it("decodes a ping frame to AnthropicPingEvent, not unknown", async () => {
    const chunks = [
      sseFrame("message_start", {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [],
          model: "m",
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      sseFrame("ping", { type: "ping" }),
      sseFrame("message_stop", { type: "message_stop" }),
    ];
    const fetchSpy = vi.fn().mockResolvedValue(streamingResponse(chunks));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const { values, error } = await collect(client.messages.createStream(messageRequest()));

    expect(error).toBeUndefined();
    const pingEvents = values.filter((v) => v.event.type === "ping");
    expect(pingEvents).toHaveLength(1);
    const unknownEvents = values.filter((v) => v.event.type === "unknown");
    expect(unknownEvents).toHaveLength(0);
  });
});

describe("MetaLlmClient.messages.createStream() — malformed payload never throws", () => {
  it("decodes an unrecognized/malformed JSON payload to unknown without throwing", async () => {
    const chunks = [
      sseFrame("message_start", {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [],
          model: "m",
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      "event: weird\ndata: not-json-at-all{{{\n\n",
      sseFrame("message_stop", { type: "message_stop" }),
    ];
    const fetchSpy = vi.fn().mockResolvedValue(streamingResponse(chunks));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const { values, error } = await collect(client.messages.createStream(messageRequest()));

    expect(error).toBeUndefined();
    const unknownEvents = values.filter((v) => v.event.type === "unknown");
    expect(unknownEvents).toHaveLength(1);
  });
});

describe("MetaLlmClient.messages.createStream() — early termination", () => {
  it("preserves partial state and throws a typed terminal error when the stream ends without message_stop", async () => {
    // Connection closes cleanly (no read error) after a content delta —
    // no message_stop ever arrives.
    const chunks = [
      sseFrame("message_start", {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [],
          model: "m",
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "partial" },
      }),
    ];
    const fetchSpy = vi.fn().mockResolvedValue(streamingResponse(chunks));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const { values, error } = await collect(client.messages.createStream(messageRequest()));

    expect(values.some((v) => v.event.type === "content_block_delta")).toBe(true);
    expect(error).toBeDefined();
    expect(error).toMatchObject({
      kind: "protocol",
      code: "stream_ended_without_terminal_event",
      retryable: false,
    });
    expect((error as { details?: { partial?: boolean } }).details?.partial).toBe(true);
  });
});

describe("MetaLlmClient.messages.createStream() — no retry after first byte", () => {
  it("performs exactly one HTTP attempt even when the stream errors mid-read", async () => {
    const chunks = [
      sseFrame("message_start", {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [],
          model: "m",
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "one event then drop" },
      }),
    ];
    // failAfter: 2 means the underlying source errors on the pull *after*
    // both chunks above have already been enqueued — simulating a socket
    // reset partway through an otherwise-healthy stream.
    const fetchSpy = vi.fn().mockResolvedValue(streamingResponse(chunks, { failAfter: 2 }));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const { error } = await collect(client.messages.createStream(messageRequest()));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      kind: "transport",
      code: "stream_disconnected",
      retryable: false,
    });
  });
});

describe("MetaLlmClient.messages.createStream() — idle timeout on a silently-hanging stream", () => {
  it("errors with a typed idle_timeout after the stream goes silent past idleTimeoutMs, preserving prior events", async () => {
    const chunks = [
      sseFrame("message_start", {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [],
          model: "m",
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "before the hang" },
      }),
    ];
    const abortState = { aborted: false };
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) =>
      hangingStreamResponse(chunks, init!.signal as AbortSignal, abortState),
    );
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const { values, error } = await collect(
      client.messages.createStream(messageRequest(), {
        requestContext: { timeBudget: { idleTimeoutMs: 30 } },
      }),
    );

    expect(values.some((v) => v.event.type === "content_block_delta")).toBe(true);
    expect(error).toMatchObject({
      kind: "deadline_exceeded",
      code: "idle_timeout",
      retryable: false,
    });
    expect((error as { details?: { partial?: boolean } }).details?.partial).toBe(true);
    expect(abortState.aborted).toBe(true);
  }, 5000);
});

describe("MetaLlmClient.messages.createStream() — first-byte timeout on a silently-hanging stream", () => {
  it("errors with a typed first_byte_timeout when no byte ever arrives past firstByteTimeoutMs", async () => {
    const abortState = { aborted: false };
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) =>
      hangingStreamResponse([], init!.signal as AbortSignal, abortState),
    );
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const { values, error } = await collect(
      client.messages.createStream(messageRequest(), {
        requestContext: { timeBudget: { firstByteTimeoutMs: 30 } },
      }),
    );

    expect(values).toEqual([]);
    expect(error).toMatchObject({
      kind: "deadline_exceeded",
      code: "first_byte_timeout",
      retryable: false,
    });
    expect((error as { details?: { partial?: boolean } }).details?.partial).toBe(true);
    expect(abortState.aborted).toBe(true);
  }, 5000);
});

describe("MetaLlmClient.messages.createStream() — no Idempotency-Key header", () => {
  it("never sends an Idempotency-Key header for a stream call (ADR-0024a §D7 stream exclusion)", async () => {
    const chunks = [sseFrame("message_stop", { type: "message_stop" })];
    const fetchSpy = vi.fn().mockResolvedValue(streamingResponse(chunks));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    await collect(client.messages.createStream(messageRequest()));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });
});
