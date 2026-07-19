import { describe, it, expect, vi } from "vitest";

import { UnsupportedCapabilityError } from "../src/agentic/index.js";
import { StaticApiKeyCredentialProvider } from "../src/agentic/static-api-key-provider.js";
import { MetaLlmClient } from "../src/meta-llm/client.js";
import { MetaProxyClient } from "../src/meta-proxy/client.js";
import { LocalBearerTokenCredentialProvider } from "../src/meta-proxy/auth.js";
import { MetaHarnessClient } from "../src/metaharness/client.js";
import { HarnessaaSClient } from "../src/harnessaas/client.js";

/**
 * ADR-0019 "Acceptance test" (issue #74), the ADR's own closing paragraph:
 *
 * > For each of Node, Python, and Rust, instantiate all four clients with
 * > fake local transports and distinct sentinel credentials. Assert zero
 * > I/O during construction, assert each client sends only its own
 * > credential to its own fixture, assert an unknown capability blocks a
 * > billable mutation before I/O, and assert importing one namespace does
 * > not load another product implementation.
 *
 * Written as one integration-style test exercising all four clients
 * together, per the ADR's own framing ("instantiate all four clients ...
 * in ONE test" per issue #74's brief).
 */

const META_LLM_ORIGIN = "http://127.0.0.1:9101";
const HARNESSAAS_ORIGIN = "http://127.0.0.1:9102";
const META_PROXY_ORIGIN = "http://127.0.0.1:9103";

