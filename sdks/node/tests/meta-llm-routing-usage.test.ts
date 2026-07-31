import { describe, it, expect, vi } from "vitest";

import { MetaLlmClient } from "../src/meta-llm/client.js";
import { StaticApiKeyCredentialProvider } from "../src/agentic/static-api-key-provider.js";
import type { Credential, CredentialProvider, CredentialRequest } from "../src/agentic/credentials.js";
import { parseMetaLlmReceipt } from "../src/meta-llm/types/receipt.js";
import { parseUsageSummary } from "../src/meta-llm/types/usage.js";

/**
 * ADR-0024b D11 migration step 1 (issue #59): routing controls + receipt/
 * usage read-only support. Mirrors the style of `meta-llm-nonstream.test.ts`
 * (PR #86) and `meta-llm-client.test.ts` (PR #85).
 *
 * Explicitly out of scope (see the ADR and this issue's tracking notes):
 * batches, pods, bench, webhooks, guidance, collaboration, evolution,
 * MicroLoRA, flywheel, genome, brain, vectors, conditional hosts (§D5-§D8).
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

function chatCompletionBodyWithReceipt() {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "meta-llm-large",
    choices: [
      { index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    cognitum_receipt: {
      request_id: "req-abc",
      resolved_tier: "mid",
      resolved_model: "meta-llm-large-v2",
      escalated: false,
      cap_degraded: false,
      routing_reason: "auto_selected_mid",
      price: { amount: "0.0042", currency: "USD" },
      cache_result: "miss",
      fallback_used: false,
      breaker_counts: { "meta-llm-large": 0 },
      costs: [{ source: "provider", amount: 0.0042, currency: "USD", finality: "estimate" }],
      // Deliberately not in `KNOWN_RECEIPT_KEYS` — must survive under `raw`.
      a_future_governance_field: { some: "value" },
    },
  };
}

function chatRequest() {
  return { model: "meta-llm-large", messages: [{ role: "user" as const, content: "hello" }] };
}

/**
 * Credential provider that returns a fresh secret each `acquire()` call, so
 * the 401-refresh test can distinguish "first credential" from "refreshed
 * credential" — unlike `StaticApiKeyCredentialProvider`, whose
 * `invalidate()` makes every subsequent `acquire()` fail permanently.
 * Mirrors `meta-llm-nonstream.test.ts`'s `makeRefreshingCredentialProvider`.
 */
