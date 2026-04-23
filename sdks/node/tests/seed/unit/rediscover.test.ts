/**
 * `SeedClient.rediscover()` unit tests — ADR-0016a §D7 "rediscover" placeholder.
 *
 * Phase 2 implementation is a local state reset only: every peer returns to
 * `"healthy"`, `latencyEmaMs` clears, and `consecutiveFailures` zeros. When
 * mDNS discovery (ADR-0016a §D6) lands, the method will also re-run
 * discovery; the signature stays the same.
 */

import { describe, it, expect } from "vitest";
import { SeedClient } from "../../../src/seed/index.js";

describe("SeedClient.rediscover() (ADR-0016a §D7)", () => {
  it("resets every peer's state / latency / failure counter", () => {
    const client = new SeedClient({
      endpoints: ["https://a.test:8443", "https://b.test:8443"],
      tls: { insecure: true },
      fetch: (async () => new Response("{}")) as unknown as typeof fetch,
    });

    // Simulate prior activity — drive both peers into non-default state
    // via the PeerSet entry point (public through the underlying set).
    const set = client["peerSet"];
    set.markFailure("https://a.test:8443", "network");
    set.markFailure("https://a.test:8443", "network");
    set.markFailure("https://a.test:8443", "network"); // → unhealthy
    set.markSuccess("https://b.test:8443", 42); // → latencyEmaMs = 42
    set.markFailure("https://b.test:8443", "network"); // → degraded, counter=1

    // Sanity check the non-default state before the reset.
    const before = client.peers();
    const beforeA = before.find((p) => p.key === "https://a.test:8443")!;
    const beforeB = before.find((p) => p.key === "https://b.test:8443")!;
    expect(beforeA.state).toBe("unhealthy");
    expect(beforeA.consecutiveFailures).toBe(3);
    expect(beforeB.latencyEmaMs).toBe(42);
    expect(beforeB.consecutiveFailures).toBe(1);

    client.rediscover();

    const after = client.peers();
    for (const p of after) {
      expect(p.state).toBe("healthy");
      expect(p.latencyEmaMs).toBeUndefined();
      expect(p.consecutiveFailures).toBe(0);
    }
  });

  it("is idempotent — calling it again after a fresh reset is a no-op", () => {
    const client = new SeedClient({
      endpoints: ["https://a.test:8443", "https://b.test:8443"],
      tls: { insecure: true },
      fetch: (async () => new Response("{}")) as unknown as typeof fetch,
    });

    client.rediscover();
    const after1 = client.peers();

    client.rediscover();
    const after2 = client.peers();

    expect(after2).toEqual(after1);
    for (const p of after2) {
      expect(p.state).toBe("healthy");
      expect(p.latencyEmaMs).toBeUndefined();
      expect(p.consecutiveFailures).toBe(0);
    }
  });
});
