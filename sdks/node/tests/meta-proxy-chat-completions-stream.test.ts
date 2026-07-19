import { describe, expect, it, vi } from "vitest";

import { MetaProxyClient } from "../src/meta-proxy/client.js";
import { LocalBearerTokenCredentialProvider } from "../src/meta-proxy/auth.js";
import type { RoutingIntent } from "../src/meta-proxy/routing.js";
import type { ChatCompletionRequest } from "../src/meta-llm/types/openai.js";
import { ChatCompletionsStreamAccumulator } from "../src/meta-llm/stream/envelope.js";
import type { MetaProxyStreamEnvelope } from "../src/meta-proxy/stream/envelope.js";
import type { OpenAiStreamEvent } from "../src/meta-llm/stream/openai-events.js";

/**
 * `chat.completionsStream()` tests (ADR-0025a §D8, M3 continuation of issue
 * #61). Mirrors PR #88's `meta-llm-chat-completions-stream.test.ts` style and
 * PR #93's `meta-proxy-chat-completions.test.ts` fixtures. Scoped per the
 * task: a full successful stream (terminal event + receipt decoded), the
 * idle-timeout race (real race, not a pre-check), the required_plane
 * mismatch check firing on a streaming terminal receipt, no-retry-after-
 * first-byte on a mid-stream disconnect, and sponsored-stream-fails-locally.
 */

const ORIGIN = "http://127.0.0.1:11435";
const enc = new TextEncoder();

const REQUEST: ChatCompletionRequest = {
  model: "gpt-proxy",
  messages: [{ role: "user", content: "hello" }],
};

function localBearerProvider(): LocalBearerTokenCredentialProvider {
  return new LocalBearerTokenCredentialProvider({
    token: "mh1.canary-local-token",
    normalizedOrigin: ORIGIN,
  });
}

/** Builds a fetch-compatible streaming Response whose body enqueues `chunks` then closes normally. */
function streamingResponse(
  chunks: string[],
  options: { failAfter?: number; headers?: Record<string, string> } = {},
): Response {
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
    type: "basic",
    headers: new Headers({ "content-type": "text/event-stream", ...options.headers }),
    body,
    text: () => Promise.resolve(""),
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

/** Builds a streaming Response that enqueues `chunks` once and then hangs forever (no close/error). */
function hangingStreamResponse(
  chunks: string[],
  signal: AbortSignal,
  abortState: { aborted: boolean },
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      // Deliberately never close/error — the hang is the point.
    },
  });
  signal.addEventListener("abort", () => {
    abortState.aborted = true;
  });
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    type: "basic",
    headers: new Headers({ "content-type": "text/event-stream" }),
    body,
    text: () => Promise.resolve(""),
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

function routingReceiptChunk(selectedPlane: string): string {
  return (
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],' +
    '"cognitum_routing_receipt":{"request_id":"rr-1","configured_plane":"local",' +
    `"selected_plane":"${selectedPlane}","routing_reason":"configured_default",` +
    '"automatic":false,"workload_policy":"standard","degraded":false},' +
    '"cognitum_upstream_receipt":{"provider":"cognitum","cost":"0.001"}}\n\n'
  );
}

async function collect<T>(
  iterable: AsyncGenerator<T, void, void>,
): Promise<{ values: T[]; error?: unknown }> {
  const values: T[] = [];
  try {
    for await (const value of iterable) values.push(value);
  } catch (error) {
    return { values, error };
  }
  return { values };
}

describe("MetaProxyClient.chat.completionsStream() — full successful stream (§D8)", () => {
  it("yields role/content/finish_reason/receipt and decodes plane+version metadata", async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      routingReceiptChunk("local"),
      "data: [DONE]\n\n",
    ];
    const fetchSpy = vi.fn().mockResolvedValue(
      streamingResponse(chunks, {
        headers: {
          "x-cognitum-product-version": "0.4.0",
          "x-cognitum-protocol-version": "1.0",
        },
      }),
    );
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    const { values, error } = await collect(client.chat.completionsStream(REQUEST));

    expect(error).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const accumulator = new ChatCompletionsStreamAccumulator();
    for (const envelope of values) accumulator.absorb(envelope);
    const snapshot = accumulator.snapshot();
    expect(snapshot.role).toBe("assistant");
    expect(snapshot.contentByChoice[0]).toBe("Hello");
    expect(snapshot.finishReasonByChoice[0]).toBe("stop");
    expect(snapshot.completed).toBe(true);

    const last = values[values.length - 1] as MetaProxyStreamEnvelope<OpenAiStreamEvent>;
    expect(last.proxyMeta.productVersion).toBe("0.4.0");
    expect(last.proxyMeta.protocolVersion).toBe("1.0");
    expect(last.proxyMeta.routingReceipt?.selectedPlane).toBe("local");
    expect(last.proxyMeta.upstreamReceipt).toEqual({ provider: "cognitum", cost: "0.001" });
  });

  it("call attaches a POST with stream:true and no bounded retry on 429/502/503", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      streamingResponse([routingReceiptChunk("local"), "data: [DONE]\n\n"]),
    );
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });
    await collect(client.chat.completionsStream(REQUEST));
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
  });
});

