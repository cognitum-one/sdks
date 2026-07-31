import { describe, expect, it } from "vitest";

import { StaticApiKeyCredentialProvider } from "../src/agentic/static-api-key-provider.js";
import { MetaLlmClient } from "../src/meta-llm/client.js";

/**
 * Exercises the exact construction + streaming shape shown in this
 * package's README "Agentic layer (v0.3)" section end-to-end (mocked
 * transport), so a future API rename fails this test instead of only
 * being caught by manual inspection (see cognitum-one/sdks#122).
 */

const BASE_URL = "https://api.cognitum.one";
const enc = new TextEncoder();

function streamingResponse(chunks: string[]): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
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

describe("README meta-llm example (Node)", () => {
  it("constructs MetaLlmClient as shown in the README and streams a content_delta", async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const transport = () => Promise.resolve(streamingResponse(chunks));

    const llm = new MetaLlmClient({
      baseUrl: BASE_URL,
      credentialProvider: new StaticApiKeyCredentialProvider({
        product: "meta-llm",
        normalizedOrigin: BASE_URL,
        audience: BASE_URL,
        apiKey: "sk-test-canary",
      }),
      transport: transport as unknown as typeof fetch,
    });

    const deltas: string[] = [];
    for await (const envelope of llm.chat.completionsStream({
      model: "cognitum-meta-llm",
      messages: [{ role: "user", content: "hello" }],
    })) {
      if (envelope.event.type === "content_delta") deltas.push(envelope.event.delta);
    }

    expect(deltas.join("")).toBe("hello");
  });
});
