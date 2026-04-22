/**
 * Cloud `HttpClient` regression tests for the Phase 1.5 fixes:
 *   #5 — equal-jitter backoff (500 ms base / 30 s cap / 60 s budget)
 *   #6 — 429 body parsing (retry_after_us + "retry after Ns")
 *   #7 — COGNITUM_API_KEY env fallback in the constructor
 *
 * ADR: sdks/node/docs/adr/0015b-node-sdk-implementation.md §§6-7.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  Cognitum,
  AuthError,
  RateLimitError,
  CognitumError,
} from "../src/index.js";
import {
  equalJitterBackoff,
  parseRetryAfterBody,
  resolveRetryAfter,
} from "../src/client.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockResp {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  ok?: boolean;
}

function makeResponse(r: MockResp): Response {
  const bodyText =
    typeof r.body === "string"
      ? r.body
      : r.body === undefined
        ? ""
        : JSON.stringify(r.body);
  return {
    ok: r.ok ?? (r.status >= 200 && r.status < 300),
    status: r.status,
    statusText: `Status ${r.status}`,
    headers: new Headers(r.headers ?? {}),
    json: () => Promise.resolve(r.body),
    text: () => Promise.resolve(bodyText),
  } as unknown as Response;
}

function queueFetch(responses: MockResp[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(makeResponse(r));
  return fn;
}

// ---------------------------------------------------------------------------
// #5 — retry constants / jitter / budget
// ---------------------------------------------------------------------------

describe("#5 retry constants (ADR-0005)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("equal-jitter delay is non-zero and bounded to cap", () => {
    const samples = Array.from({ length: 40 }, (_, i) =>
      equalJitterBackoff(i),
    );
    for (const s of samples) {
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(30_000);
    }
    const distinct = new Set(samples.map((s) => Math.round(s))).size;
    expect(distinct).toBeGreaterThan(1); // proves jitter is actually random
  });

  it("cap is 30 s — even attempt=20 stays at or under cap", () => {
    for (let i = 0; i < 20; i++) {
      const d = equalJitterBackoff(i);
      expect(d).toBeLessThanOrEqual(30_000);
    }
  });

  it("base is 500 ms — attempt=0 samples fall in [500, 1000] ms", () => {
    const samples = Array.from({ length: 20 }, () => equalJitterBackoff(0));
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    expect(min).toBeGreaterThanOrEqual(500);
    expect(max).toBeLessThanOrEqual(1000);
  });

  it("maxElapsedMs breaks the retry loop early even if retries remain", async () => {
    // 10 failing 500s available, but a 50 ms budget means the loop must
    // bail after the first attempt even though retries=9.
    const fetchMock = queueFetch(
      Array.from({ length: 10 }, () => ({
        status: 500,
        body: { message: "boom" },
      })),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const cog = new Cognitum({
      apiKey: "k",
      retries: 9,
      maxElapsedMs: 50,
    });

    await expect(cog.health()).rejects.toThrow(CognitumError);
    // First attempt + at most one retry before budget trips.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// #5 — POST idempotency guard
// ---------------------------------------------------------------------------

describe("#5 POST idempotency guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POST does NOT retry on a read/total timeout (non-idempotent by default)", async () => {
    const fetchMock = vi.fn().mockImplementation(() => {
      return Promise.reject(
        new DOMException("aborted", "AbortError"),
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const cog = new Cognitum({
      apiKey: "k",
      retries: 5,
      timeout: 5,
    });

    await expect(
      cog.orders.create({ email: "a@b.com", name: "t" }),
    ).rejects.toThrow(/timed out/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("POST with idempotent:true retries on a read timeout", async () => {
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls < 3) {
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }
      return Promise.resolve(makeResponse({ status: 204 }));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const cog = new Cognitum({
      apiKey: "k",
      retries: 3,
      timeout: 5,
      maxElapsedMs: 60_000,
    });

    // Use the HttpClient directly to pass `idempotent: true`.
    await (
      cog as unknown as {
        client: {
          request: (
            m: string,
            p: string,
            b?: unknown,
            o?: { idempotent?: boolean },
          ) => Promise<void>;
        };
      }
    ).client.request("POST", "/echo", { hello: "world" }, {
      idempotent: true,
    });

    expect(calls).toBe(3);
  });

  it("GET retries on a transient 500 (default idempotent=true)", async () => {
    const fetchMock = queueFetch([
      { status: 500, body: { message: "boom" } },
      { status: 200, body: { status: "ok", timestamp: "x" } },
    ]);
    globalThis.fetch = fetchMock as typeof fetch;

    const cog = new Cognitum({
      apiKey: "k",
      retries: 2,
      maxElapsedMs: 60_000,
    });

    const r = await cog.health();
    expect(r).toEqual({ status: "ok", timestamp: "x" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("POST does NOT retry on 500 without idempotent:true", async () => {
    const fetchMock = queueFetch([
      { status: 500, body: { message: "boom" } },
      { status: 500, body: { message: "boom" } },
    ]);
    globalThis.fetch = fetchMock as typeof fetch;

    const cog = new Cognitum({ apiKey: "k", retries: 3 });

    // leads.subscribe is a POST with no idempotent flag.
    await expect(
      cog.leads.subscribe({ email: "a@b.com" }),
    ).rejects.toThrow(CognitumError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("POST with idempotent:true retries on 500", async () => {
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls < 3) {
        return Promise.resolve(
          makeResponse({ status: 500, body: { message: "boom" } }),
        );
      }
      return Promise.resolve(makeResponse({ status: 204 }));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const cog = new Cognitum({ apiKey: "k", retries: 3, maxElapsedMs: 60_000 });
    await (
      cog as unknown as {
        client: {
          request: (
            m: string,
            p: string,
            b?: unknown,
            o?: { idempotent?: boolean },
          ) => Promise<void>;
        };
      }
    ).client.request("POST", "/keyed-upsert", { id: "x" }, {
      idempotent: true,
    });
    expect(calls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// #6 — 429 body parsing
// ---------------------------------------------------------------------------

describe("#6 429 body parsing (ADR-0005 §429 handling)", () => {
  it("parses retry_after_us from JSON body → milliseconds", () => {
    expect(parseRetryAfterBody('{"retry_after_us":2500000}')).toBe(2500);
    expect(parseRetryAfterBody('{"retry_after_us":0}')).toBe(0);
  });

  it('parses `"rate limited — retry after 3s"` → 3000 ms', () => {
    expect(
      parseRetryAfterBody('{"error":"rate limited — retry after 3s"}'),
    ).toBe(3000);
  });

  it("falls back to plain-text scan when the body isn't JSON", () => {
    expect(parseRetryAfterBody("retry after 7s please")).toBe(7000);
  });

  it("returns undefined when nothing matches", () => {
    expect(parseRetryAfterBody("totally unrelated text")).toBeUndefined();
    expect(parseRetryAfterBody("")).toBeUndefined();
  });

  it("resolveRetryAfter prefers body over Retry-After header", () => {
    const res = makeResponse({
      status: 429,
      headers: { "Retry-After": "99" },
    });
    const got = resolveRetryAfter(res, '{"retry_after_us":2500000}');
    expect(got).toBe(2500);
  });

  it("resolveRetryAfter falls through to Retry-After header when body is silent", () => {
    const res = makeResponse({
      status: 429,
      headers: { "Retry-After": "4" },
    });
    const got = resolveRetryAfter(res, '{"error":"nope"}');
    expect(got).toBe(4000);
  });

  it("RateLimitError surfaces the body-parsed retry_after_us on an actual 429", async () => {
    globalThis.fetch = queueFetch([
      {
        status: 429,
        body: { retry_after_us: 2_500_000, error: "rate limited" },
      },
    ]) as unknown as typeof fetch;

    const cog = new Cognitum({
      apiKey: "k",
      retries: 0,
      rateLimitRetry: false,
    });

    try {
      await cog.health();
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitError);
      expect((e as RateLimitError).retryAfterMs).toBe(2500);
    }
  });

  it("RateLimitError surfaces the regex-parsed seconds on a text-only 429", async () => {
    globalThis.fetch = queueFetch([
      {
        status: 429,
        body: { error: "rate limited — retry after 3s" },
      },
    ]) as unknown as typeof fetch;

    const cog = new Cognitum({
      apiKey: "k",
      retries: 0,
      rateLimitRetry: false,
    });

    try {
      await cog.health();
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitError);
      expect((e as RateLimitError).retryAfterMs).toBe(3000);
    }
  });
});

// ---------------------------------------------------------------------------
// #7 — COGNITUM_API_KEY env fallback
// ---------------------------------------------------------------------------

describe("#7 COGNITUM_API_KEY env fallback (ADR-0015b §7)", () => {
  const saved = process.env.COGNITUM_API_KEY;

  afterEach(() => {
    if (saved === undefined) delete process.env.COGNITUM_API_KEY;
    else process.env.COGNITUM_API_KEY = saved;
  });

  it("throws AuthError when neither arg nor env provides a key", () => {
    delete process.env.COGNITUM_API_KEY;
    expect(() => new Cognitum({} as { apiKey?: string } as never)).toThrow(
      AuthError,
    );
    try {
      new Cognitum({} as { apiKey?: string } as never);
    } catch (e) {
      expect((e as AuthError).message).toMatch(/COGNITUM_API_KEY/);
      expect((e as AuthError).message).toMatch(/apiKey/);
    }
  });

  it("falls back to process.env.COGNITUM_API_KEY when arg is omitted", async () => {
    process.env.COGNITUM_API_KEY = "env-key-abc";
    const cog = new Cognitum({} as { apiKey?: string } as never);
    globalThis.fetch = queueFetch([
      { status: 200, body: { status: "ok", timestamp: "x" } },
    ]) as unknown as typeof fetch;

    await cog.health();

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("env-key-abc");
  });

  it("explicit arg wins over env", async () => {
    process.env.COGNITUM_API_KEY = "env-key";
    const cog = new Cognitum({ apiKey: "arg-key" });
    globalThis.fetch = queueFetch([
      { status: 200, body: { status: "ok", timestamp: "x" } },
    ]) as unknown as typeof fetch;

    await cog.health();

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("arg-key");
  });
});
