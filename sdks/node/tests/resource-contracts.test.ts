import { afterEach, expect, it, vi } from "vitest";
import { Cognitum } from "../src/index.js";
import { makeCustodyResource } from "../src/seed/resources/custody.js";
import { makeIdentityResource } from "../src/seed/resources/identity.js";
import { makeWitnessResource } from "../src/seed/resources/witness.js";
import { makePairResource } from "../src/seed/resources/pair.js";
import { parseUsageSummary } from "../src/meta-llm/types/usage.js";
afterEach(() => vi.unstubAllGlobals());
it("preserves authenticated product-resource wire contracts and encoded identifiers", async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));vi.stubGlobal("fetch", fetch);
  const cog = new Cognitum({ apiKey: "fixture-key", baseUrl: "https://fixture.invalid", retries: 0 });
  const share = { title: "fixture", content: "fixture", visibility: "private" as const };
  await cog.brain.share(share);await cog.brain.search("query");await cog.brain.search("query", { limit: 2, tags: ["private"] });await cog.brain.vote("memory", "down");
  await cog.devices.register({ deviceId: "a/b", publicKey: "public" });await cog.devices.checkUpdate("a/b+c");await cog.devices.heartbeat("a/b");
  await cog.contact.send({ name: "Fixture", email: "fixture@example.invalid", message: "fixture" });
  await cog.orders.create({ name: "Fixture", email: "fixture@example.invalid" });
  expect(fetch.mock.calls.every(([, init]) => init.headers["X-API-Key"] === "fixture-key")).toBe(true);
  expect(fetch.mock.calls.map(([url]) => url)).toContain("https://fixture.invalid/seedCheckUpdate?deviceId=a%2Fb%2Bc");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(share);
  expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ query: "query", limit: 2, tags: ["private"] });
  expect(JSON.parse(fetch.mock.calls[6][1].body)).toEqual({ device_id: "a/b" });
});
it("reads nested/flat docs content and refuses malformed payloads", async () => {
  const fetch = vi.fn();vi.stubGlobal("fetch", fetch);
  const cog = new Cognitum({ apiKey: "fixture", retries: 0 });
  for (const [wire, expected] of [
    [{ result: { content: [{ type: "text", text: '[{"title":"Doc"}]' }] } }, [{ title: "Doc" }]],
    [{ content: [{ type: "image" }, { type: "text", text: "broken" }] }, []],
    [{ content: "invalid" }, []], [{ content: [] }, []], [{}, []],
  ]) {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(wire), { status: 200 }));expect(await cog.mcp.searchDocs("question")).toEqual(expected);
  }
});
it("keeps seed read defaults and pairing revocation encoded and idempotent", async () => {
  const request = vi.fn().mockResolvedValue({});
  await makeCustodyResource(request).epoch();await makeIdentityResource(request).get({ timeout: 120 });await makeWitnessResource(request).chain();
  const pair = makePairResource(request);await pair.status();await pair.delete("alice/bob");
  expect(request).toHaveBeenCalledWith("GET", "/api/v1/custody/epoch", { idempotent: true });
  expect(request).toHaveBeenCalledWith("GET", "/api/v1/identity", { idempotent: true, timeout: 120 });
  expect(request).toHaveBeenCalledWith("GET", "/api/v1/witness/chain", { idempotent: true });
  expect(request).toHaveBeenCalledWith("DELETE", "/api/v1/pair/alice%2Fbob", { idempotent: true });
  await expect(pair.delete(" ")).rejects.toThrow("clientName");
});
it("decodes usage aliases, preserves unknown evidence, and excludes malformed period entries", () => {
  const money = { amount: 3, currency_code: "USD" };
  const result = parseUsageSummary({
    totals: { requests: 2, promptTokens: 3, completionTokens: 4, totalTokens: 7, cost: money, future: true },
    tierMix: { basic: 1 }, escalationRate: 0.1, fallbackRate: 0.2, emptyBilledRate: 0.3,
    cache: { hitRate: 0.5, savings: money, future: 1 },
    byModel: { model: { requests: 2, cost: money, future: true }, invalid: null },
    byProvider: { provider: { requests: 2 } },
    byPeriod: [null, { period: 2 }, { period: "2026-10", requests: 2, cost: money }],
    budget: { serving: money, hardLimit: money, committed: money, reserved: money, headroom: money, status: "reported", resetsAt: "date", future: true },
    future: "retained",
  });
  expect(result.totals).toMatchObject({ requests: 2, promptTokens: 3, completionTokens: 4, totalTokens: 7, cost: { amount: "3", currency: "USD" }, raw: { future: true } });
  expect(result.cache).toMatchObject({ hitRate: 0.5, savings: { amount: "3", currency: "USD" }, raw: { future: 1 } });
  expect(result.byModel?.invalid).toEqual({});expect(result.byPeriod).toHaveLength(1);expect(result.byPeriod?.[0].period).toBe("2026-10");
  expect(result.budget).toMatchObject({ status: "reported", resetsAt: "date", hardLimit: { amount: "3", currency: "USD" }, raw: { future: true } });expect(result.raw).toEqual({ future: "retained" });
});
it.each([null, [], "invalid", 3])("does not fabricate usage from malformed evidence %j", raw => {
  expect(parseUsageSummary(raw)).toEqual({ totals: {} });
});
it("ignores malformed optional usage fields and accepts snake-case wire aliases", () => {
  const empty = parseUsageSummary({ totals: [], cache: [], budget: [], by_model: [], by_period: {}, tier_mix: [], escalation_rate: "wrong", fallback_rate: "wrong", empty_billed_rate: "wrong" });
  expect(empty.totals).toEqual({});expect(empty.cache).toBeUndefined();expect(empty.budget).toBeUndefined();expect(empty.byPeriod).toBeUndefined();expect(empty.tierMix).toBeUndefined();
  const wire = parseUsageSummary({ totals: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }, cache: { hit_rate: 0.2 }, budget: { hard_limit: { amount: "2", currency: "EUR" }, resets_at: "date" }, by_period: [{ period: "2026-10" }] });
  expect(wire.totals).toMatchObject({ promptTokens: 2, completionTokens: 1, totalTokens: 3 });expect(wire.cache?.hitRate).toBe(0.2);expect(wire.budget?.hardLimit).toEqual({ amount: "2", currency: "EUR" });
});