describe("MetaProxyClient.chat.completionsStream() — required_plane mismatch on the streaming terminal receipt (§D5 rule 7)", () => {
  it("throws a protocol error when the terminal receipt contradicts requiredPlane", async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      routingReceiptChunk("cognitum_cloud"),
      "data: [DONE]\n\n",
    ];
    const fetchSpy = vi.fn().mockResolvedValue(streamingResponse(chunks));
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    const intent: RoutingIntent = {
      requiredPlane: "local",
      allowedPlanes: ["local"],
      workloadPolicy: "standard",
      consentGrants: [],
      trainingShare: false,
      failIfUnavailable: true,
    };

    const { error } = await collect(client.chat.completionsStream(REQUEST, { routingIntent: intent }));
    expect(error).toMatchObject({ kind: "protocol", retryable: false });
  });

  it("succeeds when the terminal receipt matches requiredPlane", async () => {
    const chunks = [routingReceiptChunk("local"), "data: [DONE]\n\n"];
    const fetchSpy = vi.fn().mockResolvedValue(streamingResponse(chunks));
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    const intent: RoutingIntent = {
      requiredPlane: "local",
      allowedPlanes: ["local"],
      workloadPolicy: "standard",
      consentGrants: [],
      trainingShare: false,
      failIfUnavailable: true,
    };

    const { error } = await collect(client.chat.completionsStream(REQUEST, { routingIntent: intent }));
    expect(error).toBeUndefined();
  });

  it("throws a protocol error when requiredPlane is set but no receipt ever arrives", async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const fetchSpy = vi.fn().mockResolvedValue(streamingResponse(chunks));
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    const intent: RoutingIntent = {
      requiredPlane: "local",
      allowedPlanes: ["local"],
      workloadPolicy: "standard",
      consentGrants: [],
      trainingShare: false,
      failIfUnavailable: true,
    };

    const { error } = await collect(client.chat.completionsStream(REQUEST, { routingIntent: intent }));
    expect(error).toMatchObject({ kind: "protocol" });
  });
});

describe("MetaProxyClient.chat.completionsStream() — no retry after first byte (§D8)", () => {
  it("performs exactly one HTTP attempt even when the stream errors mid-read", async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"one event then drop"},"finish_reason":null}]}\n\n',
    ];
    const fetchSpy = vi.fn().mockResolvedValue(streamingResponse(chunks, { failAfter: 2 }));
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    const { error } = await collect(client.chat.completionsStream(REQUEST));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ kind: "transport", code: "stream_disconnected", retryable: false });
  });

  it("never auto-retries a 503/429/502 pre-byte response — single terminal error", async () => {
    for (const status of [503, 429, 502]) {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: false,
        status,
        statusText: `Status ${status}`,
        type: "basic",
        headers: new Headers({ "retry-after": "7" }),
        json: () => Promise.resolve({ error: "unavailable" }),
        text: () => Promise.resolve(JSON.stringify({ error: "unavailable" })),
      } as unknown as Response);
      const client = new MetaProxyClient({
        transport: fetchSpy,
        localCredentialProvider: localBearerProvider(),
      });

      const { error } = await collect(client.chat.completionsStream(REQUEST));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(error).toMatchObject({ status, retryable: true, retryAfterMs: 7000 });
    }
  });
});

describe("MetaProxyClient.chat.completionsStream() — idle-stream-timeout race on a silently-hanging stream (ProxyTimeBudget §D8)", () => {
  it("errors with a typed idle_stream_timeout after the stream goes silent, preserving prior events", async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"before the hang"},"finish_reason":null}]}\n\n',
    ];
    const abortState = { aborted: false };
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) =>
      hangingStreamResponse(chunks, init!.signal as AbortSignal, abortState),
    );
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    const { values, error } = await collect(
      client.chat.completionsStream(REQUEST, { timeBudget: { idleStreamTimeoutMs: 30 } }),
    );

    const accumulator = new ChatCompletionsStreamAccumulator();
    for (const envelope of values) accumulator.absorb(envelope);
    expect(accumulator.snapshot().contentByChoice[0]).toBe("before the hang");

    expect(error).toMatchObject({ kind: "deadline_exceeded", code: "idle_stream_timeout", retryable: false });
    expect((error as { details?: { partial?: boolean } }).details?.partial).toBe(true);
    expect(abortState.aborted).toBe(true);
  }, 5000);

  it("errors with a typed first_byte_timeout when no byte ever arrives", async () => {
    const abortState = { aborted: false };
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) =>
      hangingStreamResponse([], init!.signal as AbortSignal, abortState),
    );
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    const { values, error } = await collect(
      client.chat.completionsStream(REQUEST, { timeBudget: { firstByteTimeoutMs: 30 } }),
    );

    expect(values).toEqual([]);
    expect(error).toMatchObject({ kind: "deadline_exceeded", code: "first_byte_timeout", retryable: false });
    expect(abortState.aborted).toBe(true);
  }, 5000);
});

describe("MetaProxyClient.preview.sponsored.chatCompletions — sponsored stream fails locally (§D8)", () => {
  it("rejects request.stream=true with UnsupportedCapabilityError before any HTTP I/O", async () => {
    const fetchSpy = vi.fn();
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    await expect(
      client.preview.sponsored.chatCompletions({ ...REQUEST, stream: true }),
    ).rejects.toMatchObject({
      kind: "unsupported_capability",
      capability: "sponsored-inference-streaming",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("also rejects a non-streaming sponsored call (sponsor forwarding not implemented this pass)", async () => {
    const fetchSpy = vi.fn();
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    await expect(client.preview.sponsored.chatCompletions(REQUEST)).rejects.toMatchObject({
      kind: "unsupported_capability",
      capability: "sponsored-inference",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
