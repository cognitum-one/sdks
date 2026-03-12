import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Cognitum, AuthError, RateLimitError, CognitumError } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function createClient(overrides?: Record<string, unknown>): Cognitum {
  return new Cognitum({
    apiKey: "test-key-123",
    timeout: 5000,
    retries: 0,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Cognitum SDK", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Health check
  // -------------------------------------------------------------------------

  describe("health()", () => {
    it("should return health status on 200", async () => {
      const payload = { status: "ok", timestamp: "2026-03-12T00:00:00Z" };
      globalThis.fetch = mockFetch(200, payload);

      const cog = createClient();
      const result = await cog.health();

      expect(result).toEqual(payload);
    });
  });

  // -------------------------------------------------------------------------
  // Catalog browse
  // -------------------------------------------------------------------------

  describe("catalog.browse()", () => {
    it("should fetch products", async () => {
      const payload = { products: [{ id: "1", name: "Seed" }], total: 1 };
      globalThis.fetch = mockFetch(200, payload);

      const cog = createClient();
      const result = await cog.catalog.browse();

      expect(result).toEqual(payload);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const url = call[0] as string;
      expect(url).toContain("/listTemplates");
    });

    it("should pass category as query parameter", async () => {
      globalThis.fetch = mockFetch(200, { products: [], total: 0 });

      const cog = createClient();
      await cog.catalog.browse({ category: "agents" });

      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const url = call[0] as string;
      expect(url).toContain("category=agents");
    });
  });

  // -------------------------------------------------------------------------
  // API key header injection
  // -------------------------------------------------------------------------

  describe("API key header", () => {
    it("should inject X-API-Key header in every request", async () => {
      globalThis.fetch = mockFetch(200, { status: "ok" });

      const cog = createClient();
      await cog.health();

      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const init = call[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["X-API-Key"]).toBe("test-key-123");
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("should throw AuthError on 401", async () => {
      globalThis.fetch = mockFetch(401, { message: "Invalid API key" });

      const cog = createClient();
      await expect(cog.health()).rejects.toThrow(AuthError);
    });

    it("should throw AuthError on 403", async () => {
      globalThis.fetch = mockFetch(403, { message: "Forbidden" });

      const cog = createClient();
      await expect(cog.health()).rejects.toThrow(AuthError);
    });

    it("should throw RateLimitError on 429", async () => {
      globalThis.fetch = mockFetch(429, { message: "Too many requests" }, {
        "Retry-After": "2",
      });

      const cog = createClient();
      await expect(cog.health()).rejects.toThrow(RateLimitError);

      try {
        await cog.health();
      } catch (err) {
        expect((err as RateLimitError).retryAfterMs).toBe(2000);
      }
    });

    it("should throw CognitumError on 500", async () => {
      globalThis.fetch = mockFetch(500, { message: "Internal error" });

      const cog = createClient();
      await expect(cog.health()).rejects.toThrow(CognitumError);
    });
  });

  // -------------------------------------------------------------------------
  // Retry behavior
  // -------------------------------------------------------------------------

  describe("retry behavior", () => {
    it("should retry on 500 up to the configured retry count", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          headers: new Headers(),
          json: () => Promise.resolve({ message: "error" }),
          text: () => Promise.resolve('{"message":"error"}'),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          headers: new Headers(),
          json: () => Promise.resolve({ message: "error" }),
          text: () => Promise.resolve('{"message":"error"}'),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () => Promise.resolve({ status: "ok" }),
          text: () => Promise.resolve('{"status":"ok"}'),
        });

      globalThis.fetch = fetchMock;

      // Allow 2 retries (3 total attempts), use very short backoff
      const cog = new Cognitum({
        apiKey: "test-key-123",
        timeout: 5000,
        retries: 2,
      });

      const result = await cog.health();
      expect(result).toEqual({ status: "ok" });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("should not retry on 401", async () => {
      const fetchMock = mockFetch(401, { message: "Unauthorized" });
      globalThis.fetch = fetchMock;

      const cog = new Cognitum({
        apiKey: "test-key-123",
        retries: 3,
      });

      await expect(cog.health()).rejects.toThrow(AuthError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Constructor validation
  // -------------------------------------------------------------------------

  describe("constructor", () => {
    it("should throw AuthError if apiKey is empty", () => {
      expect(() => new Cognitum({ apiKey: "" })).toThrow(AuthError);
    });
  });
});
