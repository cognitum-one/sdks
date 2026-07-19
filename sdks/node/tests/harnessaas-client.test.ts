import { describe, it, expect, vi, afterEach } from "vitest";

import { HarnessaaSClient } from "../src/harnessaas/client.js";
import { __resetHarnessaaSInsecureHttpWarnLatch } from "../src/harnessaas/config.js";
import { toSolveRequestWire } from "../src/harnessaas/types.js";
import { StaticApiKeyCredentialProvider } from "../src/agentic/static-api-key-provider.js";
import { UnsupportedCapabilityError } from "../src/agentic/errors.js";
import type { Credential, CredentialProvider, CredentialRequest } from "../src/agentic/credentials.js";

/**
 * Tests for `HarnessaaSClient` construction and the real `health()`/
 * `solve()`/`lineage()` implementations (issue #67/#68 / M5 start).
 *
 * Scope note: this pass covers ONLY the real, deployed, synchronous
 * upstream surface — no job/poll/SSE/approval/cancel method exists on this
 * client (ADR-0027a's async "Decision" section is a proposal, not a
 * description of the running service — see `../src/harnessaas/client.ts`'s
 * module doc comment).
 */

const BASE_URL = "https://harnessaas.test.cognitum.one";

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
    apiKey: "cog_test_canary_1234",
    product: "harnessaas",
    normalizedOrigin: BASE_URL,
    audience: BASE_URL,
  });
}

