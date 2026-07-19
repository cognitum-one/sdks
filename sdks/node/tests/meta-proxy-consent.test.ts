import { describe, it, expect, vi } from "vitest";

import { ConsentRequiredError, type ConsentGrant } from "../src/agentic/index.js";
import { MetaProxyClient } from "../src/meta-proxy/client.js";
import { LocalBearerTokenCredentialProvider } from "../src/meta-proxy/auth.js";
import {
  CLOUD_ROUTING_CONSENT_KIND,
  assertConsentForRoutingIntent,
  hasValidConsentGrant,
  intentTouchesPlane,
  isConsentGrantValid,
} from "../src/meta-proxy/consent.js";
import type { RoutingIntent } from "../src/meta-proxy/routing.js";
import type { ChatCompletionRequest } from "../src/meta-llm/types/openai.js";

const ORIGIN = "http://127.0.0.1:11435";
const PRODUCT = "meta-proxy";

const REQUEST: ChatCompletionRequest = {
  model: "gpt-proxy",
  messages: [{ role: "user", content: "hello" }],
};

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `Status ${status}`,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

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
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finishReason: "stop" }],
    cognitum_routing_receipt: {
      request_id: "rr-1",
      configured_plane: "cognitum_cloud",
      selected_plane: selectedPlane,
      routing_reason: "explicit",
      automatic: false,
      workload_policy: "standard",
      degraded: false,
    },
  };
}

function cloudIntent(overrides: Partial<RoutingIntent> = {}): RoutingIntent {
  return {
    allowedPlanes: ["cognitum_cloud"],
    workloadPolicy: "standard",
    consentGrants: [],
    trainingShare: false,
    failIfUnavailable: true,
    ...overrides,
  };
}

function cloudFallbackGrant(overrides: Partial<ConsentGrant> = {}): ConsentGrant {
  return {
    kind: "cloud_fallback",
    product: PRODUCT,
    origin: ORIGIN,
    subject: "test-subject",
    scope: "chat.completions",
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    ...overrides,
  };
}

