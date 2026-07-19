import { describe, it, expect, vi, afterEach } from "vitest";

import { MetaProxyClient } from "../src/meta-proxy/client.js";
import { isBearerAttachmentAllowed } from "../src/meta-proxy/config.js";
import {
  LocalBearerTokenCredentialProvider,
  DEFAULT_META_PROXY_TOKEN_ENV_VAR,
} from "../src/meta-proxy/auth.js";
import {
  assertRoutingReceiptMatchesIntent,
  type RoutingIntent,
} from "../src/meta-proxy/routing.js";
import { PROXY_CHAT_FORWARD_HEADER_ALLOWLIST } from "../src/meta-proxy/forwarding.js";
import type { ChatCompletionRequest } from "../src/meta-llm/types/openai.js";
import type { MetaProxyRoutingReceipt } from "../src/meta-proxy/status.js";

const ORIGIN = "http://127.0.0.1:11435";

const REQUEST: ChatCompletionRequest = {
  model: "gpt-proxy",
  messages: [{ role: "user", content: "hello" }],
};

function res(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `Status ${status}`,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

/** A fetch mock that returns queued responses in order. */
function queuedFetch(responses: Response[]): ReturnType<typeof vi.fn> {
  const queue = [...responses];
  return vi.fn().mockImplementation(() => {
    const next = queue.shift();
    if (!next) throw new Error("queuedFetch: no more responses queued");
    return Promise.resolve(next);
  });
}

function localBearerProvider(): LocalBearerTokenCredentialProvider {
  return new LocalBearerTokenCredentialProvider({
    token: "mh1.canary-local-token",
    normalizedOrigin: ORIGIN,
  });
}

function routingReceiptBody(selectedPlane: string): Record<string, unknown> {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "gpt-proxy",
    choices: [
      { index: 0, message: { role: "assistant", content: "hi" }, finishReason: "stop" },
    ],
    cognitum_routing_receipt: {
      request_id: "rr-1",
      configured_plane: "local",
      selected_plane: selectedPlane,
      routing_reason: "configured_default",
      automatic: false,
      workload_policy: "standard",
      degraded: false,
    },
  };
}

