import { describe, it, expect, vi } from "vitest";

import { MetaLlmClient } from "../src/meta-llm/client.js";
import type { Credential, CredentialProvider, CredentialRequest } from "../src/agentic/credentials.js";

/**
 * ADR-0022 §D5 scope preflight, wired into `MetaLlmClient`'s shared
 * request-building path (`./nonstream.js`'s `requireCredential` for
 * completion-family routes, `client.ts`'s `getJson` for
 * `whoami`/`models`/`usage`). "Before a billable or mutating call, a
 * provider with known granted scopes is checked locally. Missing scope
 * returns `PermissionDeniedError` before I/O." Distinct from
 * `meta-llm-nonstream.test.ts`'s 401/429/502/503 HTTP-mapping tests — this
 * file only covers the LOCAL preflight, so every "blocked" case below
 * asserts the transport spy was never invoked.
 */

const BASE_URL = "https://meta-llm.test.cognitum.one";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `Status ${status}`,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function makeScopedProvider(grantedScopes: string[] | undefined): CredentialProvider {
  return {
    describeAuthority: vi.fn(),
    identity: () => "scoped-test-provider",
    invalidate: vi.fn(),
    acquire: vi.fn(async (request: CredentialRequest): Promise<Credential> => ({
      scheme: "Bearer",
      secret: { reveal: () => "oauth-test-token" } as Credential["secret"],
      audience: request.audience,
      grantedScopes,
      source: "scoped-test-provider",
      authority: {
        providerFingerprint: "scoped-test",
        product: request.product,
        normalizedOrigin: request.normalizedOrigin,
        audience: request.audience,
        effectiveScopes: grantedScopes,
      },
    })),
  };
}

function chatRequest() {
  return { model: "meta-llm-large", messages: [{ role: "user" as const, content: "hello" }] };
}

describe("ADR-0022 §D5 scope preflight — completion-family routes", () => {
  it("blocks chat.completions before any HTTP call when granted scopes are known and insufficient", async () => {
    const fetchSpy = vi.fn();
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeScopedProvider(["some-other-scope"]),
    });

    await expect(client.chat.completions(chatRequest())).rejects.toMatchObject({
      kind: "permission_denied",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows chat.completions through to the server when granted scopes are unknown (absent)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "meta-llm-large",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeScopedProvider(undefined),
    });

    const result = await client.chat.completions(chatRequest());
    expect(result.data.id).toBe("chatcmpl-1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("allows chat.completions through when granted scopes are known and sufficient", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        id: "chatcmpl-2",
        object: "chat.completion",
        created: 1,
        model: "meta-llm-large",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeScopedProvider(["meta-llm.inference"]),
    });

    const result = await client.chat.completions(chatRequest());
    expect(result.data.id).toBe("chatcmpl-2");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("blocks embeddings before any HTTP call under the same insufficient-scope credential", async () => {
    const fetchSpy = vi.fn();
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeScopedProvider(["meta-llm.read"]),
    });

    await expect(
      client.embeddings({ model: "meta-llm-embed", input: "hello" }),
    ).rejects.toMatchObject({ kind: "permission_denied" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("ADR-0022 §D5 scope preflight — platform/read routes (whoami)", () => {
  it("blocks whoami() before any HTTP call when granted scopes are known and cover only completion scopes (ADR-0024a §D8: OAuth platform access is never assumed)", async () => {
    const fetchSpy = vi.fn();
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeScopedProvider(["meta-llm.inference"]),
    });

    await expect(client.whoami()).rejects.toMatchObject({ kind: "permission_denied" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows whoami() through when granted scopes are unknown (absent)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, { accountId: "acct_1", credentialType: "oauth" }),
    );
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeScopedProvider(undefined),
    });

    const result = await client.whoami();
    expect(result.data.accountId).toBe("acct_1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
