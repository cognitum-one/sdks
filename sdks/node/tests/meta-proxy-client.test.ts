import { describe, it, expect, vi, afterEach } from "vitest";

import { MetaProxyClient } from "../src/meta-proxy/client.js";
import { __resetMetaProxyNonLoopbackWarnLatch } from "../src/meta-proxy/config.js";
import { StaticApiKeyCredentialProvider } from "../src/agentic/static-api-key-provider.js";
import type { CredentialProvider } from "../src/agentic/credentials.js";

const ORIGIN = "http://127.0.0.1:11435";

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

/** A local bearer-token provider, standing in for D6's `LocalBearerToken` (deferred). */
function localBearerProvider(): StaticApiKeyCredentialProvider {
  return new StaticApiKeyCredentialProvider({
    apiKey: "mh1.canary-local-token",
    product: "meta-proxy",
    normalizedOrigin: ORIGIN,
    audience: ORIGIN,
    scheme: "bearer",
  });
}

function makeSpyCredentialProvider(): {
  provider: CredentialProvider;
  acquire: ReturnType<typeof vi.fn>;
} {
  const acquire = vi.fn().mockResolvedValue({
    scheme: "bearer",
    secret: { reveal: () => "mh1.spy-canary" },
    audience: ORIGIN,
    source: "spy",
    authority: {
      providerFingerprint: "spy",
      product: "meta-proxy",
      normalizedOrigin: ORIGIN,
      audience: ORIGIN,
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

const FULL_STATUS_BODY = {
  product_version: "0.4.0",
  protocol_version: "1.0",
  compatible_sdk_range: ">=0.1.0 <1.0.0",
  process_state: "running",
  bind: "127.0.0.1:11435",
  configured_plane: "local",
  selected_plane: "local",
  routing_reason: "configured_default",
  automatic_usage_state: "disabled",
  workload_policy: "standard",
  sponsored_available: false,
  cloud_credential_source: "none",
  limitations: ["no capabilities endpoint published yet"],
  request_id: "req_status_1",
};

describe("MetaProxyClient construction", () => {
  afterEach(() => {
    __resetMetaProxyNonLoopbackWarnLatch();
  });

  it("performs no I/O and defaults to the documented loopback origin", () => {
    const fetchSpy = vi.fn();
    const client = new MetaProxyClient({ transport: fetchSpy });
    expect(client).toBeInstanceOf(MetaProxyClient);
    expect(client.getConfig().origin).toBe(ORIGIN);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts an explicit loopback origin", () => {
    const client = new MetaProxyClient({ origin: "http://127.0.0.1:19999" });
    expect(client.getConfig().origin).toBe("http://127.0.0.1:19999");
  });

  it("accepts a literal IPv6 loopback origin", () => {
    const client = new MetaProxyClient({ origin: "http://[::1]:11435" });
    expect(client).toBeInstanceOf(MetaProxyClient);
  });

  it("rejects a non-loopback origin by default (ADR-0025a §D10)", () => {
    expect(() => new MetaProxyClient({ origin: "http://example.com:11435" })).toThrow(TypeError);
  });

  it("rejects a hostname that merely resolves to loopback", () => {
    expect(() => new MetaProxyClient({ origin: "http://localhost:11435" })).toThrow(TypeError);
  });

  it("allows a non-loopback origin only when allowNonLoopback is set (dangerous preview)", () => {
    const client = new MetaProxyClient({
      origin: "http://example.com:11435",
      allowNonLoopback: true,
    });
    expect(client).toBeInstanceOf(MetaProxyClient);
  });

  it("rejects a non-http(s) origin", () => {
    expect(() => new MetaProxyClient({ origin: "ftp://127.0.0.1:11435" })).toThrow(TypeError);
  });
});

describe("MetaProxyClient.status()", () => {
  it("returns parsed status data on success", async () => {
    const fetchSpy = mockFetch(200, FULL_STATUS_BODY, {
      "x-cognitum-request-id": "req_status_1",
      "x-cognitum-protocol-version": "1.0",
    });
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    const result = await client.status();

    expect(result.data.productVersion).toBe("0.4.0");
    expect(result.data.processState).toBe("running");
    expect(result.data.configuredPlane).toBe("local");
    expect(result.data.selectedPlane).toBe("local");
    expect(result.data.workloadPolicy).toBe("standard");
    expect(result.data.sponsoredAvailable).toBe(false);
    expect(result.meta.httpStatus).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${ORIGIN}/status`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer mh1.canary-local-token",
    );
  });

  it("preserves unrecognized fields verbatim under raw", async () => {
    const fetchSpy = mockFetch(200, {
      ...FULL_STATUS_BODY,
      a_brand_new_field_the_sdk_does_not_know_about: "surprise",
    });
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    const result = await client.status();

    expect(result.data.raw).toEqual({
      a_brand_new_field_the_sdk_does_not_know_about: "surprise",
    });
  });

  it("fails closed without a localCredentialProvider (Proxy /status is authenticated)", async () => {
    const fetchSpy = vi.fn();
    const client = new MetaProxyClient({ transport: fetchSpy });

    await expect(client.status()).rejects.toMatchObject({ kind: "authentication" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never sends credentials for a mismatched-origin provider", async () => {
    const fetchSpy = vi.fn();
    const mismatched = new StaticApiKeyCredentialProvider({
      apiKey: "mh1.wrong-origin-canary",
      product: "meta-proxy",
      normalizedOrigin: "http://127.0.0.1:9",
      audience: "http://127.0.0.1:9",
      scheme: "bearer",
    });
    const client = new MetaProxyClient({ transport: fetchSpy, localCredentialProvider: mismatched });

    await expect(client.status()).rejects.toMatchObject({ kind: "authentication" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps a connection failure to a retryable transport AgenticError", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    await expect(client.status()).rejects.toMatchObject({
      kind: "transport",
      retryable: true,
    });
  });

  it("maps a 401 to a non-retryable authentication AgenticError", async () => {
    const fetchSpy = mockFetch(401, { error: "invalid local token" });
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    await expect(client.status()).rejects.toMatchObject({
      kind: "authentication",
      retryable: false,
      status: 401,
    });
  });

  it("maps a 429 to a retryable rate_limited error", async () => {
    const fetchSpy = mockFetch(429, { error: "slow down" }, { "retry-after": "3" });
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    await expect(client.status()).rejects.toMatchObject({
      kind: "rate_limited",
      retryable: true,
      retryAfterMs: 3000,
    });
  });

  it("maps a 503 (Proxy process degraded) to a retryable transport error", async () => {
    const fetchSpy = mockFetch(503, { error: "local backend unavailable" });
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    await expect(client.status()).rejects.toMatchObject({ kind: "transport", retryable: true });
  });

  it("never acquires a credential twice per call and passes X-Cognitum-Request-Id", async () => {
    const fetchSpy = mockFetch(200, FULL_STATUS_BODY);
    const { provider, acquire } = makeSpyCredentialProvider();
    const client = new MetaProxyClient({ transport: fetchSpy, localCredentialProvider: provider });

    await client.status();

    expect(acquire).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    expect((init.headers as Record<string, string>)["X-Cognitum-Request-Id"]).toBeTruthy();
  });
});

describe("MetaProxyClient.capabilities()", () => {
  it("derives a CapabilitySet-shaped result from the real /status call", async () => {
    const fetchSpy = mockFetch(200, FULL_STATUS_BODY);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    const result = await client.capabilities();

    expect(result.data.product).toBe("meta-proxy");
    expect(result.data.productVersion).toBe("0.4.0");
    expect(result.data.protocol).toBe("cognitum.meta-proxy.http");
    expect(result.data.source).toBe("server");
    expect(result.data.configuredPlane).toBe("local");
    expect(result.data.selectedPlane).toBe("local");
    expect(result.data.limitations).toContain("no capabilities endpoint published yet");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${ORIGIN}/status`);
  });

  it("merges the configured capabilitiesSnapshot's features/authMethods", async () => {
    const fetchSpy = mockFetch(200, FULL_STATUS_BODY);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
      capabilitiesSnapshot: {
        product: "meta-proxy",
        productVersion: "0.0.0",
        protocol: "cognitum.meta-proxy.http",
        protocolVersion: "1.0",
        features: { status: true },
        limitations: ["pinned-table limitation"],
        authMethods: ["local_bearer"],
        source: "static-compatibility-table",
      },
    });

    const result = await client.capabilities();

    expect(result.data.features).toEqual({ status: true });
    expect(result.data.authMethods).toEqual(["local_bearer"]);
    expect(result.data.limitations).toContain("pinned-table limitation");
  });

  it("warns when expectedProxyVersion does not match the reported productVersion", async () => {
    const fetchSpy = mockFetch(200, FULL_STATUS_BODY);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
      expectedProxyVersion: "9.9.9",
    });

    const result = await client.capabilities();

    expect(result.meta.warnings?.some((w) => w.includes("9.9.9"))).toBe(true);
  });

  it("fails closed without a localCredentialProvider, same as status()", async () => {
    const fetchSpy = vi.fn();
    const client = new MetaProxyClient({ transport: fetchSpy });

    await expect(client.capabilities()).rejects.toMatchObject({ kind: "authentication" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never sends a prompt / inference request to discover support", async () => {
    const fetchSpy = mockFetch(200, FULL_STATUS_BODY);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    await client.capabilities();

    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.body).toBeUndefined();
    }
  });
});
