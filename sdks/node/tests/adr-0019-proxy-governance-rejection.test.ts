import { describe, it, expect, vi } from "vitest";

import { MetaProxyClient } from "../src/meta-proxy/client.js";
import { LocalBearerTokenCredentialProvider } from "../src/meta-proxy/auth.js";

/**
 * ADR-0019 "Compliance and verification" #7 (issue #74):
 *
 * > A proxy test proves an unsupported Meta LLM governance call is
 * > rejected locally and never reaches `/v1/*` on the proxy fixture.
 *
 * ADR-0019 §D7: "Meta LLM governance methods are never sent to Meta
 * Proxy." Meta Proxy's public surface (`src/meta-proxy/client.ts`) is,
 * as of this pass, exactly `status`, `capabilities`, `chat.completions`,
 * `chat.completionsStream`, and `preview.sponsored.chatCompletions` —
 * a strict subset of `MetaLlmClient`'s surface (`src/meta-llm/client.ts`),
 * which additionally exposes governance/account operations: `models()`,
 * `whoami()`, `usage()`, `ready()`, plus placeholders the Context section
 * names but that do not exist as methods anywhere yet (`batches`, `pods`).
 *
 * There is no generic "forward any operation" escape hatch on
 * `MetaProxyClient` — governance calls are rejected locally in the
 * strongest possible way: the method literally does not exist on the
 * client, so a caller cannot construct the wire request that would need
 * to reach `/v1/*` in the first place. This test proves that two ways:
 *
 *  1. Reflectively, for the full governance method list, confirming none
 *     of them is present as a callable function on `MetaProxyClient`.
 *  2. Behaviorally, by attempting to invoke one anyway (an `any`-typed
 *     escape hatch, simulating a caller who ignores the compiler) and
 *     asserting it throws a `TypeError` ("is not a function") — synchronously,
 *     before the event loop ever gets a chance to issue a network request —
 *     while a `fetch` spy on the same client proves the fixture never saw
 *     the attempt, alongside a legitimate forwarded call that DOES reach
 *     the fixture, so the spy is proven to be wired up correctly.
 */

const META_LLM_GOVERNANCE_METHODS = ["models", "whoami", "usage", "ready", "batches", "pods"] as const;

function proxyClient(transport: ReturnType<typeof vi.fn>): MetaProxyClient {
  return new MetaProxyClient({
    origin: "http://127.0.0.1:11435",
    transport,
    localCredentialProvider: new LocalBearerTokenCredentialProvider({
      token: "mh1.canary-local-token",
      normalizedOrigin: "http://127.0.0.1:11435",
    }),
  });
}

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

describe("ADR-0019 §Compliance #7 — Meta Proxy rejects Meta LLM governance calls locally", () => {
  it("MetaProxyClient exposes none of Meta LLM's governance methods", () => {
    const transport = vi.fn();
    const client = proxyClient(transport);
    const asAny = client as unknown as Record<string, unknown>;

    for (const method of META_LLM_GOVERNANCE_METHODS) {
      expect(
        typeof asAny[method],
        `MetaProxyClient must not expose a "${method}" governance method (ADR-0019 §D7)`,
      ).not.toBe("function");
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("invoking a Meta LLM governance operation through an untyped escape hatch fails before any HTTP call reaches the fixture", async () => {
    const transport = vi.fn();
    const client = proxyClient(transport);
    const asAny = client as unknown as Record<string, (...args: unknown[]) => unknown>;

    for (const method of META_LLM_GOVERNANCE_METHODS) {
      // No optional chaining here: the whole point is that calling a
      // nonexistent method throws synchronously, so the caller never gets
      // as far as issuing a request.
      expect(() => asAny[method]()).toThrow(TypeError);
    }
    // Zero requests ever reached the proxy fixture for any governance attempt.
    expect(transport).not.toHaveBeenCalled();
  });

  it("control: a real, supported Meta Proxy call (status) DOES reach the fixture, proving the spy above is not a false negative", async () => {
    const transport = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        proxy_token_valid: true,
        product_version: "0.1.0",
        protocol_version: "1.0",
        configured_plane: "local",
        selected_plane: "local",
        limitations: [],
      }),
    );
    const client = proxyClient(transport);

    await client.status();
    expect(transport).toHaveBeenCalledTimes(1);
    const [requestUrl] = transport.mock.calls[0] as [string | URL];
    expect(String(requestUrl)).toContain("/status");
    expect(String(requestUrl)).not.toContain("/v1/");
  });
});