describe("assertConsentForRoutingIntent (unit, §D9)", () => {
  it("is a no-op when intent is undefined", () => {
    expect(() => assertConsentForRoutingIntent(undefined, [], ORIGIN, "chat.completions")).not.toThrow();
  });

  it("is a no-op when the intent never touches cognitum_cloud", () => {
    const intent = cloudIntent({ allowedPlanes: ["local"], requiredPlane: "local" });
    expect(() => assertConsentForRoutingIntent(intent, [], ORIGIN, "chat.completions")).not.toThrow();
  });

  it("throws ConsentRequiredError when allowedPlanes includes cognitum_cloud and no grant is present", () => {
    const intent = cloudIntent();
    expect(() => assertConsentForRoutingIntent(intent, [], ORIGIN, "chat.completions")).toThrow(
      ConsentRequiredError,
    );
  });

  it("throws ConsentRequiredError when requiredPlane is cognitum_cloud and no grant is present", () => {
    const intent = cloudIntent({ requiredPlane: "cognitum_cloud", allowedPlanes: [] });
    expect(() => assertConsentForRoutingIntent(intent, [], ORIGIN, "chat.completions")).toThrow(
      ConsentRequiredError,
    );
  });

  it("carries the machine-readable required kind (§D7)", () => {
    const intent = cloudIntent();
    try {
      assertConsentForRoutingIntent(intent, [], ORIGIN, "chat.completions");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConsentRequiredError);
      expect((err as ConsentRequiredError).requiredKind).toBe(CLOUD_ROUTING_CONSENT_KIND);
      expect((err as ConsentRequiredError).kind).toBe("consent_required");
    }
  });

  it("succeeds when a matching, unexpired cloud_fallback grant is present", () => {
    const intent = cloudIntent();
    expect(() =>
      assertConsentForRoutingIntent(intent, [cloudFallbackGrant()], ORIGIN, "chat.completions"),
    ).not.toThrow();
  });

  it("still throws when the only grant is for a different origin", () => {
    const intent = cloudIntent();
    const grant = cloudFallbackGrant({ origin: "http://127.0.0.1:9999" });
    expect(() => assertConsentForRoutingIntent(intent, [grant], ORIGIN, "chat.completions")).toThrow(
      ConsentRequiredError,
    );
  });

  it("still throws when the only grant is a different kind (e.g. sponsored_inference)", () => {
    const intent = cloudIntent();
    const grant = cloudFallbackGrant({ kind: "sponsored_inference" });
    expect(() => assertConsentForRoutingIntent(intent, [grant], ORIGIN, "chat.completions")).toThrow(
      ConsentRequiredError,
    );
  });

  it("still throws when the grant has expired", () => {
    const intent = cloudIntent();
    const grant = cloudFallbackGrant({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect(() => assertConsentForRoutingIntent(intent, [grant], ORIGIN, "chat.completions")).toThrow(
      ConsentRequiredError,
    );
  });

  it("succeeds for a grant with a future expiry", () => {
    const intent = cloudIntent();
    const grant = cloudFallbackGrant({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(() =>
      assertConsentForRoutingIntent(intent, [grant], ORIGIN, "chat.completions"),
    ).not.toThrow();
  });
});

describe("intentTouchesPlane / isConsentGrantValid / hasValidConsentGrant (unit)", () => {
  it("intentTouchesPlane matches allowedPlanes or requiredPlane", () => {
    expect(intentTouchesPlane(cloudIntent(), "cognitum_cloud")).toBe(true);
    expect(intentTouchesPlane(cloudIntent({ allowedPlanes: ["local"] }), "cognitum_cloud")).toBe(false);
    expect(
      intentTouchesPlane(cloudIntent({ allowedPlanes: [], requiredPlane: "cognitum_cloud" }), "cognitum_cloud"),
    ).toBe(true);
  });

  it("isConsentGrantValid rejects mismatched product/origin/kind and expired grants", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const grant = cloudFallbackGrant({ expiresAt: "2026-01-02T00:00:00Z" });
    expect(isConsentGrantValid(grant, "cloud_fallback", PRODUCT, ORIGIN, now)).toBe(true);
    expect(isConsentGrantValid(grant, "sponsored_inference", PRODUCT, ORIGIN, now)).toBe(false);
    expect(isConsentGrantValid(grant, "cloud_fallback", "other-product", ORIGIN, now)).toBe(false);
    expect(isConsentGrantValid(grant, "cloud_fallback", PRODUCT, "http://127.0.0.1:1", now)).toBe(false);
    expect(
      isConsentGrantValid(grant, "cloud_fallback", PRODUCT, ORIGIN, new Date("2026-01-03T00:00:00Z")),
    ).toBe(false);
  });

  it("hasValidConsentGrant finds one matching grant among several", () => {
    const grants = [
      cloudFallbackGrant({ kind: "sponsored_inference" }),
      cloudFallbackGrant({ origin: "http://127.0.0.1:1" }),
      cloudFallbackGrant(),
    ];
    expect(hasValidConsentGrant(grants, "cloud_fallback", PRODUCT, ORIGIN)).toBe(true);
    expect(hasValidConsentGrant(grants.slice(0, 2), "cloud_fallback", PRODUCT, ORIGIN)).toBe(false);
  });
});

describe("MetaProxyClient.chat.completions() — consent gate fails BEFORE any I/O (ADR-0025a §D9)", () => {
  it("rejects with ConsentRequiredError when a valid credential is present but no consent grant is configured", async () => {
    // A perfectly valid local bearer credential IS configured here — the
    // point of this test is that credential presence must NOT be treated as
    // consent (§D9: "Credential presence is not consent").
    const fetchSpy = queuedFetch([res(200, routingReceiptBody("cognitum_cloud"))]);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
      // consentGrants deliberately omitted.
    });

    const intent = cloudIntent();

    await expect(client.chat.completions(REQUEST, { routingIntent: intent })).rejects.toMatchObject({
      kind: "consent_required",
      requiredKind: CLOUD_ROUTING_CONSENT_KIND,
    });
    // The whole point of a fail-closed pre-I/O gate: the transport is NEVER invoked.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects even when requiredPlane (not just allowedPlanes) is cognitum_cloud", async () => {
    const fetchSpy = queuedFetch([res(200, routingReceiptBody("cognitum_cloud"))]);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    const intent = cloudIntent({ requiredPlane: "cognitum_cloud", allowedPlanes: [] });

    await expect(client.chat.completions(REQUEST, { routingIntent: intent })).rejects.toBeInstanceOf(
      ConsentRequiredError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("succeeds once a matching consentGrants entry is configured on the client", async () => {
    const fetchSpy = queuedFetch([res(200, routingReceiptBody("cognitum_cloud"))]);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
      consentGrants: [cloudFallbackGrant()],
    });

    const intent = cloudIntent();
    const result = await client.chat.completions(REQUEST, { routingIntent: intent });
    expect(result.data.id).toBe("chatcmpl-1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not require consent for a local-only intent (no regression)", async () => {
    const fetchSpy = queuedFetch([res(200, routingReceiptBody("local"))]);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    const intent = cloudIntent({ allowedPlanes: ["local"], requiredPlane: "local" });
    const result = await client.chat.completions(REQUEST, { routingIntent: intent });
    expect(result.data.id).toBe("chatcmpl-1");
  });

  it("does not require consent when no routingIntent is supplied at all", async () => {
    const fetchSpy = queuedFetch([res(200, routingReceiptBody("local"))]);
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    await expect(client.chat.completions(REQUEST)).resolves.toBeDefined();
  });
});

describe("MetaProxyClient.chat.completionsStream() — consent gate fails BEFORE any I/O (§D9)", () => {
  it("rejects on the first .next() with ConsentRequiredError, before the transport is invoked", async () => {
    const fetchSpy = vi.fn();
    const client = new MetaProxyClient({
      transport: fetchSpy,
      localCredentialProvider: localBearerProvider(),
    });

    const intent = cloudIntent();
    const stream = client.chat.completionsStream(REQUEST, { routingIntent: intent });

    await expect(stream.next()).rejects.toMatchObject({
      kind: "consent_required",
      requiredKind: CLOUD_ROUTING_CONSENT_KIND,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
