import { describe, it, expect, vi, afterEach } from "vitest";

import { MetaLlmClient } from "../src/meta-llm/client.js";
import { __resetMetaLlmInsecureHttpWarnLatch } from "../src/meta-llm/config.js";
import { StaticApiKeyCredentialProvider } from "../src/agentic/static-api-key-provider.js";
import { AgenticError } from "../src/agentic/errors.js";
import type { CredentialProvider } from "../src/agentic/credentials.js";

const BASE_URL = "https://meta-llm.test.cognitum.one";

function mockFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: `Status ${status}`,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response);
}

function makeCredentialProvider(): StaticApiKeyCredentialProvider {
  return new StaticApiKeyCredentialProvider({
    apiKey: "sk-test-canary-1234",
    product: "meta-llm",
    normalizedOrigin: BASE_URL,
    audience: BASE_URL,
  });
}

/** Spy `CredentialProvider` so tests can assert `acquire()` call counts. */
function makeSpyCredentialProvider(): { provider: CredentialProvider; acquire: ReturnType<typeof vi.fn> } {
  const acquire = vi.fn().mockResolvedValue({
    scheme: "X-API-Key",
    secret: { reveal: () => "sk-spy-canary" },
    audience: BASE_URL,
    source: "spy",
    authority: {
      providerFingerprint: "spy",
      product: "meta-llm",
      normalizedOrigin: BASE_URL,
      audience: BASE_URL,
    },
  });
  const provider: CredentialProvider = {
    acquire,
    describeAuthority: vi.fn(),
    identity: () => "spy-credential-provider",
    invalidate: vi.fn(),
  };
  return { provider, acquire };
}

describe("MetaLlmClient construction", () => {
  afterEach(() => {
    __resetMetaLlmInsecureHttpWarnLatch();
  });

  it("performs no I/O and requires an explicit HTTPS base URL", () => {
    const fetchSpy = vi.fn();
    const client = new MetaLlmClient({ baseUrl: BASE_URL, transport: fetchSpy });
    expect(client).toBeInstanceOf(MetaLlmClient);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-HTTPS base URL by default", () => {
    expect(() => new MetaLlmClient({ baseUrl: "http://127.0.0.1:9999" })).toThrow(TypeError);
  });

  it("allows a non-HTTPS base URL when allowInsecureHttp is set", () => {
    const client = new MetaLlmClient({
      baseUrl: "http://127.0.0.1:9999",
      allowInsecureHttp: true,
    });
    expect(client).toBeInstanceOf(MetaLlmClient);
  });

  it("throws for a missing base URL", () => {
    expect(() => new MetaLlmClient({ baseUrl: "" })).toThrow(TypeError);
  });

  it("rejects allowInsecureHttp against a non-loopback host (ADR-0022 §D3)", () => {
    expect(
      () => new MetaLlmClient({ baseUrl: "http://example.com:9999", allowInsecureHttp: true }),
    ).toThrow(TypeError);
  });

  it("rejects allowInsecureHttp against a hostname that merely resolves to loopback", () => {
    // ADR-0022 §D3: hostname resolution to loopback is insufficient — only
    // a literal IPv4/IPv6 loopback address qualifies.
    expect(
      () => new MetaLlmClient({ baseUrl: "http://localhost:9999", allowInsecureHttp: true }),
    ).toThrow(TypeError);
  });

  it("allows allowInsecureHttp against a literal IPv6 loopback address", () => {
    const client = new MetaLlmClient({ baseUrl: "http://[::1]:9999", allowInsecureHttp: true });
    expect(client).toBeInstanceOf(MetaLlmClient);
  });
});

