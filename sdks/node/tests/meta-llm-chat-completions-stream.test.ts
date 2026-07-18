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
