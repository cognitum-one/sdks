import { describe, it, expect, vi } from "vitest";

import { MetaLlmClient } from "../src/meta-llm/client.js";
import { StaticApiKeyCredentialProvider } from "../src/agentic/static-api-key-provider.js";
import type { Credential, CredentialProvider, CredentialRequest } from "../src/agentic/credentials.js";

/**
 * Real HTTP call logic for `chat.completions` (OpenAI-style) and
 * `messages.create` (Anthropic-style) — issue #58 / M2 continuation.
 * Split from `meta-llm-client.test.ts` (already near the file-size
 * convention used elsewhere in this pass) per ADR-0024a §D6 (error
 * mapping) and §D7 (idempotency and retry).
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

/**
 * Credential provider that returns a fresh secret each `acquire()` call,
 * so the 401-refresh-once tests can distinguish "first credential" from
 * "refreshed credential" — unlike `StaticApiKeyCredentialProvider`, whose
 * `invalidate()` makes every subsequent `acquire()` fail permanently.
 */
function makeRefreshingCredentialProvider(): {
  provider: CredentialProvider;
  acquireCalls: () => number;
  invalidateCalls: () => number;
} {
  let acquireCount = 0;
  let invalidateCount = 0;
  const provider: CredentialProvider = {
    describeAuthority: vi.fn(),
    identity: () => "refreshing-credential-provider",
    invalidate: vi.fn(async () => {
      invalidateCount += 1;
    }),
    acquire: vi.fn(async (_request: CredentialRequest): Promise<Credential> => {
      const secret = acquireCount === 0 ? "sk-v1" : "sk-v2";
      acquireCount += 1;
      return {
        scheme: "X-API-Key",
        secret: { reveal: () => secret } as Credential["secret"],
        audience: BASE_URL,
        source: "refreshing",
        authority: {
          providerFingerprint: "refreshing",
          product: "meta-llm",
          normalizedOrigin: BASE_URL,
          audience: BASE_URL,
          principal: "acct_refresh",
        },
      };
    }),
  };
  return { provider, acquireCalls: () => acquireCount, invalidateCalls: () => invalidateCount };
}

function chatCompletionBody() {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "meta-llm-large",
    choices: [
      { index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function anthropicMessageBody() {
  return {
    id: "msg-1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "hi there" }],
    model: "meta-llm-large",
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function chatRequest() {
  return { model: "meta-llm-large", messages: [{ role: "user" as const, content: "hello" }] };
}

function messagesRequest() {
  return {
    model: "meta-llm-large",
    messages: [{ role: "user" as const, content: "hello" }],
    maxTokens: 16,
  };
}

// ---------------------------------------------------------------------------
// Success paths
// ---------------------------------------------------------------------------

describe("MetaLlmClient.chat.completions()", () => {
  it("succeeds and sends an Idempotency-Key header", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, chatCompletionBody()));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const result = await client.chat.completions(chatRequest());

    expect(result.data.id).toBe("chatcmpl-1");
    expect(result.meta.httpStatus).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
  });
});

describe("MetaLlmClient.messages.create()", () => {
  it("succeeds and sends an Idempotency-Key header", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, anthropicMessageBody()));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const result = await client.messages.create(messagesRequest());

    expect(result.data.id).toBe("msg-1");
    expect(result.meta.httpStatus).toBe(200);
    const [, init] = fetchSpy.mock.calls[0];
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// D6 error mapping — newly added statuses (400/409/402/422)
// ---------------------------------------------------------------------------

describe("D6 error mapping additions", () => {
  it("maps 400 to a non-retryable validation error", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad request" }));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    await expect(client.chat.completions(chatRequest())).rejects.toMatchObject({
      kind: "validation",
      retryable: false,
      status: 400,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("maps 409 to a non-retryable conflict error", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, { error: "idempotency_mismatch" }));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    await expect(client.chat.completions(chatRequest())).rejects.toMatchObject({
      kind: "conflict",
      retryable: false,
      status: 409,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("maps 402 to a non-retryable budget_exceeded error", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(402, { error: "budget exceeded" }));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    await expect(client.messages.create(messagesRequest())).rejects.toMatchObject({
      kind: "budget_exceeded",
      retryable: false,
      status: 402,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("maps 422 to a non-retryable safety_blocked error", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(422, { error: "safety_blocked" }));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    await expect(client.messages.create(messagesRequest())).rejects.toMatchObject({
      kind: "safety_blocked",
      retryable: false,
      status: 422,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// D7 idempotency + bounded 502/503/429 retry
// ---------------------------------------------------------------------------

describe("D7 idempotency and bounded retry", () => {
  it("retries a 502 once and reuses the same Idempotency-Key", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(502, { error: "bad gateway" }))
      .mockResolvedValueOnce(jsonResponse(200, chatCompletionBody()));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const result = await client.chat.completions(chatRequest());

    expect(result.data.id).toBe("chatcmpl-1");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const key1 = (fetchSpy.mock.calls[0][1].headers as Record<string, string>)["Idempotency-Key"];
    const key2 = (fetchSpy.mock.calls[1][1].headers as Record<string, string>)["Idempotency-Key"];
    expect(key1).toBe(key2);
  });

  it("retries a 503 once and reuses the same Idempotency-Key for messages.create", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: "unavailable" }))
      .mockResolvedValueOnce(jsonResponse(200, anthropicMessageBody()));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const result = await client.messages.create(messagesRequest());

    expect(result.data.id).toBe("msg-1");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const key1 = (fetchSpy.mock.calls[0][1].headers as Record<string, string>)["Idempotency-Key"];
    const key2 = (fetchSpy.mock.calls[1][1].headers as Record<string, string>)["Idempotency-Key"];
    expect(key1).toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// D6 401: at most one refresh after a verified challenge
// ---------------------------------------------------------------------------

describe("D6 401 refresh-once behavior", () => {
  it("refreshes the credential once after a 401 then succeeds", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: "expired" }))
      .mockResolvedValueOnce(jsonResponse(200, chatCompletionBody()));
    const { provider, acquireCalls, invalidateCalls } = makeRefreshingCredentialProvider();
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: provider,
    });

    const result = await client.chat.completions(chatRequest());

    expect(result.data.id).toBe("chatcmpl-1");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(acquireCalls()).toBe(2);
    expect(invalidateCalls()).toBe(1);

    const [, firstInit] = fetchSpy.mock.calls[0];
    const [, secondInit] = fetchSpy.mock.calls[1];
    expect((firstInit.headers as Record<string, string>)["X-API-Key"]).toBe("sk-v1");
    expect((secondInit.headers as Record<string, string>)["X-API-Key"]).toBe("sk-v2");
  });

  it("does not retry a second 401 (exactly one refresh, no more)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(401, { error: "expired" }));
    const { provider, acquireCalls, invalidateCalls } = makeRefreshingCredentialProvider();
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: provider,
    });

    await expect(client.chat.completions(chatRequest())).rejects.toMatchObject({
      kind: "authentication",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(acquireCalls()).toBe(2);
    expect(invalidateCalls()).toBe(1);
  });
});