describe("MetaProxyClient.chat.completions() — required-plane verification (§D5 rule 7)", () => {
  it("REJECTS a 200 whose routing receipt contradicts requiredPlane", async () => {
    // Server returns a well-formed 200, but the selected plane is NOT the one
    // the caller required — this is a protocol violation even though output
    // succeeded (ADR-0025a §D5 rule 7).
    const fetchSpy = queuedFetch([res(200, routingReceiptBody("cognitum_cloud"))]);
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

    await expect(
      client.chat.completions(REQUEST, { routingIntent: intent }),
    ).rejects.toMatchObject({
      kind: "protocol",
      retryable: false,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("accepts a 200 whose routing receipt matches requiredPlane", async () => {
    const fetchSpy = queuedFetch([res(200, routingReceiptBody("local"))]);
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

    const result = await client.chat.completions(REQUEST, { routingIntent: intent });
    expect(result.data.id).toBe("chatcmpl-1");
    expect(result.meta.routingReceipt?.selectedPlane).toBe("local");
  });

  it("rejects requiredPlane when the response carries no receipt to verify", async () => {
    const body = { id: "chatcmpl-2", object: "chat.completion", created: 1, model: "m", choices: [] };
    const fetchSpy = queuedFetch([res(200, body)]);
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

    await expect(
      client.chat.completions(REQUEST, { routingIntent: intent }),
    ).rejects.toMatchObject({ kind: "protocol" });
  });
});

describe("assertRoutingReceiptMatchesIntent (unit)", () => {
  const receipt: MetaProxyRoutingReceipt = {
    requestId: "r",
    configuredPlane: "local",
    selectedPlane: "cognitum_cloud",
    automatic: false,
    degraded: false,
  };

  it("is a no-op when no intent / no requiredPlane", () => {
    expect(() => assertRoutingReceiptMatchesIntent(undefined, receipt)).not.toThrow();
    expect(() =>
      assertRoutingReceiptMatchesIntent(
        { allowedPlanes: [], workloadPolicy: "standard", consentGrants: [], trainingShare: false, failIfUnavailable: false },
        receipt,
      ),
    ).not.toThrow();
  });

  it("throws on a mismatch", () => {
    expect(() =>
      assertRoutingReceiptMatchesIntent(
        {
          requiredPlane: "local",
          allowedPlanes: ["local"],
          workloadPolicy: "standard",
          consentGrants: [],
          trainingShare: false,
          failIfUnavailable: false,
        },
        receipt,
      ),
    ).toThrow(/required-plane mismatch|protocol/i);
  });
});

describe("MetaProxyClient.chat.completions() — forwarding header allowlist (§D7)", () => {
  it("NEVER forwards forbidden caller headers, but passes allowlisted ones", async () => {
    const fetchSpy = queuedFetch([res(200, routingReceiptBody("local"))]);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    await client.chat.completions(REQUEST, {
      forwardHeaders: {
        // Forbidden — must be dropped before the request is built.
        Authorization: "Bearer attacker-supplied",
        "X-Cognitum-Sponsor": "true",
        Host: "evil.example.com",
        "Content-Length": "0",
        "X-Cognitum-Installation-Id": "spoofed",
        // Allowlisted — must pass through.
        traceparent: "00-abc-def-01",
        "X-Cognitum-Safety": "strict",
        "X-Cognitum-Sub-Tenant": "team-a",
      },
    });

    const [, init] = fetchSpy.mock.calls[0];
    const headers = init.headers as Record<string, string>;

    // The bearer is the SDK-derived local bearer, NOT the attacker's value.
    expect(headers.Authorization).toBe("Bearer mh1.canary-local-token");
    expect(Object.values(headers)).not.toContain("Bearer attacker-supplied");

    // No forbidden header reached the wire (case-insensitive check).
    const lowerKeys = Object.keys(headers).map((k) => k.toLowerCase());
    expect(lowerKeys).not.toContain("x-cognitum-sponsor");
    expect(lowerKeys).not.toContain("host");
    expect(lowerKeys).not.toContain("content-length");
    expect(lowerKeys).not.toContain("x-cognitum-installation-id");

    // Allowlisted headers did pass through.
    expect(headers.traceparent).toBe("00-abc-def-01");
    expect(headers["X-Cognitum-Safety"]).toBe("strict");
    expect(headers["X-Cognitum-Sub-Tenant"]).toBe("team-a");
  });

  it("drops forbidden headers regardless of letter case", async () => {
    const fetchSpy = queuedFetch([res(200, routingReceiptBody("local"))]);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    await client.chat.completions(REQUEST, {
      forwardHeaders: { authorization: "Bearer attacker", "X-COGNITUM-SPONSOR": "1" },
    });

    const [, init] = fetchSpy.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer mh1.canary-local-token");
    expect(Object.values(headers)).not.toContain("Bearer attacker");
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("x-cognitum-sponsor");
  });

  it("honors a caller-supplied Idempotency-Key from the allowlist", async () => {
    const fetchSpy = queuedFetch([res(200, routingReceiptBody("local"))]);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    await client.chat.completions(REQUEST, {
      forwardHeaders: { "Idempotency-Key": "caller-key-123" },
    });

    const [, init] = fetchSpy.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("caller-key-123");
  });

  it("generates an Idempotency-Key when the caller supplies none", async () => {
    const fetchSpy = queuedFetch([res(200, routingReceiptBody("local"))]);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    await client.chat.completions(REQUEST);

    const [, init] = fetchSpy.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeTruthy();
  });

  it("keeps the allowlist stable and canonical", () => {
    expect(PROXY_CHAT_FORWARD_HEADER_ALLOWLIST).toContain("Idempotency-Key");
    expect(PROXY_CHAT_FORWARD_HEADER_ALLOWLIST).toContain("traceparent");
    expect(PROXY_CHAT_FORWARD_HEADER_ALLOWLIST).not.toContain("Authorization");
  });
});

describe("MetaProxyClient.chat.completions() — auth fail-closed (§D6)", () => {
  it("rejects with kind authentication before any HTTP call when no provider is set", async () => {
    const fetchSpy = vi.fn();
    const client = new MetaProxyClient({ transport: fetchSpy });

    await expect(client.chat.completions(REQUEST)).rejects.toMatchObject({
      kind: "authentication",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never sends the bearer through a mismatched-origin provider", async () => {
    const fetchSpy = vi.fn();
    const mismatched = new LocalBearerTokenCredentialProvider({
      token: "mh1.wrong-origin",
      normalizedOrigin: "http://127.0.0.1:9",
    });
    const client = new MetaProxyClient({ transport: fetchSpy, localCredentialProvider: mismatched });

    await expect(client.chat.completions(REQUEST)).rejects.toMatchObject({
      kind: "authentication",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("MetaProxyClient.chat.completions() — redirects rejected (§D6/§D10)", () => {
  it("does NOT follow a 3xx redirect and surfaces it as a non-retryable error", async () => {
    const fetchSpy = queuedFetch([
      res(302, {}, { location: "http://evil.example.com/v1/chat/completions" }),
    ]);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    await expect(client.chat.completions(REQUEST)).rejects.toMatchObject({
      kind: "protocol",
      retryable: false,
    });
    // Never issued a second request to the Location target.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("passes redirect: manual on the outgoing request", async () => {
    const fetchSpy = queuedFetch([res(200, routingReceiptBody("local"))]);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    await client.chat.completions(REQUEST);
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.redirect).toBe("manual");
  });
});

describe("MetaProxyClient.chat.completions() — ambient proxy env ignored (§D6)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("ignores HTTP_PROXY/HTTPS_PROXY and hits the loopback origin directly", async () => {
    process.env.HTTP_PROXY = "http://canary-proxy.invalid:9";
    process.env.HTTPS_PROXY = "http://canary-proxy.invalid:9";
    process.env.NO_PROXY = "";

    const fetchSpy = queuedFetch([res(200, routingReceiptBody("local"))]);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    await client.chat.completions(REQUEST);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${ORIGIN}/v1/chat/completions`);
    // No proxy wiring is ever passed to the transport (undici's global fetch
    // does not honor these env vars, and the SDK never opts in).
    expect("dispatcher" in init).toBe(false);
    expect("agent" in init).toBe(false);
    expect("proxy" in init).toBe(false);
  });
});

describe("MetaProxyClient.chat.completions() — response receipt decoding (§D7)", () => {
  it("decodes routing and upstream receipts into meta", async () => {
    const body = {
      ...routingReceiptBody("local"),
      cognitum_upstream_receipt: { provider: "cognitum", cost: "0.001" },
    };
    const fetchSpy = queuedFetch([
      res(200, body, {
        "x-cognitum-request-id": "srv-req-9",
        "x-cognitum-product-version": "0.4.0",
        "x-cognitum-protocol-version": "1.0",
      }),
    ]);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    const result = await client.chat.completions(REQUEST);

    expect(result.meta.requestId).toBe("srv-req-9");
    expect(result.meta.productVersion).toBe("0.4.0");
    expect(result.meta.routingReceipt?.configuredPlane).toBe("local");
    expect(result.meta.routingReceipt?.selectedPlane).toBe("local");
    expect(result.meta.upstreamReceipt).toEqual({ provider: "cognitum", cost: "0.001" });
  });
});

describe("MetaProxyClient.chat.completions() — retry/refresh (§D7)", () => {
  it("refreshes the credential once on a 401 then retries with the same idempotency key", async () => {
    // A mock provider (not the static one, whose invalidate() is permanent):
    // 401-refresh needs the provider to re-issue a fresh credential.
    const acquire = vi.fn().mockResolvedValue({
      scheme: "bearer",
      secret: { reveal: () => "mh1.canary-local-token" },
      audience: ORIGIN,
      source: "spy",
      authority: { providerFingerprint: "spy", product: "meta-proxy", normalizedOrigin: ORIGIN, audience: ORIGIN },
    });
    const invalidate = vi.fn().mockResolvedValue(undefined);
    const provider = { acquire, invalidate, describeAuthority: vi.fn(), identity: () => "spy" };
    const fetchSpy = queuedFetch([
      res(401, { error: "stale token" }),
      res(200, routingReceiptBody("local")),
    ]);
    const client = new MetaProxyClient({ transport: fetchSpy, localCredentialProvider: provider });

    const result = await client.chat.completions(REQUEST);
    expect(result.data.id).toBe("chatcmpl-1");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(2);

    const key0 = (fetchSpy.mock.calls[0][1].headers as Record<string, string>)["Idempotency-Key"];
    const key1 = (fetchSpy.mock.calls[1][1].headers as Record<string, string>)["Idempotency-Key"];
    expect(key0).toBe(key1);
  });

  // ADR-0025a §D8: "No Proxy POST is automatically retried while it drops
  // `Idempotency-Key`" — the currently-deployed Proxy drops the header
  // server-side, so the SDK attaching one does not make a silent retry safe
  // against duplicate spend (the Alternatives-considered table rejects
  // "Retry Proxy POSTs" outright). A 429/502/503 must surface as a single
  // terminal, non-retryable-by-the-SDK error after exactly one HTTP attempt,
  // preserving `retryAfterMs` so the CALLER can retry manually.
  it("never auto-retries a 503 — single attempt, terminal error, retryAfterMs preserved", async () => {
    const fetchSpy = queuedFetch([res(503, { error: "degraded" }, { "retry-after": "7" })]);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    // `retryable: true` reflects the generic HTTP error classification (a
    // caller MAY choose to retry a 503) — it does NOT mean the SDK retries it
    // automatically, which is exactly the bug: the SDK must make exactly one
    // attempt and hand the classified, terminal error back to the caller.
    await expect(client.chat.completions(REQUEST)).rejects.toMatchObject({
      status: 503,
      retryable: true,
      retryAfterMs: 7000,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("never auto-retries a 429 — single attempt, terminal error", async () => {
    const fetchSpy = queuedFetch([res(429, { error: "rate limited" }, { "retry-after": "2" })]);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    await expect(client.chat.completions(REQUEST)).rejects.toMatchObject({
      status: 429,
      retryable: true,
      retryAfterMs: 2000,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("never auto-retries a 502 — single attempt, terminal error", async () => {
    const fetchSpy = queuedFetch([res(502, { error: "bad gateway" })]);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    await expect(client.chat.completions(REQUEST)).rejects.toMatchObject({
      status: 502,
      retryable: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("never auto-retries a 400", async () => {
    const fetchSpy = queuedFetch([res(400, { error: "bad request" })]);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    await expect(client.chat.completions(REQUEST)).rejects.toMatchObject({
      kind: "validation",
      retryable: false,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("isBearerAttachmentAllowed — bearer only attaches on loopback (§D6/§D10)", () => {
  it("allows loopback origins", () => {
    expect(isBearerAttachmentAllowed("http://127.0.0.1:11435", false)).toBe(true);
    expect(isBearerAttachmentAllowed("http://[::1]:11435", false)).toBe(true);
  });

  it("REFUSES a non-loopback origin unless allowNonLoopback is explicitly set", () => {
    expect(isBearerAttachmentAllowed("http://example.com:11435", false)).toBe(false);
    expect(isBearerAttachmentAllowed("http://example.com:11435", undefined)).toBe(false);
    expect(isBearerAttachmentAllowed("http://example.com:11435", true)).toBe(true);
  });

  it("does attach the bearer when allowNonLoopback is set (dangerous-preview escape hatch)", async () => {
    const fetchSpy = queuedFetch([res(200, routingReceiptBody("local"))]);
    const provider = new LocalBearerTokenCredentialProvider({
      token: "mh1.remote-canary",
      normalizedOrigin: "http://example.com:11435",
    });
    const client = new MetaProxyClient({
      origin: "http://example.com:11435",
      allowNonLoopback: true,
      transport: fetchSpy,
      localCredentialProvider: provider,
    });

    await client.chat.completions(REQUEST);
    const [, init] = fetchSpy.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer mh1.remote-canary");
  });
});

describe("LocalBearerTokenCredentialProvider (§D6)", () => {
  it("resolves an explicit token and hands out scheme bearer", async () => {
    const provider = new LocalBearerTokenCredentialProvider({
      token: "mh1.explicit",
      normalizedOrigin: ORIGIN,
    });
    const cred = await provider.acquire({
      product: "meta-proxy",
      normalizedOrigin: ORIGIN,
      audience: ORIGIN,
      requiredScopes: ["meta-proxy.inference"],
      operation: "chat.completions",
      interactiveAllowed: false,
    });
    expect(cred.scheme).toBe("bearer");
    expect(cred.secret.reveal()).toBe("mh1.explicit");
  });

  it("resolves from the env var when no explicit token is given", async () => {
    const provider = new LocalBearerTokenCredentialProvider({
      normalizedOrigin: ORIGIN,
      env: { [DEFAULT_META_PROXY_TOKEN_ENV_VAR]: "mh1.from-env" },
    });
    const cred = await provider.acquire({
      product: "meta-proxy",
      normalizedOrigin: ORIGIN,
      audience: ORIGIN,
      requiredScopes: [],
      operation: "chat.completions",
      interactiveAllowed: false,
    });
    expect(cred.secret.reveal()).toBe("mh1.from-env");
  });

  it("fails closed at construction when no token and no env var is present", () => {
    expect(
      () => new LocalBearerTokenCredentialProvider({ normalizedOrigin: ORIGIN, env: {} }),
    ).toThrow(/local proxy bearer is required/);
  });

  it("refuses an origin mismatch (ADR-0022 §D3)", async () => {
    const provider = new LocalBearerTokenCredentialProvider({
      token: "mh1.bound",
      normalizedOrigin: ORIGIN,
    });
    await expect(
      provider.acquire({
        product: "meta-proxy",
        normalizedOrigin: "http://127.0.0.1:9",
        audience: "http://127.0.0.1:9",
        requiredScopes: [],
        operation: "chat.completions",
        interactiveAllowed: false,
      }),
    ).rejects.toMatchObject({ kind: "authentication" });
  });

  it("does not reveal the token through inspection or stringification", () => {
    const provider = new LocalBearerTokenCredentialProvider({
      token: "mh1.super-secret",
      normalizedOrigin: ORIGIN,
    });
    expect(provider.identity()).not.toContain("super-secret");
    expect(JSON.stringify(provider)).not.toContain("super-secret");
  });
});
