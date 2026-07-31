import { describe, it, expect } from "vitest";

import {
  StaticApiKeyCredentialProvider,
  DEFAULT_API_KEY_ENV_VAR,
} from "../src/agentic/static-api-key-provider.js";
import { RedactedSecret, type CredentialRequest } from "../src/agentic/credentials.js";
import { AgenticError } from "../src/agentic/errors.js";

const CANARY = "sk-canary-CT9f3aQzL0m1";

function baseRequest(overrides?: Partial<CredentialRequest>): CredentialRequest {
  return {
    product: "cognitum-cloud",
    normalizedOrigin: "https://api.cognitum.one",
    audience: "cognitum-cloud-api",
    requiredScopes: [],
    operation: "catalog.browse",
    interactiveAllowed: false,
    ...overrides,
  };
}

function makeProvider(
  overrides?: Partial<import("../src/agentic/static-api-key-provider.js").StaticApiKeyCredentialProviderOptions>,
): StaticApiKeyCredentialProvider {
  return new StaticApiKeyCredentialProvider({
    apiKey: CANARY,
    product: "cognitum-cloud",
    normalizedOrigin: "https://api.cognitum.one",
    audience: "cognitum-cloud-api",
    ...overrides,
  });
}

describe("StaticApiKeyCredentialProvider", () => {
  it("acquires a credential for the matching origin + audience", async () => {
    const provider = makeProvider();
    const credential = await provider.acquire(baseRequest());

    expect(credential.scheme).toBe("X-API-Key");
    expect(credential.audience).toBe("cognitum-cloud-api");
    expect(credential.authority.normalizedOrigin).toBe("https://api.cognitum.one");
    expect(credential.authority.product).toBe("cognitum-cloud");
    expect(credential.secret).toBeInstanceOf(RedactedSecret);
    expect(credential.secret.reveal()).toBe(CANARY);
  });

  it("describeAuthority succeeds for the matching origin + audience", async () => {
    const provider = makeProvider();
    const authority = await provider.describeAuthority(baseRequest());
    expect(authority.audience).toBe("cognitum-cloud-api");
    expect(authority.normalizedOrigin).toBe("https://api.cognitum.one");
  });

  it("refuses acquire() for a different origin (redirect-not-followed-with-credentials, ADR-0022 §D3)", async () => {
    const provider = makeProvider();
    await expect(
      provider.acquire(baseRequest({ normalizedOrigin: "https://evil.example.com" })),
    ).rejects.toMatchObject({
      name: "AgenticError",
      kind: "authentication",
    });
  });

  it("refuses describeAuthority() for a different origin", async () => {
    const provider = makeProvider();
    await expect(
      provider.describeAuthority(baseRequest({ normalizedOrigin: "https://evil.example.com" })),
    ).rejects.toBeInstanceOf(AgenticError);
  });

  it("refuses a subdomain/suffix-matching origin — no wildcard trust (ADR-0022 §D3)", async () => {
    const provider = makeProvider();
    await expect(
      provider.acquire(baseRequest({ normalizedOrigin: "https://sub.api.cognitum.one" })),
    ).rejects.toMatchObject({ kind: "authentication" });
  });

  it("refuses an audience mismatch (ADR-0022 §D1)", async () => {
    const provider = makeProvider();
    await expect(
      provider.acquire(baseRequest({ audience: "meta-llm-api" })),
    ).rejects.toMatchObject({ kind: "authentication" });
  });

  it("refuses a product mismatch (confused-deputy control, ADR-0022 §D11)", async () => {
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

  it("identity() is stable, non-secret, and does not embed the raw key", () => {
    const provider = makeProvider();
    const id = provider.identity();
    expect(id).not.toContain(CANARY);
    expect(id).toBe(provider.identity());
  });

  it("resolves the key from COGNITUM_API_KEY when no explicit apiKey is given", async () => {
    const provider = new StaticApiKeyCredentialProvider({
      product: "cognitum-cloud",
      normalizedOrigin: "https://api.cognitum.one",
      audience: "cognitum-cloud-api",
      env: { [DEFAULT_API_KEY_ENV_VAR]: CANARY },
    });
    const credential = await provider.acquire(baseRequest());
    expect(credential.secret.reveal()).toBe(CANARY);
  });

  it("fails at construction when neither apiKey nor env var is present", () => {
    expect(
      () =>
        new StaticApiKeyCredentialProvider({
          product: "cognitum-cloud",
          normalizedOrigin: "https://api.cognitum.one",
          audience: "cognitum-cloud-api",
          env: {},
        }),
    ).toThrowError(AgenticError);
  });

  it("refuses acquire() after invalidate()", async () => {
    const provider = makeProvider();
    await provider.invalidate("rotated");
    await expect(provider.acquire(baseRequest())).rejects.toMatchObject({
      kind: "authentication",
    });
  });
});
