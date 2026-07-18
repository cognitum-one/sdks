import { describe, it, expect, vi } from "vitest";

import { MetaLlmClient } from "../src/meta-llm/client.js";
import { StaticApiKeyCredentialProvider } from "../src/agentic/static-api-key-provider.js";

/**
 * Real HTTP call logic for the remaining direct nonstream operations named
 * in ADR-0024a §D7 — `completions` (legacy OpenAI completions), `responses`,
 * `embeddings`, and `messages.countTokens` — issue #58 / M2 continuation.
 *
 * This is mechanical reuse of the exact `chat.completions`/`messages.create`
 * pattern already proven in `meta-llm-nonstream.test.ts` (PR #86): the same
 * `postJsonIdempotent` infrastructure, the same D6 error-mapping table, and
 * the same D7 idempotency/retry loop. Per the tracking issue, this file does
 * NOT re-prove every status code or the full retry/401-refresh matrix for
 * each of the four operations — that infrastructure is already covered.
 * Instead: one success test per operation (proving each operation wires
 * into the shared infrastructure correctly), one error-mapping smoke test,
 * and one idempotency-retry smoke test.
 */

const BASE_URL = "https://meta-llm.test.cognitum.one";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `Status ${status}`,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function makeCredentialProvider(): StaticApiKeyCredentialProvider {
  return new StaticApiKeyCredentialProvider({
    apiKey: "sk-test-canary-1234",
    product: "meta-llm",
    normalizedOrigin: BASE_URL,
    audience: BASE_URL,
  });
}

function legacyCompletionBody() {
  return {
    id: "cmpl-1",
    object: "text_completion",
    created: 1,
    model: "meta-llm-large",
    choices: [{ text: "hi there", index: 0, finishReason: "stop" }],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

function responsesBody() {
  return {
    id: "resp-1",
    object: "response",
    createdAt: 1,
    model: "meta-llm-large",
    status: "completed",
    output: [{ type: "message", id: "out-1", role: "assistant", content: [{ type: "text", text: "hi" }] }],
  };
}

function embeddingBody() {
  return {
    object: "list",
    data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
    model: "meta-llm-embed",
    usage: { promptTokens: 3, totalTokens: 3 },
  };
}

function countTokensBody() {
  return { inputTokens: 5 };
}

function legacyCompletionRequest() {
  return { model: "meta-llm-large", prompt: "hello" };
}

function responsesRequest() {
  return { model: "meta-llm-large", input: "hello" };
}

function embeddingRequest() {
  return { model: "meta-llm-embed", input: "hello" };
}

function countTokensRequest() {
  return { model: "meta-llm-large", messages: [{ role: "user" as const, content: "hello" }] };
}

function idempotencyKeyOf(fetchSpy: ReturnType<typeof vi.fn>, call: number): string {
  const [, init] = fetchSpy.mock.calls[call];
  return (init.headers as Record<string, string>)["Idempotency-Key"];
}

// ---------------------------------------------------------------------------
// Success paths — one per operation
// ---------------------------------------------------------------------------

describe("MetaLlmClient.completions()", () => {
  it("succeeds and sends an Idempotency-Key header", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, legacyCompletionBody()));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const result = await client.completions(legacyCompletionRequest());

    expect(result.data.id).toBe("cmpl-1");
    expect(result.meta.httpStatus).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/completions`);
    expect(idempotencyKeyOf(fetchSpy, 0)).toBeTruthy();
  });
});

describe("MetaLlmClient.responses()", () => {
  it("succeeds and sends an Idempotency-Key header", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, responsesBody()));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const result = await client.responses(responsesRequest());

    expect(result.data.id).toBe("resp-1");
    expect(result.meta.httpStatus).toBe(200);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/responses`);
    expect(idempotencyKeyOf(fetchSpy, 0)).toBeTruthy();
  });
});

describe("MetaLlmClient.embeddings()", () => {
  it("succeeds and sends an Idempotency-Key header", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, embeddingBody()));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const result = await client.embeddings(embeddingRequest());

    expect(result.data.model).toBe("meta-llm-embed");
    expect(result.data.data).toHaveLength(1);
    expect(result.meta.httpStatus).toBe(200);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/embeddings`);
    expect(idempotencyKeyOf(fetchSpy, 0)).toBeTruthy();
  });
});

describe("MetaLlmClient.messages.countTokens()", () => {
  it("succeeds and sends an Idempotency-Key header", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, countTokensBody()));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const result = await client.messages.countTokens(countTokensRequest());

    expect(result.data.inputTokens).toBe(5);
    expect(result.meta.httpStatus).toBe(200);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/messages/count_tokens`);
    expect(idempotencyKeyOf(fetchSpy, 0)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// D6 error mapping — smoke test only (full table already proven in
// meta-llm-nonstream.test.ts); one status on one operation proves this
// operation wires into the shared `mapMetaLlmHttpError` table correctly.
// ---------------------------------------------------------------------------

describe("D6 error mapping smoke test", () => {
  it("maps a 429 on embeddings to a retryable rate_limited error", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse(429, { error: "slow down" }, { "retry-after": "1" }));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    await expect(client.embeddings(embeddingRequest())).rejects.toMatchObject({
      kind: "rate_limited",
      retryable: true,
      status: 429,
    });
  });
});

// ---------------------------------------------------------------------------
// D7 idempotency + bounded retry — smoke test only (the full retry/401
// matrix is already proven in meta-llm-nonstream.test.ts); one retry on one
// operation proves this operation wires into the shared retry loop
// correctly, reusing the same Idempotency-Key across the retry.
// ---------------------------------------------------------------------------

describe("D7 idempotency and bounded retry smoke test", () => {
  it("retries a 502 on responses once and reuses the same Idempotency-Key", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(502, { error: "bad gateway" }))
      .mockResolvedValueOnce(jsonResponse(200, responsesBody()));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const result = await client.responses(responsesRequest());

    expect(result.data.id).toBe("resp-1");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(idempotencyKeyOf(fetchSpy, 0)).toBe(idempotencyKeyOf(fetchSpy, 1));
  });
});
