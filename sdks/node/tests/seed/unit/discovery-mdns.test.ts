/**
 * `MdnsDiscovery` unit tests (ADR-0016a §D6 Phase 1.5).
 *
 * No real multicast traffic here — the tests inject a stub `mdnsFactory`
 * that synthesises response packets in the shape emitted by
 * `seed/src/cognitum-agent/src/discovery.rs:137-180`. Integration tests
 * against a live seed are deferred (guarded by `SKIP_MDNS_INTEGRATION`
 * in the integration suite).
 */

import { describe, it, expect } from "vitest";
import { MdnsDiscovery } from "../../../src/seed/discovery/mdns.js";
import { SeedClient } from "../../../src/seed/client.js";

interface StubPacket {
  answers?: Array<{ name: string; type: string; data: unknown }>;
  additionals?: Array<{ name: string; type: string; data: unknown }>;
}

/**
 * Minimal `multicast-dns` stub. Fires a canned response packet on
 * nextTick after `query()` is invoked so `discover()`'s timeout-based
 * collection observes at least one record.
 */
function makeStubFactory(
  responses: readonly StubPacket[],
): {
  factory: ConstructorParameters<typeof MdnsDiscovery>[0]["mdnsFactory"];
  destroyed: () => boolean;
  queries: () => number;
} {
  let destroyed = false;
  let queries = 0;
  const factory = () => {
    const listeners: Array<(p: StubPacket) => void> = [];
    return {
      query(): void {
        queries += 1;
        setImmediate(() => {
          for (const p of responses) {
            for (const l of listeners) l(p);
          }
        });
      },
      on(event: string, cb: (p: StubPacket) => void): void {
        if (event === "response") listeners.push(cb);
      },
      removeListener(event: string, cb: (p: StubPacket) => void): void {
        if (event !== "response") return;
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      },
      destroy(cb?: () => void): void {
        destroyed = true;
        cb?.();
      },
    };
  };
  return {
    factory: factory as unknown as ConstructorParameters<
      typeof MdnsDiscovery
    >[0]["mdnsFactory"],
    destroyed: () => destroyed,
    queries: () => queries,
  };
}

const txtBuf = (entries: string[]): Uint8Array[] =>
  entries.map((e) => new TextEncoder().encode(e));

describe("MdnsDiscovery (ADR-0016a §D6 Phase 1.5)", () => {
  it("discovers seeds from TXT records on the default service type", async () => {
    const { factory } = makeStubFactory([
      {
        answers: [
          {
            name: "cognitum-61bc._cognitum._tcp.local",
            type: "TXT",
            data: txtBuf([
              "id=ad7d7e7b-56e7-4e03-b078-939209858144",
              "port=8443",
              "epoch=12",
              "vectors=42",
              "fp=abcdef1234567890",
            ]),
          },
        ],
      },
    ]);

    const mdns = new MdnsDiscovery({ timeoutMs: 50, mdnsFactory: factory });
    const peers = await mdns.discover();

    expect(peers).toHaveLength(1);
    expect(peers[0].url).toBe("https://cognitum-61bc.local:8443");
    expect(peers[0].deviceId).toBe("ad7d7e7b-56e7-4e03-b078-939209858144");

    await mdns.close();
  });

  it("de-duplicates peers and supports SeedClient.create() + rediscover()", async () => {
    // First query: two distinct peers (one in additionals to exercise
    // both record arrays). Second query (triggered by rediscover): only
    // one peer remains on the network.
    const first: StubPacket = {
      answers: [
        {
          name: "cognitum-aaaa._cognitum._tcp.local",
          type: "TXT",
          data: txtBuf(["id=aaaa", "port=8443"]),
        },
      ],
      additionals: [
        {
          name: "cognitum-bbbb._cognitum._tcp.local",
          type: "TXT",
          data: txtBuf(["id=bbbb", "port=8443"]),
        },
        // duplicate of aaaa — must be folded
        {
          name: "cognitum-aaaa._cognitum._tcp.local",
          type: "TXT",
          data: txtBuf(["id=aaaa", "port=8443"]),
        },
      ],
    };
    const second: StubPacket = {
      answers: [
        {
          name: "cognitum-bbbb._cognitum._tcp.local",
          type: "TXT",
          data: txtBuf(["id=bbbb", "port=8443"]),
        },
      ],
    };

    // Single stub that returns `first` on the first query and `second`
    // on any subsequent query. That way we can exercise the rediscover
    // path without rebuilding the provider.
    let callCount = 0;
    const factory: ConstructorParameters<
      typeof MdnsDiscovery
    >[0]["mdnsFactory"] = () => {
      const listeners: Array<(p: StubPacket) => void> = [];
      return {
        query(): void {
          const packet = callCount === 0 ? first : second;
          callCount += 1;
          setImmediate(() => {
            for (const l of listeners) l(packet);
          });
        },
        on(event: string, cb: (p: StubPacket) => void): void {
          if (event === "response") listeners.push(cb);
        },
        removeListener(event: string, cb: (p: StubPacket) => void): void {
          if (event !== "response") return;
          const i = listeners.indexOf(cb);
          if (i >= 0) listeners.splice(i, 1);
        },
        destroy(cb?: () => void): void {
          cb?.();
        },
      };
    };

    const mdns = new MdnsDiscovery({ timeoutMs: 50, mdnsFactory: factory });

    // End-to-end: SeedClient.create() consumes the provider (first
    // query → two peers) and rediscover() re-queries it (second query
    // → one peer).
    const client = await SeedClient.create({
      endpoints: mdns,
      tls: { insecure: true },
      fetch: (async () => new Response("{}")) as unknown as typeof fetch,
    });
    expect(
      client
        .peers()
        .map((p) => p.key)
        .sort(),
    ).toEqual([
      "https://cognitum-aaaa.local:8443",
      "https://cognitum-bbbb.local:8443",
    ]);

    const maybePromise = client.rediscover();
    expect(maybePromise).toBeInstanceOf(Promise);
    await maybePromise;

    expect(client.peers().map((p) => p.key)).toEqual([
      "https://cognitum-bbbb.local:8443",
    ]);

    client.close();
    await mdns.close();
  });

  it("close() tears down the underlying socket and ignores non-matching records", async () => {
    const { factory, destroyed } = makeStubFactory([
      {
        answers: [
          // Wrong service type — must be filtered out.
          {
            name: "printer._printer._tcp.local",
            type: "TXT",
            data: txtBuf(["make=hp"]),
          },
          // Right type but non-TXT — ignored.
          {
            name: "cognitum-xxxx._cognitum._tcp.local",
            type: "PTR",
            data: "cognitum-xxxx._cognitum._tcp.local",
          },
          // Matching TXT: must be picked up.
          {
            name: "cognitum-yyyy._cognitum._tcp.local",
            type: "TXT",
            data: txtBuf(["id=yyyy", "port=9443"]),
          },
        ],
      },
    ]);

    const mdns = new MdnsDiscovery({ timeoutMs: 50, mdnsFactory: factory });
    const peers = await mdns.discover();

    expect(peers).toHaveLength(1);
    expect(peers[0].url).toBe("https://cognitum-yyyy.local:9443");
    expect(peers[0].deviceId).toBe("yyyy");

    await mdns.close();
    expect(destroyed()).toBe(true);
  });
});