describe("MetaLlmClient.health()", () => {
  it("returns health data without requiring a credential provider", async () => {
    const fetchSpy = mockFetch(200, { status: "ok", version: "0.0.1" });
    const client = new MetaLlmClient({ baseUrl: BASE_URL, transport: fetchSpy });

    const result = await client.health();

    expect(result.data).toEqual({ status: "ok", version: "0.0.1" });
    expect(result.meta.httpStatus).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/health`);
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBeUndefined();
  });

  it("maps a 503 to a retryable AgenticError", async () => {
    const fetchSpy = mockFetch(503, { error: "upstream unavailable" });
    const client = new MetaLlmClient({ baseUrl: BASE_URL, transport: fetchSpy });

    await expect(client.health()).rejects.toMatchObject({
      kind: "transport",
      retryable: true,
      status: 503,
    });
  });

  it("never acquires a credential even when a provider is configured (ADR-0024a §D1)", async () => {
    // FIX 3 regression test: before the fix, `getJson` called
    // `resolveCredential` (and thus `provider.acquire()`) unconditionally
    // regardless of `requireCredential`, only discarding the result for
    // health(). A spy provider proves acquire() is now skipped entirely
    // rather than acquired-and-discarded.
    const fetchSpy = mockFetch(200, { status: "ok" });
    const { provider, acquire } = makeSpyCredentialProvider();
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: provider,
    });

    const result = await client.health();

    expect(result.data).toEqual({ status: "ok" });
    expect(acquire).not.toHaveBeenCalled();
  });
});

describe("MetaLlmClient.whoami()", () => {
  it("acquires a credential and sends it as X-API-Key", async () => {
    const fetchSpy = mockFetch(200, { accountId: "acct_1", credentialType: "api_key" });
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const result = await client.whoami();

    expect(result.data.accountId).toBe("acct_1");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/whoami`);
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("sk-test-canary-1234");
  });

  it("fails closed when no credential provider is configured", async () => {
    const fetchSpy = vi.fn();
    const client = new MetaLlmClient({ baseUrl: BASE_URL, transport: fetchSpy });

    await expect(client.whoami()).rejects.toMatchObject({ kind: "authentication" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a credential provider bound to a different origin", async () => {
    // FIX 4 regression test: a CredentialProvider constructed for a
    // DIFFERENT origin than the client's own baseUrl must be refused
    // (ADR-0022 §D3: "Credential providers are bound to the normalized
    // origin selected during client construction"). Asserts the request
    // never reached the wire either, proving no credential leaked to the
    // wrong origin.
    const fetchSpy = vi.fn();
    const mismatchedProvider = new StaticApiKeyCredentialProvider({
      apiKey: "sk-wrong-origin-canary",
      product: "meta-llm",
      normalizedOrigin: "https://a-completely-different-origin.example.com",
      audience: "https://a-completely-different-origin.example.com",
    });
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: mismatchedProvider,
    });

    await expect(client.whoami()).rejects.toMatchObject({ kind: "authentication" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps a 401 to a non-retryable authentication AgenticError", async () => {
    const fetchSpy = mockFetch(401, { error: "invalid key" });
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    await expect(client.whoami()).rejects.toMatchObject({
      kind: "authentication",
      retryable: false,
      status: 401,
    });
  });

  it("maps 429 to a retryable rate_limited error with retryAfterMs", async () => {
    const fetchSpy = mockFetch(429, { error: "slow down" }, { "retry-after": "2" });
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    await expect(client.whoami()).rejects.toMatchObject({
      kind: "rate_limited",
      retryable: true,
      retryAfterMs: 2000,
    });
  });
});

describe("MetaLlmClient.models()", () => {
  it("returns the model list", async () => {
    const fetchSpy = mockFetch(200, { models: [{ id: "meta-llm-large" }] });
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const result = await client.models();

    expect(result.data.models).toHaveLength(1);
    expect(result.data.models[0].id).toBe("meta-llm-large");
  });
});

describe("MetaLlmClient.capabilities()", () => {
  it("returns the configured static snapshot without any I/O", () => {
    const fetchSpy = vi.fn();
    const snapshot = {
      product: "meta-llm",
      productVersion: "0.0.1",
      protocol: "cognitum.meta-llm.http",
      protocolVersion: "1.0",
      features: { chat: true },
      limitations: [],
      authMethods: ["api_key"],
      source: "static-compatibility-table" as const,
    };
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      capabilitiesSnapshot: snapshot,
    });

    expect(client.capabilities()).toEqual(snapshot);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to an intersection-safe default when unconfigured", () => {
    const client = new MetaLlmClient({ baseUrl: BASE_URL });
    const caps = client.capabilities();
    expect(caps.features).toEqual({});
    expect(caps.source).toBe("static-compatibility-table");
  });
});

describe("MetaLlmClient.ready()", () => {
  it("fails closed — no readiness endpoint is published yet", async () => {
    const client = new MetaLlmClient({ baseUrl: BASE_URL });
    await expect(client.ready("chat")).rejects.toBeInstanceOf(AgenticError);
    await expect(client.ready("chat")).rejects.toMatchObject({
      kind: "unsupported_capability",
    });
  });
});

describe("MetaLlmClient protocol placeholders", () => {
  const client = new MetaLlmClient({ baseUrl: BASE_URL });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("chat.completions is not implemented yet", async () => {
    await expect(
      client.chat.completions({ model: "m", messages: [] }),
    ).rejects.toMatchObject({ kind: "unsupported_capability" });
  });

  it("completions is not implemented yet", async () => {
    await expect(client.completions({ model: "m", prompt: "hi" })).rejects.toMatchObject({
      kind: "unsupported_capability",
    });
  });

  it("messages.create and messages.countTokens are not implemented yet", async () => {
    await expect(
      client.messages.create({ model: "m", messages: [], maxTokens: 16 }),
    ).rejects.toMatchObject({ kind: "unsupported_capability" });
    await expect(
      client.messages.countTokens({ model: "m", messages: [] }),
    ).rejects.toMatchObject({ kind: "unsupported_capability" });
  });

  it("responses is not implemented yet", async () => {
    await expect(client.responses({ model: "m", input: "hi" })).rejects.toMatchObject({
      kind: "unsupported_capability",
    });
  });

  it("embeddings is not implemented yet", async () => {
    await expect(client.embeddings({ model: "m", input: "hi" })).rejects.toMatchObject({
      kind: "unsupported_capability",
    });
  });
});