/** Spy `CredentialProvider` so tests can assert `acquire()` call counts. */
function makeSpyCredentialProvider(): { provider: CredentialProvider; acquire: ReturnType<typeof vi.fn> } {
  const acquire = vi.fn().mockResolvedValue({
    scheme: "X-API-Key",
    secret: { reveal: () => "cog_spy_canary" },
    audience: BASE_URL,
    source: "spy",
    authority: {
      providerFingerprint: "spy",
      product: "harnessaas",
      normalizedOrigin: BASE_URL,
      audience: BASE_URL,
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

/** Refreshing provider so 401-refresh tests can distinguish "first" from "refreshed" secret. */
function makeRefreshingCredentialProvider(): {
  provider: CredentialProvider;
  acquireCalls: () => number;
  invalidateCalls: () => number;
} {
  let acquireCount = 0;
  let invalidateCount = 0;
  const provider: CredentialProvider = {
    describeAuthority: vi.fn(),
    identity: () => "refreshing-credential-provider",
    invalidate: vi.fn(async () => {
      invalidateCount += 1;
    }),
    acquire: vi.fn(async (_request: CredentialRequest): Promise<Credential> => {
      const secret = acquireCount === 0 ? "cog_v1" : "cog_v2";
      acquireCount += 1;
      return {
        scheme: "X-API-Key",
        secret: { reveal: () => secret } as Credential["secret"],
        audience: BASE_URL,
        source: "refreshing",
        authority: {
          providerFingerprint: "refreshing",
          product: "harnessaas",
          normalizedOrigin: BASE_URL,
          audience: BASE_URL,
        },
      };
    }),
  };
  return { provider, acquireCalls: () => acquireCount, invalidateCalls: () => invalidateCount };
}

const SOLVE_REQUEST = { repo: "https://github.com/acme/widget.git", testCommand: "pytest -k test_widget", issue: "Widget renders twice" };

const SOLVE_RESPONSE_BODY = {
  request_id: "req_abc123",
  patch: "diff --git a/widget.py b/widget.py\n...",
  resolved: true,
  cost_receipt: {
    request_id: "req_abc123",
    model: "deepseek/deepseek-chat",
    mode: "empty-patch-cascade",
    tokens_in: 220,
    tokens_out: 90,
    cost_usd: 0.005,
    route: "base",
    escalated: false,
  },
  lineage_ref: "lineageOf:req_abc123",
  conformance: {
    usedOracleDuringSolve: false,
    statement: "solver saw only the customer test_command output",
    visibleInputsDigest: "sha256:deadbeef",
  },
};

describe("HarnessaaSClient construction", () => {
  afterEach(() => {
    __resetHarnessaaSInsecureHttpWarnLatch();
  });

  it("performs no I/O and requires an explicit HTTPS base URL", () => {
    const fetchSpy = vi.fn();
    const client = new HarnessaaSClient({ baseUrl: BASE_URL, transport: fetchSpy });
    expect(client).toBeInstanceOf(HarnessaaSClient);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-HTTPS base URL by default", () => {
    expect(() => new HarnessaaSClient({ baseUrl: "http://127.0.0.1:9999" })).toThrow(TypeError);
  });

  it("allows a non-HTTPS base URL when allowInsecureHttp is set", () => {
    const client = new HarnessaaSClient({ baseUrl: "http://127.0.0.1:9999", allowInsecureHttp: true });
    expect(client).toBeInstanceOf(HarnessaaSClient);
  });

  it("throws for a missing base URL", () => {
    expect(() => new HarnessaaSClient({ baseUrl: "" })).toThrow(TypeError);
  });

  it("rejects allowInsecureHttp against a non-loopback host (ADR-0022 §D3)", () => {
    expect(
      () => new HarnessaaSClient({ baseUrl: "http://example.com:9999", allowInsecureHttp: true }),
    ).toThrow(TypeError);
  });
});

describe("HarnessaaSClient.capabilities()", () => {
  it("returns the known-tested default (solve/lineage supported, only code-repair vertical) with no I/O", () => {
    const fetchSpy = vi.fn();
    const client = new HarnessaaSClient({ baseUrl: BASE_URL, transport: fetchSpy });
    const caps = client.capabilities();
    expect(caps.features).toEqual({
      solve: true,
      lineage: true,
      "solve.vertical.code-repair": true,
      "solve.vertical.security-remediation": false,
      "solve.vertical.dependency-migration": false,
      "solve.vertical.test-generation": false,
    });
    expect(caps.source).toBe("static-compatibility-table");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an operator-supplied capabilitiesSnapshot for an unrecognized version overrides the default (unknown -> unsupported)", () => {
    const fetchSpy = vi.fn();
    const client = new HarnessaaSClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      capabilitiesSnapshot: {
        product: "harnessaas",
        productVersion: "9.9.9-unknown",
        protocol: "cognitum.harnessaas.http",
        protocolVersion: "1.0",
        features: {},
        limitations: ["unrecognized server version — minimum-safe set"],
        authMethods: [],
        source: "static-compatibility-table",
      },
    });
    expect(client.capabilities().features).toEqual({});
  });
});

describe("HarnessaaSClient.health()", () => {
  it("calls GET /health (not /healthz) and returns health data without a credential provider", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, { status: "ok", mode: "mock", backend: "mock", tenancy: "per-account" }),
    );
    const client = new HarnessaaSClient({ baseUrl: BASE_URL, transport: fetchSpy });

    const result = await client.health();

    expect(result.data.status).toBe("ok");
    expect(result.data.mode).toBe("mock");
    expect(result.meta.httpStatus).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/health`);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBeUndefined();
  });

  it("never acquires a credential even when a provider is configured", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { status: "ok" }));
    const { provider, acquire } = makeSpyCredentialProvider();
    const client = new HarnessaaSClient({ baseUrl: BASE_URL, transport: fetchSpy, credentialProvider: provider });

    await client.health();

    expect(acquire).not.toHaveBeenCalled();
  });

  it("maps a 500 to a non-retryable protocol AgenticError", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(500, { error: "internal" }));
    const client = new HarnessaaSClient({ baseUrl: BASE_URL, transport: fetchSpy });

    await expect(client.health()).rejects.toMatchObject({ kind: "protocol", retryable: false, status: 500 });
  });
});

describe("HarnessaaSClient.solve() — capability fail-closed (ADR-0019 §D6, issue #74)", () => {
  it("fails closed with UnsupportedCapabilityError for an unsupported vertical, before any HTTP call", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("no HTTP call is expected — the capability gate must fire first");
    });
    const client = new HarnessaaSClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    await expect(
      client.solve({ ...SOLVE_REQUEST, vertical: "security-remediation" }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed for every non-code-repair vertical this SDK pass does not model", async () => {
    for (const vertical of ["security-remediation", "dependency-migration", "test-generation"] as const) {
      const fetchSpy = vi.fn();
      const client = new HarnessaaSClient({
        baseUrl: BASE_URL,
        transport: fetchSpy,
        credentialProvider: makeCredentialProvider(),
      });
      await expect(client.solve({ ...SOLVE_REQUEST, vertical })).rejects.toBeInstanceOf(
        UnsupportedCapabilityError,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it("fails closed when an operator-supplied capabilitiesSnapshot for an unrecognized version doesn't mark solve supported", async () => {
    const fetchSpy = vi.fn();
    const client = new HarnessaaSClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
      capabilitiesSnapshot: {
        product: "harnessaas",
        productVersion: "9.9.9-unknown",
        protocol: "cognitum.harnessaas.http",
        protocolVersion: "1.0",
        features: {},
        limitations: ["unrecognized server version — minimum-safe set"],
        authMethods: [],
        source: "static-compatibility-table",
      },
    });

    await expect(client.solve(SOLVE_REQUEST)).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows the default code-repair vertical (implicit and explicit) through to HTTP", async () => {
    for (const request of [SOLVE_REQUEST, { ...SOLVE_REQUEST, vertical: "code-repair" as const }]) {
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, SOLVE_RESPONSE_BODY));
      const client = new HarnessaaSClient({
        baseUrl: BASE_URL,
        transport: fetchSpy,
        credentialProvider: makeCredentialProvider(),
      });
      await client.solve(request);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    }
  });
});

describe("HarnessaaSClient.solve() — success", () => {
  it("sends X-API-Key and the snake_case wire body, and parses the response", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, SOLVE_RESPONSE_BODY));
    const client = new HarnessaaSClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const result = await client.solve(SOLVE_REQUEST);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/solve`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("cog_test_canary_1234");
    expect(JSON.parse(init.body as string)).toEqual({
      repo: SOLVE_REQUEST.repo,
      test_command: SOLVE_REQUEST.testCommand,
      issue: SOLVE_REQUEST.issue,
    });

    expect(result.data.requestId).toBe("req_abc123");
    expect(result.data.resolved).toBe(true);
    expect(result.data.costReceipt.model).toBe("deepseek/deepseek-chat");
    expect(result.data.costReceipt.tokensIn).toBe(220);
    expect(result.data.conformance.usedOracleDuringSolve).toBe(false);
    expect(result.data.lineageRef).toBe("lineageOf:req_abc123");
  });

  it("fails closed without a credentialProvider, before any HTTP I/O", async () => {
    const fetchSpy = vi.fn();
    const client = new HarnessaaSClient({ baseUrl: BASE_URL, transport: fetchSpy });

    await expect(client.solve(SOLVE_REQUEST)).rejects.toMatchObject({ kind: "authentication" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serializes w and vertical when provided", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, SOLVE_RESPONSE_BODY));
    const client = new HarnessaaSClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    await client.solve({ ...SOLVE_REQUEST, w: 0.8, vertical: "code-repair" });

    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(init.body as string)).toMatchObject({ w: 0.8, vertical: "code-repair" });
  });
});

