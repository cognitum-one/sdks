/**
 * Per-call override knob tests — ADR-0016b §"Per-call knobs", Phase 2.
 *
 * Covers peer-override, unknown-peer rejection, prefer ordering, consistency
 * modes, timeout / retries overrides, and AbortSignal cancellation. Uses a
 * tiny per-URL mock fetch (same shape as `tests/seed/integration/mesh.test.ts`)
 * so each assertion exercises the real `SeedClient.request` pipeline.
 */

import { describe, it, expect, vi } from "vitest";
import {
  ConfigError,
  NetworkError,
  SeedClient,
  UnsupportedError,
} from "../../../src/seed/index.js";

// ---------- shared fixtures ------------------------------------------------

const OK_STATUS_BODY = {
  device_id: "abc",
  uptime_secs: 1,
  epoch: 1,
  total_vectors: 0,
  deleted_vectors: 0,
  file_size_bytes: 0,
  dimension: 8,
  paired: true,
  roles: [],
};

interface MockServer {
  uri: string;
  hits: Array<{ method: string; path: string }>;
  handlers: Array<{
    method: string;
    path: string;
    respond: () => { status: number; body?: unknown };
  }>;
}

let SERVER_COUNTER = 0;

function mockServer(uri?: string): MockServer {
  const id = ++SERVER_COUNTER;
  return {
    uri: uri ?? `https://mock-${id}.test:8443`,
    hits: [],
    handlers: [],
  };
}

function given(
  server: MockServer,
  method: string,
  path: string,
  respond: () => { status: number; body?: unknown },
): void {
  server.handlers.push({ method: method.toUpperCase(), path, respond });
}

