import { describe, expect, it, vi } from "vitest";

import { StaticApiKeyCredentialProvider } from "../src/agentic/static-api-key-provider.js";
import { MetaLlmClient } from "../src/meta-llm/client.js";
import { ChatCompletionsStreamAccumulator } from "../src/meta-llm/stream/envelope.js";

/**
 * `chat.completionsStream` tests (ADR-0024a §D5) — issue #58 streaming
 * pass. Scoped per the task: a full successful stream, an early
 * termination with a typed terminal error (partial state preserved), and
 * confirmation that no retry occurs after the first response byte.
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

function chatRequest() {
  return { model: "meta-llm-large", messages: [{ role: "user" as const, content: "hello" }] };
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
 * without ever closing the socket. Also records whether the request's
 * `AbortSignal` was ever aborted, so the timeout tests can confirm the
 * fix actually releases the hung connection rather than merely giving up
 * on reading it.
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

describe("MetaLlmClient.chat.completionsStream() — full successful stream", () => {
  it("yields role/content/finish_reason/usage/done and completes without throwing", async () => {
    const chunks = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m",' +
        '"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m",' +
        '"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m",' +
        '"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m",' +
        '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],' +
        '"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ];
    const fetchSpy = vi.fn().mockResolvedValue(streamingResponse(chunks));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const { values, error } = await collect(client.chat.completionsStream(chatRequest()));

    expect(error).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const accumulator = new ChatCompletionsStreamAccumulator();
    for (const envelope of values) accumulator.absorb(envelope);
    const snapshot = accumulator.snapshot();

    expect(snapshot.role).toBe("assistant");
    expect(snapshot.contentByChoice[0]).toBe("Hello world");
    expect(snapshot.finishReasonByChoice[0]).toBe("stop");
    expect(snapshot.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    expect(snapshot.completed).toBe(true);

    // Sequence numbers are strictly increasing.
    const sequences = values.map((v) => v.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });
});

describe("MetaLlmClient.chat.completionsStream() — tool_call_delta decodes correctly", () => {
  it("decodes delta.tool_calls[] into OpenAiToolCallDeltaEvent, not unknown", async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1",' +
        '"function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,' +
        '"function":{"arguments":"{\\"city\\":\\"NYC\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const fetchSpy = vi.fn().mockResolvedValue(streamingResponse(chunks));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const { values, error } = await collect(client.chat.completionsStream(chatRequest()));

    expect(error).toBeUndefined();
    expect(values.filter((v) => v.event.type === "unknown")).toHaveLength(0);

    const toolCallEvents = values.filter((v) => v.event.type === "tool_call_delta");
    expect(toolCallEvents).toHaveLength(2);
    const first = toolCallEvents[0].event;
    if (first.type === "tool_call_delta") {
      expect(first.toolCallIndex).toBe(0);
      expect(first.id).toBe("call_1");
      expect(first.functionName).toBe("get_weather");
    }
    const second = toolCallEvents[1].event;
    if (second.type === "tool_call_delta") {
      expect(second.argumentsDelta).toBe('{"city":"NYC"}');
    }
  });
});

describe("MetaLlmClient.chat.completionsStream() — wire-level error event decodes correctly", () => {
  it("decodes a data: {error:{...}} frame to OpenAiStreamErrorEvent, not unknown", async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"error":{"message":"The server is overloaded","type":"server_error","code":"overloaded"}}\n\n',
      "data: [DONE]\n\n",
    ];
    const fetchSpy = vi.fn().mockResolvedValue(streamingResponse(chunks));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const { values, error } = await collect(client.chat.completionsStream(chatRequest()));

    expect(error).toBeUndefined();
    const errorEvents = values.filter((v) => v.event.type === "error");
    expect(errorEvents).toHaveLength(1);
    const errEvent = errorEvents[0].event;
    if (errEvent.type === "error") {
      expect(errEvent.error).toEqual({
        message: "The server is overloaded",
        type: "server_error",
        code: "overloaded",
        param: undefined,
      });
    }
    expect(values.filter((v) => v.event.type === "unknown")).toHaveLength(0);
  });
});

describe("MetaLlmClient.chat.completionsStream() — early termination", () => {
  it("preserves partial state and throws a typed terminal error when the stream ends without [DONE]", async () => {
    // Connection closes cleanly (no read error) after two content chunks —
    // no [DONE] and no finish_reason ever arrives.
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    ];
    const fetchSpy = vi.fn().mockResolvedValue(streamingResponse(chunks));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const { values, error } = await collect(client.chat.completionsStream(chatRequest()));

    // Partial state was already delivered via normal iteration before the throw.
    const accumulator = new ChatCompletionsStreamAccumulator();
    for (const envelope of values) accumulator.absorb(envelope);
    const snapshot = accumulator.snapshot();
    expect(snapshot.contentByChoice[0]).toBe("partial");
    expect(snapshot.completed).toBe(false);

    expect(error).toBeDefined();
    expect(error).toMatchObject({
      kind: "protocol",
      code: "stream_ended_without_terminal_event",
      retryable: false,
    });
    expect((error as { details?: { partial?: boolean } }).details?.partial).toBe(true);
  });
});

describe("MetaLlmClient.chat.completionsStream() — no retry after first byte", () => {
  it("performs exactly one HTTP attempt even when the stream errors mid-read", async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"one event then drop"},"finish_reason":null}]}\n\n',
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

    const { error } = await collect(client.chat.completionsStream(chatRequest()));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      kind: "transport",
      code: "stream_disconnected",
      retryable: false,
    });
  });
});

describe("MetaLlmClient.chat.completionsStream() — idle timeout on a silently-hanging stream", () => {
  it("errors with a typed idle_timeout after the stream goes silent past idleTimeoutMs, preserving prior events", async () => {
    // Two valid events land immediately, then the server goes silent
    // forever without closing the socket — this is exactly the "silently
    // hanging server" bug: without racing the read against the idle
    // budget, `reader.read()` blocks forever regardless of idleTimeoutMs.
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"before the hang"},"finish_reason":null}]}\n\n',
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
      client.chat.completionsStream(chatRequest(), {
        requestContext: { timeBudget: { idleTimeoutMs: 30 } },
      }),
    );

    const accumulator = new ChatCompletionsStreamAccumulator();
    for (const envelope of values) accumulator.absorb(envelope);
    const snapshot = accumulator.snapshot();
    expect(snapshot.contentByChoice[0]).toBe("before the hang");
    expect(snapshot.completed).toBe(false);

    expect(error).toMatchObject({
      kind: "deadline_exceeded",
      code: "idle_timeout",
      retryable: false,
    });
    expect((error as { details?: { partial?: boolean } }).details?.partial).toBe(true);
    expect(abortState.aborted).toBe(true);
  }, 5000);
});

describe("MetaLlmClient.chat.completionsStream() — first-byte timeout on a silently-hanging stream", () => {
  it("errors with a typed first_byte_timeout when no byte ever arrives past firstByteTimeoutMs", async () => {
    // No chunks at all — the connection is accepted but the server never
    // sends a single byte.
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
      client.chat.completionsStream(chatRequest(), {
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