describe("HarnessaaSClient.solve() — error mapping and retry safety", () => {
  it("maps 401 to a non-retryable authentication error and refreshes exactly once before retrying", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: "Invalid API key.", code: "invalid_api_key" }))
      .mockResolvedValueOnce(jsonResponse(200, SOLVE_RESPONSE_BODY));
    const { provider, acquireCalls, invalidateCalls } = makeRefreshingCredentialProvider();
    const client = new HarnessaaSClient({ baseUrl: BASE_URL, transport: fetchSpy, credentialProvider: provider });

    const result = await client.solve(SOLVE_REQUEST);

    expect(result.data.requestId).toBe("req_abc123");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(acquireCalls()).toBe(2);
    expect(invalidateCalls()).toBe(1);
    const firstKey = (fetchSpy.mock.calls[0][1].headers as Record<string, string>)["X-API-Key"];
    const secondKey = (fetchSpy.mock.calls[1][1].headers as Record<string, string>)["X-API-Key"];
    expect(firstKey).toBe("cog_v1");
    expect(secondKey).toBe("cog_v2");
  });

  it("maps 403 insufficient_scope to a non-retryable permission_denied error", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(403, { error: "insufficient scope", code: "insufficient_scope" }),
    );
    const client = new HarnessaaSClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    await expect(client.solve(SOLVE_REQUEST)).rejects.toMatchObject({
      kind: "permission_denied",
      retryable: false,
      status: 403,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("maps 422 to a non-retryable safety_blocked error (PII/safety pre-flight)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(422, { error: "request blocked by PII/safety pre-flight", code: "safety_blocked" }),
    );
    const client = new HarnessaaSClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    await expect(client.solve(SOLVE_REQUEST)).rejects.toMatchObject({
      kind: "safety_blocked",
      retryable: false,
      status: 422,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT auto-retry a 429 — single attempt only (no idempotency-key contract exists server-side)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(429, { error: "rate limited" }, { "retry-after": "2" }),
    );
    const client = new HarnessaaSClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    await expect(client.solve(SOLVE_REQUEST)).rejects.toMatchObject({
      kind: "rate_limited",
      retryable: true,
      retryAfterMs: 2000,
    });
    // The critical assertion: exactly ONE HTTP attempt, proving solve()
    // never auto-retries even though the error is classified retryable.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT auto-retry a 503 — single attempt only", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(503, { error: "upstream unavailable" }));
    const client = new HarnessaaSClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    await expect(client.solve(SOLVE_REQUEST)).rejects.toMatchObject({ kind: "transport", retryable: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT auto-retry a transport-level failure (e.g. dropped connection)", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const client = new HarnessaaSClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    await expect(client.solve(SOLVE_REQUEST)).rejects.toMatchObject({ kind: "transport" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("HarnessaaSClient.lineage()", () => {
  it("fetches GET /lineage/:id and parses records", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        request_id: "req_abc123",
        records: [
          {
            request_id: "req_abc123",
            ts: "2026-07-18T00:00:00.000Z",
            prev_hash: "sha256:prev",
            hash: "sha256:this",
            genome: { base_tier: "cognitum-low", frontier_tier: "cognitum-high", mode: "empty-patch-cascade" },
          },
        ],
      }),
    );
    const client = new HarnessaaSClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    const result = await client.lineage("req_abc123");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/lineage/req_abc123`);
    expect(result.data.records).toHaveLength(1);
    expect(result.data.records[0].hash).toBe("sha256:this");
    expect(result.data.records[0].raw.genome).toBeDefined();
  });

  it("maps 404 to a non-retryable not_found error (absent or cross-tenant request_id)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(404, { error: "request_id not found" }));
    const client = new HarnessaaSClient({
      baseUrl: BASE_URL,
      transport: fetchSpy,
      credentialProvider: makeCredentialProvider(),
    });

    await expect(client.lineage("req_unknown")).rejects.toMatchObject({ kind: "not_found", retryable: false });
  });

  it("fails closed without a credentialProvider", async () => {
    const fetchSpy = vi.fn();
    const client = new HarnessaaSClient({ baseUrl: BASE_URL, transport: fetchSpy });

    await expect(client.lineage("req_abc123")).rejects.toMatchObject({ kind: "authentication" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it(
    "retries a 503 (bounded, safe-read) and eventually succeeds",
    async () => {
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(503, { error: "unavailable" }))
        .mockResolvedValueOnce(jsonResponse(200, { request_id: "req_abc123", records: [] }));
      const client = new HarnessaaSClient({
        baseUrl: BASE_URL,
        transport: fetchSpy,
        credentialProvider: makeCredentialProvider(),
      });

      const result = await client.lineage("req_abc123");

      expect(result.data.requestId).toBe("req_abc123");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    },
    10_000,
  );
});

describe("toSolveRequestWire", () => {
  it("maps camelCase testCommand to snake_case test_command", () => {
    expect(toSolveRequestWire(SOLVE_REQUEST)).toEqual({
      repo: SOLVE_REQUEST.repo,
      test_command: SOLVE_REQUEST.testCommand,
      issue: SOLVE_REQUEST.issue,
    });
  });
});
