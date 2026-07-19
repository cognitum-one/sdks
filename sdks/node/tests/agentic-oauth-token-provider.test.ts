import { describe, it, expect, vi } from "vitest";

import {
  OAuthTokenCredentialProvider,
  type OAuthTokenSourceResult,
} from "../src/agentic/oauth-token-provider.js";
import { RedactedSecret, type CredentialRequest } from "../src/agentic/credentials.js";
import { AgenticError } from "../src/agentic/errors.js";

const CANARY = "oauth-canary-9f3aQzL0m1";
const REFRESHED = "oauth-refreshed-CT9f3aQ";

function baseRequest(overrides?: Partial<CredentialRequest>): CredentialRequest {
  return {
    product: "meta-llm",
    normalizedOrigin: "https://meta-llm.test.cognitum.one",
    audience: "https://meta-llm.test.cognitum.one",
    requiredScopes: [],
    operation: "chat.completions",
    interactiveAllowed: false,
    ...overrides,
  };
}

function makeProvider(
  overrides?: Partial<
    import("../src/agentic/oauth-token-provider.js").OAuthTokenCredentialProviderOptions
  >,
): OAuthTokenCredentialProvider {
  return new OAuthTokenCredentialProvider({
    accessToken: CANARY,
    product: "meta-llm",
    normalizedOrigin: "https://meta-llm.test.cognitum.one",
    audience: "https://meta-llm.test.cognitum.one",
    ...overrides,
  });
}