function makeRefreshingCredentialProvider(): CredentialProvider {
  let acquireCount = 0;
  return {
    describeAuthority: vi.fn(),
    identity: () => "refreshing-credential-provider",
    invalidate: vi.fn(async () => {}),
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
}

// ---------------------------------------------------------------------------
// Success: routing controls flow through the body, receipt decodes on
// success responses.
// ---------------------------------------------------------------------------

describe("ADR-0024b routing controls + receipt — success path", () => {
  it("sends routingControls in the chat.completions body and decodes the receipt", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, chatCompletionBodyWithReceipt()));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const request = {
      ...chatRequest(),
      routingControls: {
        model: { kind: "tier" as const, tier: "mid" as const },
        fallbackPolicy: "best_effort" as const,
        cache: "semantic" as const,
        safety: "warn" as const,
      },
    };

    const result = await client.chat.completions(request);

    expect(result.data.id).toBe("chatcmpl-1");
    const [, init] = fetchSpy.mock.calls[0];
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.routingControls).toEqual(request.routingControls);

    // Receipt decoded onto meta, not just left buried in `data`.
    expect(result.meta.receipt).toBeDefined();
    expect(result.meta.receipt?.requestId).toBe("req-abc");
    expect(result.meta.receipt?.resolvedTier).toBe("mid");
    expect(result.meta.receipt?.price).toEqual({ amount: "0.0042", currency: "USD" });
    expect(result.meta.receipt?.costs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Auth: usage() requires a credentialProvider (same gate as whoami/models).
// ---------------------------------------------------------------------------

describe("MetaLlmClient.usage() — auth", () => {
  it("throws authentication when no credentialProvider is configured", async () => {
    const fetchSpy = vi.fn();
    const client = new MetaLlmClient({ baseUrl: BASE_URL, transport: fetchSpy });

    await expect(client.usage({ from: "2026-01", to: "2026-06" })).rejects.toMatchObject({
      kind: "authentication",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("scopes the query to the authenticated account only (no cross-tenant parameter exists)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { totals: { requests: 3 } }));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    await client.usage({ from: "2026-01", to: "2026-06", model: "meta-llm-large", groupBy: "model" });

    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/v1/usage?");
    expect(String(url)).toContain("from=2026-01");
    expect(String(url)).toContain("to=2026-06");
    expect(String(url)).toContain("model=meta-llm-large");
    expect(String(url)).toContain("group_by=model");
  });
});

// ---------------------------------------------------------------------------
// Validation: unrecognized enum values are rejected before any network call;
// malformed usage() query ranges are rejected the same way.
// ---------------------------------------------------------------------------

describe("ADR-0024b §D2 — routing controls validation (never sent unrecognized)", () => {
  it("rejects an unrecognized ModelSelector.kind before any fetch call", async () => {
    const fetchSpy = vi.fn();
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const request = {
      ...chatRequest(),
      routingControls: { model: { kind: "raw_provider_model_id", modelId: "gpt-9000" } as never },
    };

    await expect(client.chat.completions(request)).rejects.toMatchObject({ kind: "validation" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an unrecognized FallbackPolicy before any fetch call", async () => {
    const fetchSpy = vi.fn();
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const request = { ...chatRequest(), routingControls: { fallbackPolicy: "retry_forever" as never } };

    await expect(client.chat.completions(request)).rejects.toMatchObject({ kind: "validation" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a malformed YYYY-MM usage() range before any fetch call", async () => {
    const fetchSpy = vi.fn();
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    await expect(client.usage({ from: "2026-1", to: "2026-06" })).rejects.toMatchObject({
      kind: "validation",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a usage() range where from is after to", async () => {
    const fetchSpy = vi.fn();
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    await expect(client.usage({ from: "2026-06", to: "2026-01" })).rejects.toMatchObject({
      kind: "validation",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Unknown-field preservation: response parsing never drops evidence it
// doesn't recognize yet (ADR-0024b §D2: "Unknown received values are
// preserved").
// ---------------------------------------------------------------------------

describe("unknown fields are preserved, never dropped", () => {
  it("parseMetaLlmReceipt preserves an unrecognized top-level field under raw", () => {
    const receipt = parseMetaLlmReceipt(chatCompletionBodyWithReceipt().cognitum_receipt);
    expect(receipt?.raw?.a_future_governance_field).toEqual({ some: "value" });
  });

  it("parseMetaLlmReceipt preserves an unrecognized resolvedTier value instead of dropping it", () => {
    const receipt = parseMetaLlmReceipt({ request_id: "req-x", resolved_tier: "ultra_future_tier" });
    expect(receipt?.resolvedTier).toBe("ultra_future_tier");
  });

  it("parseUsageSummary preserves an unrecognized top-level field under raw", () => {
    const summary = parseUsageSummary({
      totals: { requests: 5 },
      a_future_governance_field: { some: "value" },
    });
    expect(summary.raw?.a_future_governance_field).toEqual({ some: "value" });
  });

  it("parseUsageSummary returns an empty totals structure rather than fabricating usage for a malformed body", () => {
    const summary = parseUsageSummary({});
    expect(summary.totals).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Retry invariant (§D4, critical correctness rule): "The SDK never raises
// tier, enables escalation, changes cache, selects best effort, or changes
// payer during retry." — proves the routingControls set on the ORIGINAL
// request are sent byte-identical on every retry attempt.
// ---------------------------------------------------------------------------

describe("ADR-0024b §D4 retry invariant — routingControls never mutated across retries", () => {
  it("sends byte-identical routingControls on the retried attempt after a 502", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(502, { error: "bad gateway" }))
      .mockResolvedValueOnce(jsonResponse(200, chatCompletionBodyWithReceipt()));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const routingControls = {
      model: { kind: "tier" as const, tier: "high" as const },
      minTier: "mid" as const,
      maxTier: "high" as const,
      fallbackPolicy: "fail_fast" as const,
      escalation: "post_hoc" as const,
      cache: "exact" as const,
      safety: "block" as const,
      subTenantId: "attribution-only-token",
    };
    const request = { ...chatRequest(), routingControls };

    const result = await client.chat.completions(request);

    expect(result.data.id).toBe("chatcmpl-1");
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    const secondBody = JSON.parse(fetchSpy.mock.calls[1][1].body as string);

    // Byte-identical serialization, not just deep-equal, proves no
    // silent reordering/mutation crept in between attempts.
    expect(JSON.stringify(firstBody.routingControls)).toBe(JSON.stringify(secondBody.routingControls));
    expect(secondBody.routingControls).toEqual(routingControls);
    // The Idempotency-Key must also be stable — otherwise "retry" would
    // really be a second, unrelated logical call (ADR-0024a §D7).
    const key1 = (fetchSpy.mock.calls[0][1].headers as Record<string, string>)["Idempotency-Key"];
    const key2 = (fetchSpy.mock.calls[1][1].headers as Record<string, string>)["Idempotency-Key"];
    expect(key1).toBe(key2);
  });

  it("never widens tier/escalation/cache/fallback/payer on the retried attempt after a 401 refresh", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: "expired" }))
      .mockResolvedValueOnce(jsonResponse(200, chatCompletionBodyWithReceipt()));
    const client = new MetaLlmClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeRefreshingCredentialProvider(),
    });

    const routingControls = {
      minTier: "low" as const,
      fallbackPolicy: "fail_fast" as const,
      escalation: "buffered" as const,
      cache: "disabled" as const,
    };
    const request = { ...chatRequest(), routingControls };

    await client.chat.completions(request);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    const secondBody = JSON.parse(fetchSpy.mock.calls[1][1].body as string);
    expect(secondBody.routingControls).toEqual(firstBody.routingControls);
    expect(secondBody.routingControls).toEqual(routingControls);

    // The credential (payer) DID change across the 401 refresh (that part
    // is expected/required) — but routingControls stayed identical
    // regardless, proving the payer swap never leaked into a routing/cache/
    // escalation/tier mutation.
    const firstAuth = (fetchSpy.mock.calls[0][1].headers as Record<string, string>)["X-API-Key"];
    const secondAuth = (fetchSpy.mock.calls[1][1].headers as Record<string, string>)["X-API-Key"];
    expect(firstAuth).toBe("sk-v1");
    expect(secondAuth).toBe("sk-v2");
  });
});
