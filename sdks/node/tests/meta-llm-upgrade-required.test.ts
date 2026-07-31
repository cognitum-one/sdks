import { describe, expect, it } from "vitest";

import { mapMetaLlmHttpError } from "../src/meta-llm/http-errors.js";

/**
 * Issue #128 / ADR-0023 §D1: a 402 is either "you spent your budget" or "you
 * never bought this tier", and the two send a user to different places.
 *
 * The payload below is not invented — it is the verbatim body returned by
 * https://api.cognitum.one on 2026-07-31 when a key holding `completions:low`
 * requested `cognitum-high`.
 */
const LIVE_TIER_SHORTFALL_BODY = JSON.stringify({
  error:
    "Model 'cognitum-high' requires the completions:high scope, which this API key does not hold.",
  code: "upgrade_required",
  requestId: "f892a402-f488-46b1-93d9-86ccdfcaf53b",
  required_tier: "high",
  held_tier: "low",
  required_scope: "completions:high",
  upgrade_url: "https://dashboard.cognitum.one/settings/billing",
});

function response(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

describe("402 upgrade_required (issue #128)", () => {
  it("maps a live tier shortfall to upgrade_required, not budget_exceeded", async () => {
    const error = await mapMetaLlmHttpError(response(402, LIVE_TIER_SHORTFALL_BODY), "chatCompletions", "req-1");

    expect(error.kind).toBe("upgrade_required");
    expect(error.status).toBe(402);
    expect(error.code).toBe("upgrade_required");
  });

  it("exposes the affordance instead of dropping it", async () => {
    const error = await mapMetaLlmHttpError(response(402, LIVE_TIER_SHORTFALL_BODY), "chatCompletions", "req-2");

    expect(error.upgrade).toEqual({
      requiredTier: "high",
      heldTier: "low",
      requiredScope: "completions:high",
      upgradeUrl: "https://dashboard.cognitum.one/settings/billing",
      retryWith: undefined,
    });
  });

  it("stays non-retryable — only a plan change fixes it", async () => {
    const error = await mapMetaLlmHttpError(response(402, LIVE_TIER_SHORTFALL_BODY), "chatCompletions", "req-3");
    expect(error.retryable).toBe(false);
  });

  it("surfaces retry_with when the server offers an in-scope retry", async () => {
    const body = JSON.stringify({
      code: "upgrade_required",
      required_tier: "mid",
      held_tier: "low",
      retry_with: { fallback_policy: "best_effort" },
    });
    const error = await mapMetaLlmHttpError(response(402, body), "chatCompletions", "req-4");

    expect(error.upgrade?.retryWith?.fallbackPolicy).toBe("best_effort");
    // Offering a retry is not performing one.
    expect(error.retryable).toBe(false);
  });

  it("drops unrecognised retry_with keys rather than carrying server JSON onto a logged error", async () => {
    // ADR-0028 §D10: credentials, cookies and pre-signed URLs are never
    // capturable, and nothing redacts this field. A key no SDK version
    // understands is a key no caller can act on, so preserving it buys
    // nothing and creates a leak path.
    const body = JSON.stringify({
      code: "upgrade_required",
      retry_with: { fallback_policy: "best_effort", authorization: "Bearer SECRET" },
    });
    const error = await mapMetaLlmHttpError(response(402, body), "chatCompletions", "req-5");

    expect(error.upgrade?.retryWith).toEqual({ fallbackPolicy: "best_effort" });
    expect(JSON.stringify(error.upgrade)).not.toContain("SECRET");
  });

  it("omits retry_with entirely when it carries no field we understand", async () => {
    const body = JSON.stringify({ code: "upgrade_required", retry_with: { future_key: null } });
    const error = await mapMetaLlmHttpError(response(402, body), "chatCompletions", "req-5b");

    // "No affordance" and "no usable affordance" must look identical.
    expect(error.upgrade).toBeUndefined();
  });

  it("leaves a budget 402 as budget_exceeded", async () => {
    // The regression that matters in the other direction: this change must not
    // reclassify spend exhaustion, which has no `upgrade_required` code.
    const body = JSON.stringify({ error: "budget exhausted", code: "budget_exceeded" });
    const error = await mapMetaLlmHttpError(response(402, body), "chatCompletions", "req-6");

    expect(error.kind).toBe("budget_exceeded");
    expect(error.code).toBe("budget_exceeded");
    expect(error.upgrade).toBeUndefined();
  });

  it("treats an unrecognised 402 code as budget_exceeded", async () => {
    // Forward compatibility: a code this version has never heard of must not
    // become `upgrade_required` by accident.
    const body = JSON.stringify({ code: "some_future_402_reason" });
    const error = await mapMetaLlmHttpError(response(402, body), "chatCompletions", "req-7");

    expect(error.kind).toBe("budget_exceeded");
  });

  it("does not throw when a 402 body is not JSON", async () => {
    // A WAF or proxy can answer 402 with HTML. An error mapper that throws
    // while mapping an error replaces a useful failure with a confusing one.
    const error = await mapMetaLlmHttpError(response(402, "<html>Payment Required</html>"), "chatCompletions", "req-8");

    expect(error.kind).toBe("budget_exceeded");
    expect(error.upgrade).toBeUndefined();
    expect(error.message).toContain("Payment Required");
  });

  it("does not throw on an empty 402 body", async () => {
    const error = await mapMetaLlmHttpError(response(402, ""), "chatCompletions", "req-9");
    expect(error.kind).toBe("budget_exceeded");
    expect(error.message).toBe("budget or upgrade required");
  });

  it("omits the affordance when the server sends a code but no fields", async () => {
    const error = await mapMetaLlmHttpError(
      response(402, JSON.stringify({ code: "upgrade_required" })),
      "chatCompletions",
      "req-10",
    );

    expect(error.kind).toBe("upgrade_required");
    // Absent, not an object of undefineds — a caller checks `if (e.upgrade)`.
    expect(error.upgrade).toBeUndefined();
  });

  it("ignores non-string affordance fields rather than surfacing junk", async () => {
    const body = JSON.stringify({ code: "upgrade_required", required_tier: 42, held_tier: "low" });
    const error = await mapMetaLlmHttpError(response(402, body), "chatCompletions", "req-11");

    expect(error.upgrade?.requiredTier).toBeUndefined();
    expect(error.upgrade?.heldTier).toBe("low");
  });

  it("does not disturb any other status", async () => {
    for (const [status, kind] of [
      [400, "validation"],
      [401, "authentication"],
      [403, "permission_denied"],
      [422, "safety_blocked"],
    ] as const) {
      const error = await mapMetaLlmHttpError(
        response(status, JSON.stringify({ code: "upgrade_required" })),
        "chatCompletions",
        "req-x",
      );
      expect(error.kind).toBe(kind);
    }
  });
});