describe("OAuthTokenCredentialProvider", () => {
  it("acquires a credential for the matching origin + audience using an explicit token", async () => {
    const provider = makeProvider();
    const credential = await provider.acquire(baseRequest());

    expect(credential.scheme).toBe("Bearer");
    expect(credential.audience).toBe("https://meta-llm.test.cognitum.one");
    expect(credential.authority.normalizedOrigin).toBe("https://meta-llm.test.cognitum.one");
    expect(credential.authority.product).toBe("meta-llm");
    expect(credential.secret).toBeInstanceOf(RedactedSecret);
    expect(credential.secret.reveal()).toBe(CANARY);
  });

  it("uses Bearer scheme, not X-API-Key", async () => {
    const provider = makeProvider();
    const credential = await provider.acquire(baseRequest());
    expect(credential.scheme.toLowerCase()).toBe("bearer");
    expect(credential.scheme).not.toBe("X-API-Key");
  });

  it("acquires an initial token lazily from a tokenProvider callback", async () => {
    const tokenProvider = vi.fn(
      async (): Promise<OAuthTokenSourceResult> => ({ accessToken: CANARY }),
    );
    const provider = new OAuthTokenCredentialProvider({
      product: "meta-llm",
      normalizedOrigin: "https://meta-llm.test.cognitum.one",
      audience: "https://meta-llm.test.cognitum.one",
      tokenProvider,
    });

    const credential = await provider.acquire(baseRequest());
    expect(credential.secret.reveal()).toBe(CANARY);
    expect(tokenProvider).toHaveBeenCalledTimes(1);

    // Second acquire reuses the cached (non-expired) token — no refresh.
    await provider.acquire(baseRequest());
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });

  it("refreshes an expired explicit token exactly once via the callback", async () => {
    const past = new Date(Date.now() - 60_000);
    const tokenProvider = vi.fn(
      async (): Promise<OAuthTokenSourceResult> => ({ accessToken: REFRESHED }),
    );
    const provider = new OAuthTokenCredentialProvider({
      accessToken: CANARY,
      expiresAt: past,
      product: "meta-llm",
      normalizedOrigin: "https://meta-llm.test.cognitum.one",
      audience: "https://meta-llm.test.cognitum.one",
      tokenProvider,
    });

    const credential = await provider.acquire(baseRequest());
    expect(credential.secret.reveal()).toBe(REFRESHED);
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the explicit token is expired and no tokenProvider is configured", async () => {
    const past = new Date(Date.now() - 60_000);
    const provider = new OAuthTokenCredentialProvider({
      accessToken: CANARY,
      expiresAt: past,
      product: "meta-llm",
      normalizedOrigin: "https://meta-llm.test.cognitum.one",
      audience: "https://meta-llm.test.cognitum.one",
    });

    await expect(provider.acquire(baseRequest())).rejects.toMatchObject({
      kind: "authentication",
    });
  });

  it("fails closed when the tokenProvider itself returns an already-expired token", async () => {
    const past = new Date(Date.now() - 60_000);
    const tokenProvider = vi.fn(
      async (): Promise<OAuthTokenSourceResult> => ({ accessToken: REFRESHED, expiresAt: past }),
    );
    const provider = new OAuthTokenCredentialProvider({
      product: "meta-llm",
      normalizedOrigin: "https://meta-llm.test.cognitum.one",
      audience: "https://meta-llm.test.cognitum.one",
      tokenProvider,
    });

    await expect(provider.acquire(baseRequest())).rejects.toMatchObject({
      kind: "authentication",
    });
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });

  it("fails at construction with neither accessToken nor tokenProvider", () => {
    expect(
      () =>
        new OAuthTokenCredentialProvider({
          product: "meta-llm",
          normalizedOrigin: "https://meta-llm.test.cognitum.one",
          audience: "https://meta-llm.test.cognitum.one",
        }),
    ).toThrowError(AgenticError);
  });

  it("refuses acquire() for a different origin (redirect-not-followed-with-credentials, ADR-0022 §D3)", async () => {
    const provider = makeProvider();
    await expect(
      provider.acquire(baseRequest({ normalizedOrigin: "https://evil.example.com" })),
    ).rejects.toMatchObject({ name: "AgenticError", kind: "authentication" });
  });

  it("refuses an audience mismatch (ADR-0022 §D1)", async () => {
    const provider = makeProvider();
    await expect(
      provider.acquire(baseRequest({ audience: "meta-proxy-api" })),
    ).rejects.toMatchObject({ kind: "authentication" });
  });

  it("refuses a product mismatch (confused-deputy control)", async () => {
    const provider = makeProvider();
    await expect(
      provider.acquire(baseRequest({ product: "meta-proxy" })),
    ).rejects.toMatchObject({ kind: "authentication" });
  });

  it("does not leak the secret through JSON.stringify, template coercion, or util.inspect", async () => {
    const provider = makeProvider();
    const credential = await provider.acquire(baseRequest());

    const serialized = JSON.stringify(credential);
    expect(serialized).not.toContain(CANARY);
    expect(serialized).toContain("[REDACTED]");

    const coerced = `${credential.secret}`;
    expect(coerced).toBe("[REDACTED]");
    expect(coerced).not.toContain(CANARY);

    const { inspect } = await import("node:util");
    const inspected = inspect(credential.secret);
    expect(inspected).not.toContain(CANARY);
  });

  it("does not leak the secret through a thrown AgenticError's message or JSON form", async () => {
    const provider = makeProvider();
    let caught: unknown;
    try {
      await provider.acquire(baseRequest({ normalizedOrigin: "https://evil.example.com" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error;
    expect(err.message).not.toContain(CANARY);
    expect(JSON.stringify(err)).not.toContain(CANARY);
    expect(String(err)).not.toContain(CANARY);
  });

  it("identity() is stable, non-secret, and does not embed the raw token", async () => {
    const provider = makeProvider();
    const id = provider.identity();
    expect(id).not.toContain(CANARY);
    expect(id).toBe(provider.identity());
    // Stable even after acquire() has run.
    await provider.acquire(baseRequest());
    expect(provider.identity()).toBe(id);
  });

  it("refuses acquire() after invalidate()", async () => {
    const provider = makeProvider();
    await provider.invalidate("rotated");
    await expect(provider.acquire(baseRequest())).rejects.toMatchObject({
      kind: "authentication",
    });
  });

  it("carries grantedScopes through onto the acquired credential when known", async () => {
    const provider = makeProvider({ grantedScopes: ["meta-llm.inference"] });
    const credential = await provider.acquire(baseRequest());
    expect(credential.grantedScopes).toEqual(["meta-llm.inference"]);
  });

  it("leaves grantedScopes undefined when the caller never supplied any (unknown, not empty)", async () => {
    const provider = makeProvider();
    const credential = await provider.acquire(baseRequest());
    expect(credential.grantedScopes).toBeUndefined();
  });
});
