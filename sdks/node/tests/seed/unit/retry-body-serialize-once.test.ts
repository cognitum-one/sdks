/**
 * Regression — closes cognitum-one/sdks#23 (Node portion).
 *
 * Before the fix, `SeedClient.request()` re-serialised `opts.body` via
 * `JSON.stringify` inside `dispatchOnce`, which runs on every retry
 * attempt. On a 10-100 KB vector-ingest payload with 3 retries that's
 * 30-300 KB of wasted string work per call.
 *
 * The fix hoists the `JSON.stringify(opts.body)` call above the retry
 * loop and threads the pre-computed string into each `dispatchOnce`
 * invocation. This test locks that behaviour in by spying on
 * `JSON.stringify` and asserting it's called AT MOST once for the body
 * across the full 500 → 500 → 500 → 500 retry chain.
 */

import { describe, it, expect, vi } from "vitest";
import { SeedClient } from "../../../src/seed/index.js";

function serverError(): Response {
  return {
    ok: false,
    status: 500,
    statusText: "HTTP 500",
    headers: new Headers(),
    json: () => Promise.resolve({ error: "boom" }),
    text: () => Promise.resolve(JSON.stringify({ error: "boom" })),
  } as unknown as Response;
}

describe("retry body serialise-once (issue #23)", () => {
  it("serialises POST body at most once across N retries", async () => {
    // Distinctive payload we can scan for in the JSON.stringify spy.
    const body = {
      __retry_body_marker__: "cognitum-sdks-issue-23",
      vectors: Array.from({ length: 32 }, (_, i) => ({
        id: `v-${i}`,
        values: new Array(16).fill(i / 16),
      })),
    };

    // Mesh client — two peers so the failover state machine actually
    // cycles between them before falling through to the ADR-0005 retry
    // loop. Each peer gets at least one dispatch attempt, so fetchMock
    // receives >=2 calls and we get a meaningful signal for the
    // "serialise-once" invariant across dispatches.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(serverError());
    const client = new SeedClient({
      endpoints: ["https://peer-a:8443", "https://peer-b:8443"],
      auth: { pairingToken: "tok-test" },
      tls: { insecure: true },
      retries: 3, // full ADR-0005 retry chain on 500
      timeouts: { total: 2_000, read: 500 },
      fetch: fetchMock,
    });

    // Spy on JSON.stringify without breaking it. Record payloads whose
    // JSON contains our marker so we ignore incidental stringify calls
    // (test harness, console.log, etc).
    const realStringify = JSON.stringify;
    let bodySerialiseCount = 0;
    const spy = vi
      .spyOn(JSON, "stringify")
      .mockImplementation((value: unknown, replacer?: any, space?: any) => {
        const out = realStringify(value, replacer, space);
        if (
          typeof out === "string" &&
          out.includes("cognitum-sdks-issue-23")
        ) {
          bodySerialiseCount += 1;
        }
        return out;
      });

    try {
      // Force a retry chain — this will throw after exhausting retries.
      // Use the raw `request()` entry point so the test does not depend
      // on any resource-binding DTO shape.
      await expect(
        client.request("POST", "/api/v1/store/ingest", {
          body,
          idempotent: true, // lets POST actually retry on 500
        }),
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }

    // fetchMock should have been called multiple times (retry happened),
    // proving the retry loop actually ran.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);

    // The body must have been stringified at MOST once, regardless of how
    // many retry attempts fired. Before the fix this was equal to the
    // number of dispatch attempts (>=2).
    expect(bodySerialiseCount).toBeLessThanOrEqual(1);
  });

  it("does NOT serialise body for GET requests", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/json" }),
      json: () =>
        Promise.resolve({
          device_id: "t",
          uptime_secs: 0,
          epoch: 0,
          total_vectors: 0,
          deleted_vectors: 0,
          file_size_bytes: 0,
          dimension: 8,
          paired: false,
          roles: [],
        }),
      text: () =>
        Promise.resolve(
          JSON.stringify({
            device_id: "t",
            uptime_secs: 0,
            epoch: 0,
            total_vectors: 0,
            deleted_vectors: 0,
            file_size_bytes: 0,
            dimension: 8,
            paired: false,
            roles: [],
          }),
        ),
    } as unknown as Response);

    const client = new SeedClient({
      endpoints: "https://seed.test:8443",
      auth: { pairingToken: "tok-test" },
      tls: { insecure: true },
      retries: 0,
      fetch: fetchMock,
    });

    const marker = "__retry_body_marker_get__";
    const realStringify = JSON.stringify;
    let markerSerialiseCount = 0;
    const spy = vi
      .spyOn(JSON, "stringify")
      .mockImplementation((value: unknown, replacer?: any, space?: any) => {
        const out = realStringify(value, replacer, space);
        if (typeof out === "string" && out.includes(marker)) {
          markerSerialiseCount += 1;
        }
        return out;
      });

    try {
      // GET path — passing a body via request() internals (should be
      // ignored). We assert by confirming the marker never shows up in
      // a stringify call, because request() skips JSON.stringify for
      // GET/HEAD entirely.
      await client.request("GET", "/api/v1/status", {
        body: { [marker]: true } as any,
      });
    } finally {
      spy.mockRestore();
    }

    expect(markerSerialiseCount).toBe(0);
  });
});
