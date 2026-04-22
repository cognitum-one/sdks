/**
 * Phase 1.5 mesh-routing integration tests (ADR-0017 §5).
 *
 * The 7 tests below are a Node translation of the Rust `seed_mesh.rs`
 * suite. Each test stubs `fetch` with a per-URL dispatcher — simpler than
 * pulling in `undici.MockAgent` or `msw` (neither is in the dependency
 * list) and still exercises the real `SeedClient.request` pipeline.
 *
 * Fixture naming matches ADR-0017 §5 verbatim so the Rust / Python / Node
 * suites stay diffable.
 */

import { describe, it, expect, vi } from "vitest";
import {
  InMemoryTokenBook,
  SecretString,
  SeedClient,
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

const OK_STORE_STATUS_BODY = {
  total_vectors: 1,
  deleted_vectors: 0,
  file_size_bytes: 0,
  dimension: 8,
};

const OK_QUERY_BODY = { results: [], query_ms: 0 };
const OK_INGEST_BODY = { ingested: 1 };

// Per-test mock server. Each test instantiates 1-3 "servers" (URL
// prefixes) and registers handlers that match on (method, path).
interface MockServer {
  uri: string;
  hits: Array<{ method: string; path: string; headers: Record<string, string> }>;
  handlers: Array<{
    method: string;
    path: string;
    remaining: number; // -1 = unlimited
    respond: () => MockResponse;
  }>;
  fallback?: () => MockResponse;
}

interface MockResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

let SERVER_COUNTER = 0;

function mockServer(): MockServer {
  const id = ++SERVER_COUNTER;
  return {
    uri: `https://mock-${id}.test:8443`,
    hits: [],
    handlers: [],
  };
}

function given(
  server: MockServer,
  method: string,
  path: string,
  respond: () => MockResponse,
  opts: { upToN?: number } = {},
): void {
  server.handlers.push({
    method: method.toUpperCase(),
    path,
    remaining: opts.upToN ?? -1,
    respond,
  });
}

function mkResponse(body: MockResponse): Response {
  const headers = new Headers({
    "content-type": "application/json",
    ...(body.headers ?? {}),
  });
  const text =
    body.body === undefined
      ? ""
      : typeof body.body === "string"
        ? body.body
        : JSON.stringify(body.body);
  return new Response(text, { status: body.status, headers });
}

/**
 * Build a mock `fetch` that dispatches across the supplied mock servers
 * based on URL prefix match, then runs the matching handler.
 */
function meshFetch(servers: MockServer[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    }

    const server = servers.find((s) => url.startsWith(s.uri));
    if (!server) {
      return new Response(JSON.stringify({ error: "unknown peer" }), {
        status: 500,
      });
    }
    const path = url.substring(server.uri.length);
    server.hits.push({ method, path, headers });

    for (const h of server.handlers) {
      if (h.method !== method) continue;
      if (h.path !== path) continue;
      if (h.remaining === 0) continue;
      if (h.remaining > 0) h.remaining -= 1;
      return mkResponse(h.respond());
    }
    if (server.fallback) {
      return mkResponse(server.fallback());
    }
    return new Response(JSON.stringify({ error: "no handler", path }), {
      status: 404,
    });
  }) as unknown as typeof fetch;
}

function countHits(server: MockServer, pathPrefix: string): number {
  return server.hits.filter((h) => h.path.startsWith(pathPrefix)).length;
}

function buildClient(
  servers: MockServer[],
  overrides: { tokenBook?: InMemoryTokenBook; retries?: number } = {},
): SeedClient {
  return new SeedClient({
    endpoints: servers.map((s) => s.uri),
    retries: overrides.retries ?? 3,
    tls: { insecure: true },
    ...(overrides.tokenBook ? { tokenBook: overrides.tokenBook } : {}),
    fetch: meshFetch(servers),
  });
}

// ---------- 1. single-peer degenerates to Phase 1 -------------------------

