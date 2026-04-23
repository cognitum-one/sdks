import { describe, it, expect, vi } from "vitest";
import { SeedClient } from "../../../src/seed/index.js";
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

/**
 * Map a mocked HTTP status/body onto a typed error. Covers ADR-0004
 * end-to-end for the seed client's `mapHttpError()` switch.
 */

function mockFetchOnce(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response);
}

function client(fetchFn: typeof fetch, overrides?: Record<string, unknown>): SeedClient {
  return new SeedClient({
    endpoints: "https://seed.test:8443",
    auth: { pairingToken: "tok-test" },
    tls: { insecure: true },
    retries: 0,
    fetch: fetchFn,
    ...overrides,
  });
}

describe("SeedClient error mapping (ADR-0004)", () => {
  it("maps 400 → ValidationError", async () => {
    const c = client(mockFetchOnce(400, { error: "bad input" }) as unknown as typeof fetch);
    await expect(c.status()).rejects.toBeInstanceOf(ValidationError);
  });

  it("maps 401 → AuthError", async () => {
    const c = client(mockFetchOnce(401, { error: "no pairing token" }) as unknown as typeof fetch);
    await expect(c.status()).rejects.toBeInstanceOf(AuthError);
  });

  it("maps 403 → AuthError (not_paired / lockdown)", async () => {
    const c = client(mockFetchOnce(403, { error: "lockdown active" }) as unknown as typeof fetch);
    await expect(c.status()).rejects.toBeInstanceOf(AuthError);
  });

  it("maps 404 → NotFoundError", async () => {
    const c = client(mockFetchOnce(404, { error: "missing" }) as unknown as typeof fetch);
    await expect(c.status()).rejects.toBeInstanceOf(NotFoundError);
  });

  it("maps 409 → ConflictError", async () => {
    const c = client(mockFetchOnce(409, { error: "already paired" }) as unknown as typeof fetch);
    await expect(c.pair.create({ clientName: "laptop" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("maps 422 → ValidationError", async () => {
    const c = client(mockFetchOnce(422, { error: "dim mismatch" }) as unknown as typeof fetch);
    await expect(c.store.query({ vector: [1, 2, 3], k: 5 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("maps 429 Retry-After header → RateLimitError.retryAfterMs", async () => {
    const c = client(
      mockFetchOnce(429, { error: "rate limited" }, { "Retry-After": "3" }) as unknown as typeof fetch,
    );
    try {
      await c.status();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(3000);
    }
  });

  it("maps 429 JSON body retry_after_us → retryAfterMs (header absent)", async () => {
    const c = client(
      mockFetchOnce(429, {
        error: "rate limited — retry after 2s",
        retry_after_us: 2_000_000,
      }) as unknown as typeof fetch,
    );
    try {
      await c.store.query({ vector: [0, 0, 0, 0, 0, 0, 0, 0], k: 5 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(2000);
    }
  });

  it("maps 501 → NotImplementedError with endpoint", async () => {
    const c = client(mockFetchOnce(501, { error: "not implemented" }) as unknown as typeof fetch);
    try {
      await c.ota.config();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NotImplementedError);
      expect((err as NotImplementedError).endpoint).toBe("/api/v1/ota/config");
    }
  });

  it("maps 503 → ServiceUnavailableError", async () => {
    const c = client(mockFetchOnce(503, { error: "busy" }, { "Retry-After": "7" }) as unknown as typeof fetch);
    try {
      await c.status();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableError);
      expect((err as ServiceUnavailableError).retryAfterMs).toBe(7000);
    }
  });

  it("maps generic 5xx → ServiceUnavailableError", async () => {
    const c = client(mockFetchOnce(502, { error: "bad gateway" }) as unknown as typeof fetch);
    await expect(c.status()).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it("maps fetch-throw → NetworkError", async () => {
    const err = new TypeError("fetch failed: econnrefused");
    const f = vi.fn().mockRejectedValue(err);
    const c = client(f as unknown as typeof fetch);
    await expect(c.status()).rejects.toBeInstanceOf(NetworkError);
  });

  it("maps AbortError → TimeoutError(phase=read)", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const f = vi.fn().mockRejectedValue(abortErr);
    const c = client(f as unknown as typeof fetch);
    try {
      await c.status();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as TimeoutError).phase).toBe("read");
    }
  });

  it("maps malformed JSON in 2xx → ParseError", async () => {
    const f = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      text: () => Promise.resolve("<<< not json >>>"),
    } as unknown as Response);
    const c = client(f as unknown as typeof fetch);
    await expect(c.status()).rejects.toBeInstanceOf(ParseError);
  });

  it("forwards the X-Pairing-Token header", async () => {
    const f = mockFetchOnce(200, {
      device_id: "dev",
      uptime_secs: 0,
      epoch: 0,
      total_vectors: 0,
      deleted_vectors: 0,
      file_size_bytes: 0,
      dimension: 8,
      paired: true,
      roles: [],
    });
    const c = client(f as unknown as typeof fetch);
    await c.status();
    const init = f.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Pairing-Token"]).toBe("tok-test");
  });

  it("sends the correct store.query body shape {vector, k}", async () => {
    const f = mockFetchOnce(200, { results: [] });
    const c = client(f as unknown as typeof fetch);
    await c.store.query({ vector: [1, 2, 3, 4, 5, 6, 7, 8], k: 3 });
    const init = f.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ vector: [1, 2, 3, 4, 5, 6, 7, 8], k: 3 });
    expect(body.query).toBeUndefined(); // swarm bug: must NOT be "query"
  });

  it("rejects malformed pair.create args at the boundary", async () => {
    const f = mockFetchOnce(200, {});
    const c = client(f as unknown as typeof fetch);
    // @ts-expect-error runtime guard
    await expect(c.pair.create({})).rejects.toBeInstanceOf(TypeError);
  });

  it("exposes CognitumError as a superclass of all typed errors", () => {
    expect(new AuthError("x")).toBeInstanceOf(CognitumError);
    expect(new RateLimitError(1, "x")).toBeInstanceOf(CognitumError);
    expect(new NotImplementedError("/x")).toBeInstanceOf(CognitumError);
    expect(new ServiceUnavailableError()).toBeInstanceOf(CognitumError);
    expect(new NetworkError("x")).toBeInstanceOf(CognitumError);
    expect(new TimeoutError("total")).toBeInstanceOf(CognitumError);
    expect(new ParseError("JSON")).toBeInstanceOf(CognitumError);
    expect(new ConflictError("x")).toBeInstanceOf(CognitumError);
  });
});