const SENTINEL = {
  metaLlm: "sk-sentinel-meta-llm-AAA111",
  metaProxy: "mh1.sentinel-meta-proxy-BBB222",
  harnessaas: "cog_sentinel_harnessaas_CCC333",
} as const;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `Status ${status}`,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe("ADR-0019 acceptance test — four clients, fake transports, sentinel credentials", () => {
  it("zero construction I/O, no credential bleed, unknown capability fails closed, no cross-product import", async () => {
    // ---------------------------------------------------------------
    // (d) importing one namespace does not load another product's
    // implementation — checked FIRST, before any client touches its
    // module cache via a plain (non-mocked) import elsewhere in this
    // file's module graph.
    // ---------------------------------------------------------------
    vi.resetModules();
    for (const other of ["meta-proxy", "metaharness", "harnessaas"]) {
      vi.doMock(`../src/${other}/index.js`, () => {
        throw new Error(`importing meta-llm must not import ${other} (ADR-0019 §D4)`);
      });
    }
    await expect(import("../src/meta-llm/index.js")).resolves.toBeTruthy();
    vi.doUnmock("../src/meta-proxy/index.js");
    vi.doUnmock("../src/metaharness/index.js");
    vi.doUnmock("../src/harnessaas/index.js");
    vi.resetModules();

    // ---------------------------------------------------------------
    // (a) zero I/O during construction, for all four clients.
    // ---------------------------------------------------------------
    const metaLlmTransport = vi.fn();
    const metaProxyTransport = vi.fn();
    const harnessaasTransport = vi.fn();

    const metaLlmClient = new MetaLlmClient({
      baseUrl: META_LLM_ORIGIN,
      allowInsecureHttp: true,
      transport: metaLlmTransport,
      credentialProvider: new StaticApiKeyCredentialProvider({
        apiKey: SENTINEL.metaLlm,
        product: "meta-llm",
        normalizedOrigin: META_LLM_ORIGIN,
        audience: META_LLM_ORIGIN,
      }),
    });

    const metaProxyClient = new MetaProxyClient({
      origin: META_PROXY_ORIGIN,
      transport: metaProxyTransport,
      localCredentialProvider: new LocalBearerTokenCredentialProvider({
        token: SENTINEL.metaProxy,
        normalizedOrigin: META_PROXY_ORIGIN,
      }),
    });

    const metaHarnessClient = new MetaHarnessClient();

    const harnessaasClient = new HarnessaaSClient({
      baseUrl: HARNESSAAS_ORIGIN,
      allowInsecureHttp: true,
      transport: harnessaasTransport,
      credentialProvider: new StaticApiKeyCredentialProvider({
        apiKey: SENTINEL.harnessaas,
        product: "harnessaas",
        normalizedOrigin: HARNESSAAS_ORIGIN,
        audience: HARNESSAAS_ORIGIN,
      }),
    });

    expect(metaLlmClient).toBeInstanceOf(MetaLlmClient);
    expect(metaProxyClient).toBeInstanceOf(MetaProxyClient);
    expect(metaHarnessClient).toBeInstanceOf(MetaHarnessClient);
    expect(harnessaasClient).toBeInstanceOf(HarnessaaSClient);
    expect(metaLlmTransport).not.toHaveBeenCalled();
    expect(metaProxyTransport).not.toHaveBeenCalled();
    expect(harnessaasTransport).not.toHaveBeenCalled();

    // ---------------------------------------------------------------
    // (b) each client sends only its own credential to its own fixture
    // — never another client's sentinel.
    // ---------------------------------------------------------------
    metaLlmTransport.mockResolvedValue(jsonResponse(200, { object: "list", models: [] }));
    metaProxyTransport.mockResolvedValue(
      jsonResponse(200, {
        proxy_token_valid: true,
        product_version: "0.1.0",
        protocol_version: "1.0",
        configured_plane: "local",
        selected_plane: "local",
        limitations: [],
      }),
    );
    harnessaasTransport.mockResolvedValue(jsonResponse(200, { request_id: "req-sentinel-check", records: [] }));

    await metaLlmClient.models();
    await metaProxyClient.status();
    await harnessaasClient.lineage("req-sentinel-check");

    expect(metaLlmTransport).toHaveBeenCalledTimes(1);
    expect(metaProxyTransport).toHaveBeenCalledTimes(1);
    expect(harnessaasTransport).toHaveBeenCalledTimes(1);

    function headersOf(mockFn: ReturnType<typeof vi.fn>): string {
      const [, init] = mockFn.mock.calls[0] as [string | URL, RequestInit];
      const headers = init.headers as Record<string, string> | Headers | undefined;
      if (headers instanceof Headers) {
        return JSON.stringify(Object.fromEntries(headers.entries()));
      }
      return JSON.stringify(headers ?? {});
    }

    const metaLlmHeaders = headersOf(metaLlmTransport);
    const metaProxyHeaders = headersOf(metaProxyTransport);
    const harnessaasHeaders = headersOf(harnessaasTransport);

    // Each fixture saw its own sentinel...
    expect(metaLlmHeaders).toContain(SENTINEL.metaLlm);
    expect(metaProxyHeaders).toContain(SENTINEL.metaProxy);
    expect(harnessaasHeaders).toContain(SENTINEL.harnessaas);

    // ...and NEVER another client's sentinel (no credential bleed).
    expect(metaLlmHeaders).not.toContain(SENTINEL.metaProxy);
    expect(metaLlmHeaders).not.toContain(SENTINEL.harnessaas);
    expect(metaProxyHeaders).not.toContain(SENTINEL.metaLlm);
    expect(metaProxyHeaders).not.toContain(SENTINEL.harnessaas);
    expect(harnessaasHeaders).not.toContain(SENTINEL.metaLlm);
    expect(harnessaasHeaders).not.toContain(SENTINEL.metaProxy);

    // ---------------------------------------------------------------
    // (c) an unknown capability blocks a billable mutation before I/O.
    // MetaHarnessClient.scaffold() (a mutating, would-be code-execution
    // operation) has no published bridge capability yet (ADR-0026a §D7),
    // so it fails closed with UnsupportedCapabilityError, and NONE of the
    // three HTTP transports above see any additional call as a result.
    // ---------------------------------------------------------------
    const callCountsBefore = {
      metaLlm: metaLlmTransport.mock.calls.length,
      metaProxy: metaProxyTransport.mock.calls.length,
      harnessaas: harnessaasTransport.mock.calls.length,
    };

    await expect(
      metaHarnessClient.scaffold(
        {
          schema: "cognitum.metaharness.scaffold-plan.v1",
          planId: "plan_1",
          planDigest: "sha256:deadbeef",
          createdAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(),
          generatorIdentity: { product: "metaharness-oss" },
          templateIdentity: { template: "default" },
          canonicalTarget: "/tmp/target",
          targetBeforeDigest: "sha256:before",
          requestDigest: "sha256:request",
          actions: [],
          unresolvedVariables: [],
          warnings: [],
          destructive: false,
          estimatedFiles: 0,
          estimatedBytes: 0,
        },
        { planDigest: "sha256:deadbeef", approvedAt: new Date().toISOString() },
      ),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);

    expect(metaLlmTransport.mock.calls.length).toBe(callCountsBefore.metaLlm);
    expect(metaProxyTransport.mock.calls.length).toBe(callCountsBefore.metaProxy);
    expect(harnessaasTransport.mock.calls.length).toBe(callCountsBefore.harnessaas);
  });
});
