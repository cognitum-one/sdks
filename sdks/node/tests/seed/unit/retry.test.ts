import { describe, it, expect, vi } from "vitest";
import {
  runWithRetry,
  classify,
  parseRetryAfterHeader,
  parseSeedRetryAfter,
  BASE_MS,
  CAP_MS,
} from "../../../src/seed/retry.js";
import {
  AuthError,
  CognitumError,
  ConflictError,
  NetworkError,
  NotFoundError,
  NotImplementedError,
  ParseError,
  RateLimitError,
  ServiceUnavailableError,
  TimeoutError,
  ValidationError,
} from "../../../src/errors.js";

describe("retry: classify", () => {
  const GET = { rateLimitRetry: true, method: "GET" as const, idempotent: true };
  const POST_NON_IDEM = { rateLimitRetry: true, method: "POST" as const, idempotent: false };
  const POST_IDEM = { rateLimitRetry: true, method: "POST" as const, idempotent: true };

  it("retries RateLimitError with hint", () => {
    const err = new RateLimitError(1234, "rl");
    const { retriable, hintMs } = classify(err, GET);
    expect(retriable).toBe(true);
    expect(hintMs).toBe(1234);
  });

  it("respects rateLimitRetry=false", () => {
    const err = new RateLimitError(500, "rl");
    expect(classify(err, { ...GET, rateLimitRetry: false }).retriable).toBe(false);
  });

  it("retries ServiceUnavailableError with hint", () => {
    const err = new ServiceUnavailableError(2000);
    const { retriable, hintMs } = classify(err, GET);
    expect(retriable).toBe(true);
    expect(hintMs).toBe(2000);
  });

  it("retries NetworkError on any method", () => {
    expect(classify(new NetworkError("econnreset"), POST_NON_IDEM).retriable).toBe(true);
  });

  it("retries connect-phase TimeoutError on POST", () => {
    expect(classify(new TimeoutError("connect"), POST_NON_IDEM).retriable).toBe(true);
  });

  it("does NOT retry read-phase TimeoutError on non-idempotent POST", () => {
    expect(classify(new TimeoutError("read"), POST_NON_IDEM).retriable).toBe(false);
  });

  it("retries read-phase TimeoutError on idempotent POST", () => {
    expect(classify(new TimeoutError("read"), POST_IDEM).retriable).toBe(true);
  });

  it("retries 500 but not 501 per ADR-0005", () => {
    const err500 = new CognitumError("boom", "SERVER_ERROR", 500);
    const err501 = new NotImplementedError("/foo");
    expect(classify(err500, GET).retriable).toBe(true);
    expect(classify(err501, GET).retriable).toBe(false);
  });

  it("never retries auth/validation/not-found/conflict/parse", () => {
    expect(classify(new AuthError("bad"), GET).retriable).toBe(false);
    expect(classify(new ValidationError("bad"), GET).retriable).toBe(false);
    expect(classify(new NotFoundError("bad"), GET).retriable).toBe(false);
    expect(classify(new ConflictError("bad"), GET).retriable).toBe(false);
    expect(classify(new ParseError("JSON"), GET).retriable).toBe(false);
  });
});

describe("retry: parseRetryAfterHeader", () => {
  it("parses integer seconds", () => {
    expect(parseRetryAfterHeader("5")).toBe(5000);
  });
  it("parses float seconds", () => {
    expect(parseRetryAfterHeader("1.5")).toBe(1500);
  });
  it("parses HTTP-date", () => {
    const future = new Date(Date.now() + 2000).toUTCString();
    const ms = parseRetryAfterHeader(future)!;
    expect(ms).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(3000);
  });
  it("returns undefined on null / garbage", () => {
    expect(parseRetryAfterHeader(null)).toBeUndefined();
    expect(parseRetryAfterHeader("not-a-date")).toBeUndefined();
  });
});

describe("retry: parseSeedRetryAfter", () => {
  it("parses retry_after_us (microseconds) → ms", () => {
    expect(parseSeedRetryAfter({ retry_after_us: 2_000_000 })).toBe(2000);
  });
  it("parses 'rate limited — retry after Ns' message", () => {
    expect(
      parseSeedRetryAfter({ error: "rate limited — retry after 7s" }),
    ).toBe(7000);
  });
  it("returns undefined on null / unexpected shape", () => {
    expect(parseSeedRetryAfter(null)).toBeUndefined();
    expect(parseSeedRetryAfter({})).toBeUndefined();
    expect(parseSeedRetryAfter({ error: "nope" })).toBeUndefined();
  });
});

describe("retry: runWithRetry", () => {
  it("returns on first success", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    const result = await runWithRetry(op, {
      retries: 3,
      maxElapsedMs: 60_000,
      rateLimitRetry: true,
      method: "GET",
      idempotent: true,
    }, "/api/v1/status");
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries a NetworkError up to the budget", async () => {
    let calls = 0;
    const op = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw new NetworkError("reset");
      return "ok";
    });
    const result = await runWithRetry(op, {
      retries: 3,
      // tight budget so the test doesn't sit on the real backoff clock
      maxElapsedMs: 60_000,
      rateLimitRetry: true,
      method: "GET",
      idempotent: true,
    }, "/api/v1/status");
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  }, 15_000);

  it("re-throws after exhausting the retry budget", async () => {
    const op = vi.fn().mockRejectedValue(new NetworkError("dead"));
    await expect(
      runWithRetry(op, {
        retries: 1,
        maxElapsedMs: 10_000,
        rateLimitRetry: true,
        method: "GET",
        idempotent: true,
      }, "/api/v1/status"),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(op).toHaveBeenCalledTimes(2); // first attempt + 1 retry
  }, 15_000);

  it("re-throws immediately on a non-retryable error", async () => {
    const op = vi.fn().mockRejectedValue(new AuthError("nope"));
    await expect(
      runWithRetry(op, {
        retries: 5,
        maxElapsedMs: 60_000,
        rateLimitRetry: true,
        method: "GET",
        idempotent: true,
      }, "/api/v1/identity"),
    ).rejects.toBeInstanceOf(AuthError);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("honours ADR-0005 constants (500ms base, 30s cap)", () => {
    expect(BASE_MS).toBe(500);
    expect(CAP_MS).toBe(30_000);
  });

  it("stops retrying once maxElapsedMs is reached", async () => {
    const started = Date.now();
    const op = vi.fn().mockRejectedValue(new NetworkError("econnrefused"));
    await expect(
      runWithRetry(op, {
        retries: 100,          // would try forever if time wasn't gating
        maxElapsedMs: 1500,
        rateLimitRetry: true,
        method: "GET",
        idempotent: true,
      }, "/api/v1/status"),
    ).rejects.toBeInstanceOf(NetworkError);
    const elapsed = Date.now() - started;
    // Should exit well before 100 retries' worth of exponential backoff.
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);
});