function meshFetch(servers: MockServer[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const server = servers.find((s) => url.startsWith(s.uri));
    if (!server) {
      return new Response(JSON.stringify({ error: "unknown peer" }), {
        status: 500,
      });
    }
    const path = url.substring(server.uri.length);
    server.hits.push({ method, path });
    for (const h of server.handlers) {
      if (h.method !== method) continue;
      if (h.path !== path) continue;
      const r = h.respond();
      return new Response(
        r.body === undefined
          ? ""
          : typeof r.body === "string"
            ? r.body
            : JSON.stringify(r.body),
        {
          status: r.status,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response(JSON.stringify({ error: "no handler", path }), {
      status: 404,
    });
  }) as unknown as typeof fetch;
}

function buildClient(servers: MockServer[]): SeedClient {
  return new SeedClient({
    endpoints: servers.map((s) => s.uri),
    retries: 3,
    tls: { insecure: true },
    fetch: meshFetch(servers),
  });
}

// ---------- tests ----------------------------------------------------------

describe("CallOptions (ADR-0016b §Per-call knobs)", () => {
  it("peer: override pins the call to the named peer", async () => {
    const a = mockServer();
    const b = mockServer();
    given(a, "GET", "/api/v1/status", () => ({ status: 200, body: OK_STATUS_BODY }));
    given(b, "GET", "/api/v1/status", () => ({ status: 200, body: OK_STATUS_BODY }));

    const client = buildClient([a, b]);

    // Without an override, default closest-first picks A (listIndex 0).
    // Force the one call to B.
    await client.status.get({ peer: b.uri });

    expect(a.hits.length).toBe(0);
    expect(b.hits.length).toBe(1);
  });

  it("peer: unknown → throws ConfigError before dispatch", async () => {
    const a = mockServer();
    given(a, "GET", "/api/v1/status", () => ({ status: 200, body: OK_STATUS_BODY }));
    const client = buildClient([a]);

    await expect(
      client.status.get({ peer: "https://not-in-mesh:8443" }),
    ).rejects.toBeInstanceOf(ConfigError);

    expect(a.hits.length).toBe(0);
  });

  it("prefer: 'closest' sends to the latency-lowest peer", async () => {
    const a = mockServer(); // will be marked high-latency
    const b = mockServer(); // will be marked low-latency
    given(a, "GET", "/api/v1/status", () => ({ status: 200, body: OK_STATUS_BODY }));
    given(b, "GET", "/api/v1/status", () => ({ status: 200, body: OK_STATUS_BODY }));

    const client = buildClient([a, b]);
    // Prime EMA: a slow (500ms), b fast (20ms)
    client["peerSet"].markSuccess(a.uri, 500);
    client["peerSet"].markSuccess(b.uri, 20);

    await client.status.get({ prefer: "closest" });
    expect(b.hits.length).toBe(1);
    expect(a.hits.length).toBe(0);
  });

  it("prefer: 'local-first' prefers RFC-1918 hosts over public ones", async () => {
    const local = mockServer("https://192.168.1.10:8443");
    const remote = mockServer("https://seed.example.com:8443");
    given(local, "GET", "/api/v1/status", () => ({ status: 200, body: OK_STATUS_BODY }));
    given(remote, "GET", "/api/v1/status", () => ({ status: 200, body: OK_STATUS_BODY }));

    // Order `remote` FIRST so default routing would pick it — the prefer
    // knob must override that.
    const client = buildClient([remote, local]);
    await client.status.get({ prefer: "local-first" });

    expect(local.hits.length).toBe(1);
    expect(remote.hits.length).toBe(0);
  });

  it("prefer: 'random' walks SOME peer (both are valid)", async () => {
    const a = mockServer();
    const b = mockServer();
    given(a, "GET", "/api/v1/status", () => ({ status: 200, body: OK_STATUS_BODY }));
    given(b, "GET", "/api/v1/status", () => ({ status: 200, body: OK_STATUS_BODY }));
    const client = buildClient([a, b]);

    await client.status.get({ prefer: "random" });
    const total = a.hits.length + b.hits.length;
    expect(total).toBe(1);
  });

  it("prefer: 'any' behaves like closest (default ordering)", async () => {
    const a = mockServer();
    const b = mockServer();
    given(a, "GET", "/api/v1/status", () => ({ status: 200, body: OK_STATUS_BODY }));
    given(b, "GET", "/api/v1/status", () => ({ status: 200, body: OK_STATUS_BODY }));
    const client = buildClient([a, b]);

    await client.status.get({ prefer: "any" });
    expect(a.hits.length).toBe(1);
    expect(b.hits.length).toBe(0);
  });

  it("consistency: 'strong' → UnsupportedError, no network dispatch", async () => {
    const a = mockServer();
    given(a, "GET", "/api/v1/status", () => ({ status: 200, body: OK_STATUS_BODY }));
    const client = buildClient([a]);

    await expect(
      client.status.get({ consistency: "strong" }),
    ).rejects.toBeInstanceOf(UnsupportedError);
    expect(a.hits.length).toBe(0);
  });

  it("consistency: 'eventual' bypasses session-stickiness for a single call", async () => {
    const a = mockServer();
    const b = mockServer();
    given(a, "GET", "/api/v1/status", () => ({ status: 200, body: OK_STATUS_BODY }));
    given(b, "GET", "/api/v1/status", () => ({ status: 200, body: OK_STATUS_BODY }));
    const client = buildClient([a, b]);

    // Pinning a session to B forces the next call onto B even though A is
    // the default closest-first choice.
    await client.request("GET", "/api/v1/status", {
      idempotent: true,
      pinnedPeerKey: b.uri,
    });
    expect(b.hits.length).toBe(1);
    // After B served the call its EMA is the lowest — force A ahead again
    // so the "eventual" path has a visible ordering to pick from.
    client["peerSet"].markSuccess(a.uri, 5);
    client["peerSet"].markSuccess(b.uri, 500);

    // Eventual consistency disables the pin — the pick falls back to
    // closest-first, which is now A.
    await client.request("GET", "/api/v1/status", {
      idempotent: true,
      pinnedPeerKey: b.uri,
      consistency: "eventual",
    });
    expect(a.hits.length).toBe(1);
  });

  it("timeoutMs override is honoured for a single call", async () => {
    const a = mockServer();
    // Hang until aborted to force the per-call timeout.
    given(a, "GET", "/api/v1/status", () => ({ status: 200, body: OK_STATUS_BODY }));
    let resolveFetch: () => void;
    const pending = new Promise<void>((r) => {
      resolveFetch = r;
    });
    const client = new SeedClient({
      endpoints: [a.uri],
      retries: 0,
      tls: { insecure: true },
      fetch: (async (_input, init) => {
        // Wait for either abort or test-release.
        await new Promise<void>((resolve) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (signal) {
            signal.addEventListener(
              "abort",
              () => {
                resolveFetch();
                resolve();
              },
              { once: true },
            );
          }
          pending.then(resolve);
        });
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }) as unknown as typeof fetch,
    });

    const start = Date.now();
    await expect(
      client.status.get({ timeoutMs: 50 }),
    ).rejects.toThrow();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2_000);
    resolveFetch!();
  });

  it("retries: null disables retry (single attempt, then surfaces)", async () => {
    const a = mockServer();
    // Every call returns 503 — normally retryable.
    let hits = 0;
    given(a, "GET", "/api/v1/status", () => {
      hits += 1;
      return { status: 503, body: { error: "unavailable" } };
    });
    const client = buildClient([a]);

    await expect(
      client.status.get({ retries: null }),
    ).rejects.toBeDefined();

    // With retries=null we should see exactly 1 dispatch; the default
    // would have made more.
    expect(hits).toBe(1);
  });

  it("signal cancels an in-flight call with NetworkError", async () => {
    const a = mockServer();
    const controller = new AbortController();

    const client = new SeedClient({
      endpoints: [a.uri],
      retries: 0,
      tls: { insecure: true },
      fetch: (async (_input, init) => {
        await new Promise<void>((_resolve, reject) => {
          const sig = init?.signal as AbortSignal | undefined;
          sig?.addEventListener(
            "abort",
            () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            },
            { once: true },
          );
        });
        throw new Error("unreachable");
      }) as unknown as typeof fetch,
    });

    const pending = client.status.get({ signal: controller.signal });
    // Give the request loop a tick to attach the listener.
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(NetworkError);
  });
});
