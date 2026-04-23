/**
 * Pairing-token redaction regression tests — closes cognitum-one/sdks#15.
 *
 * The old `PairCreateResponse` shape returned the freshly-minted pairing
 * token as a plain `string` field (`pairing_token`). Any call site that
 * logged the response — `console.log(resp)`, `JSON.stringify(resp)`,
 * telemetry helpers that reflect over the object — would leak the token.
 *
 * The fix (issue #15) replaces the wire shape with a curated
 * {@link PairCreateResponse} where `token` is a {@link SecretString}
 * that redacts itself in every serialisation path.
 */

import { describe, it, expect, vi } from "vitest";
import { inspect } from "node:util";
import { SeedClient } from "../../../src/seed/index.js";
import { SecretString } from "../../../src/seed/tokenBook.js";

const SENTINEL = "sk_pair_super_secret_XXXXXXXXXXXXXXXX";

function mockPairFetch(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    json: () =>
      Promise.resolve({
        client_name: "laptop",
        pairing_token: SENTINEL,
        expires_at: "2026-05-22T00:00:00Z",
      }),
    text: () =>
      Promise.resolve(
        JSON.stringify({
          client_name: "laptop",
          pairing_token: SENTINEL,
          expires_at: "2026-05-22T00:00:00Z",
        }),
      ),
  } as unknown as Response);
}

function client(fetchFn: typeof fetch): SeedClient {
  return new SeedClient({
    endpoints: "https://seed.test:8443",
    auth: { pairingToken: "tok-existing" },
    tls: { insecure: true },
    retries: 0,
    fetch: fetchFn,
  });
}

describe("pair.create() — token redaction (issue #15)", () => {
  it("returns a SecretString token, not a raw string", async () => {
    const c = client(mockPairFetch() as unknown as typeof fetch);
    const result = await c.pair.create({ clientName: "laptop" });
    expect(result.token).toBeInstanceOf(SecretString);
    expect(result.client_name).toBe("laptop");
    expect(result.expires_at).toBe("2026-05-22T00:00:00Z");
    // The wire field name `pairing_token` must NOT appear on the typed
    // response — it was the attack surface.
    expect((result as unknown as Record<string, unknown>).pairing_token).toBeUndefined();
  });

  it("JSON.stringify(result) must NOT contain the sentinel token", async () => {
    const c = client(mockPairFetch() as unknown as typeof fetch);
    const result = await c.pair.create({ clientName: "laptop" });
    const json = JSON.stringify(result);
    expect(json).not.toContain(SENTINEL);
    expect(json).toContain("<redacted>");
  });

  it("String(result.token) must NOT contain the sentinel token", async () => {
    const c = client(mockPairFetch() as unknown as typeof fetch);
    const result = await c.pair.create({ clientName: "laptop" });
    const str = String(result.token);
    expect(str).not.toContain(SENTINEL);
    expect(str).toMatch(/redacted/i);
  });

  it("util.inspect(result) must NOT contain the sentinel token", async () => {
    const c = client(mockPairFetch() as unknown as typeof fetch);
    const result = await c.pair.create({ clientName: "laptop" });
    const inspected = inspect(result, { depth: 4 });
    expect(inspected).not.toContain(SENTINEL);
    expect(inspected).toMatch(/redacted/i);
  });

  it("console.log-style default formatter must NOT leak the sentinel", async () => {
    const c = client(mockPairFetch() as unknown as typeof fetch);
    const result = await c.pair.create({ clientName: "laptop" });
    // `%o` / `%O` formatting in Node's console goes through util.inspect;
    // simulate it via inspect with the same defaults.
    const formatted = inspect({ pair: result });
    expect(formatted).not.toContain(SENTINEL);
  });

  it(".reveal() is the single authorised path to the raw token", async () => {
    const c = client(mockPairFetch() as unknown as typeof fetch);
    const result = await c.pair.create({ clientName: "laptop" });
    // Callers must explicitly opt in to see the raw string.
    expect(result.token.reveal()).toBe(SENTINEL);
    expect(result.token.length).toBe(SENTINEL.length);
    expect(result.token.isEmpty()).toBe(false);
  });
});