describe("mesh integration (ADR-0017 §5)", () => {
  it("test_mesh_single_peer_behaves_like_single_mode", async () => {
    const a = mockServer();
    given(a, "GET", "/api/v1/status", () => ({
      status: 200,
      body: OK_STATUS_BODY,
    }));

    const client = buildClient([a]);
    const status = await client.status();
    expect(status.paired).toBe(true);
    expect(client.peers().length).toBe(1);
    expect(countHits(a, "/api/v1/status")).toBe(1);
  });

  // ---------- 2. two-peer smoke: both peers serve reads --------------------

  it("test_mesh_two_peers_round_robin_for_reads", async () => {
    const a = mockServer();
    const b = mockServer();

    // A: first store/status 500s, subsequent 200.
    given(
      a,
      "GET",
      "/api/v1/store/status",
      () => ({ status: 500, body: "boom" }),
      { upToN: 1 },
    );
    given(a, "GET", "/api/v1/store/status", () => ({
      status: 200,
      body: OK_STORE_STATUS_BODY,
    }));
    given(b, "GET", "/api/v1/store/status", () => ({
      status: 200,
      body: OK_STORE_STATUS_BODY,
    }));

    const client = buildClient([a, b]);

    const s1 = await client.store.status();
    expect(s1.dimension).toBe(8);

    const s2 = await client.store.status();
    expect(s2.dimension).toBe(8);

    const aHits = countHits(a, "/api/v1/store/status");
    const bHits = countHits(b, "/api/v1/store/status");
    expect(aHits).toBeGreaterThanOrEqual(1);
    expect(bHits).toBeGreaterThanOrEqual(1);
  });

  // ---------- 3. cycles on 5xx --------------------------------------------

  it("test_mesh_cycles_on_5xx", async () => {
    const a = mockServer();
    const b = mockServer();

    given(
      a,
      "POST",
      "/api/v1/store/query",
      () => ({ status: 500, body: { error: "boom" } }),
      { upToN: 1 },
    );
    given(b, "POST", "/api/v1/store/query", () => ({
      status: 200,
      body: OK_QUERY_BODY,
    }));

    const client = buildClient([a, b]);

    const t0 = Date.now();
    const result = await client.store.query({ vector: new Array(8).fill(0), k: 1 });
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(result.results).toEqual([]);
    expect(countHits(a, "/api/v1/store/query")).toBe(1);
    expect(countHits(b, "/api/v1/store/query")).toBe(1);
  });

  // ---------- 4. pins on 429 ----------------------------------------------

  it("test_mesh_pins_on_429", async () => {
    const a = mockServer();
    const b = mockServer();

    // A: first hit 429 (Retry-After: 0), second hit 200. Routing MUST
    // NOT cycle to B on a 429 (trust-score-shaped signal).
    given(
      a,
      "GET",
      "/api/v1/store/status",
      () => ({
        status: 429,
        body: { error: "rate limited" },
        headers: { "retry-after": "0" },
      }),
      { upToN: 1 },
    );
    given(a, "GET", "/api/v1/store/status", () => ({
      status: 200,
      body: OK_STORE_STATUS_BODY,
    }));
    given(b, "GET", "/api/v1/store/status", () => ({
      status: 200,
      body: OK_STORE_STATUS_BODY,
    }));

    const client = buildClient([a, b]);
    const s = await client.store.status();
    expect(s.dimension).toBe(8);

    // The 429 must have kept routing pinned to A — B never hit.
    expect(countHits(a, "/api/v1/store/status")).toBe(2);
    expect(countHits(b, "/api/v1/store/status")).toBe(0);
  });

  // ---------- 5. session stickiness ---------------------------------------

  it("test_mesh_session_stickiness", async () => {
    const a = mockServer();
    const b = mockServer();

    for (const s of [a, b]) {
      given(s, "POST", "/api/v1/store/ingest", () => ({
        status: 200,
        body: OK_INGEST_BODY,
      }));
      given(s, "POST", "/api/v1/store/query", () => ({
        status: 200,
        body: OK_QUERY_BODY,
      }));
    }

    const client = buildClient([a, b]);
    const session = client.session();
    const pinned = session.pinnedPeer;

    await session.store.ingest({
      vectors: [{ values: [0, 0, 0, 0, 0, 0, 0, 0] }],
    });
    await session.store.query({ vector: new Array(8).fill(0), k: 1 });

    const expected = pinned === a.uri ? a : b;
    const other = pinned === a.uri ? b : a;
    expect(expected.hits.length).toBe(2);
    expect(other.hits.length).toBe(0);
  });

  // ---------- 6. per-peer TokenBook ---------------------------------------

  it("test_mesh_token_book_per_peer", async () => {
    const a = mockServer();
    const b = mockServer();

    // Both peers accept /pair; we assert the outgoing X-Pairing-Token
    // matches the per-peer book entry for whichever peer handles it.
    const tokenSeen: Record<string, string | undefined> = { a: undefined, b: undefined };
    given(a, "POST", "/api/v1/pair", () => {
      tokenSeen.a =
        a.hits[a.hits.length - 1]?.headers["x-pairing-token"] ?? undefined;
      return {
        status: 200,
        body: { client_name: "cli", pairing_token: "tok-a-new" },
      };
    });
    given(b, "POST", "/api/v1/pair", () => {
      tokenSeen.b =
        b.hits[b.hits.length - 1]?.headers["x-pairing-token"] ?? undefined;
      return {
        status: 200,
        body: { client_name: "cli", pairing_token: "tok-b-new" },
      };
    });

    const book = new InMemoryTokenBook();
    book.set(a.uri, new SecretString("tok-a"));
    book.set(b.uri, new SecretString("tok-b"));

    const client = buildClient([a, b], { tokenBook: book, retries: 0 });

    // Pair through a session pinned to A.
    const sessionA = client.session(); // pinned to A (first peer is primary)
    expect(sessionA.pinnedPeer).toBe(a.uri);
    await sessionA.pair.create({ clientName: "cli" });
    expect(tokenSeen.a).toBe("tok-a");

    // The TokenBook must keep per-peer entries distinct.
    expect(client.tokenForPeer(a.uri)).toBe("tok-a");
    expect(client.tokenForPeer(b.uri)).toBe("tok-b");
    expect(client.tokenForPeer(a.uri)).not.toBe(client.tokenForPeer(b.uri));
  });

  // ---------- 7. active health probe degrades unhealthy peer --------------

  it("test_mesh_health_probe_degrades_unhealthy_peer", async () => {
    const a = mockServer();
    const b = mockServer();

    // A: /status 503s (lockdown) → probe marks unhealthy.
    given(a, "GET", "/api/v1/status", () => ({
      status: 503,
      body: "lockdown",
    }));
    given(b, "GET", "/api/v1/status", () => ({
      status: 200,
      body: OK_STATUS_BODY,
    }));
    given(b, "GET", "/api/v1/store/status", () => ({
      status: 200,
      body: OK_STORE_STATUS_BODY,
    }));

    const client = new SeedClient({
      endpoints: [a.uri, b.uri],
      retries: 0,
      tls: { insecure: true },
      healthInterval: 30,
      fetch: meshFetch([a, b]),
    });

    try {
      // Wait a handful of probe cycles.
      await new Promise((r) => setTimeout(r, 250));

      const snap = client.peers();
      const aPeer = snap.find((p) => p.key === a.uri)!;
      expect(
        aPeer.state === "degraded" || aPeer.state === "unhealthy",
      ).toBe(true);

      // User-issued read must land on B now.
      const s = await client.store.status();
      expect(s.dimension).toBe(8);
      expect(countHits(b, "/api/v1/store/status")).toBeGreaterThanOrEqual(1);
      // A may have been probed many times but never user-queried for /store/status.
      expect(countHits(a, "/api/v1/store/status")).toBe(0);
    } finally {
      client.close();
    }
  });
});
