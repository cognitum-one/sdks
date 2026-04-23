/**
 * Per-peer dispatcher cache — one undici Agent per peer, re-used across
 * every request to that peer. ADR-0015c Phase 3 §fp= cert pinning calls
 * this out explicitly: each `new Agent()` allocates a TLS session cache
 * and a keep-alive pool, so rebuilding per request would waste both
 * CPU (re-handshakes) and memory.
 */

import { describe, it, expect } from "vitest";
import { Agent } from "undici";
import { buildPeerDispatcherFactory } from "../../../src/seed/transport.js";
import { PeerSet } from "../../../src/seed/peers.js";

describe("transport — per-peer Agent cache (ADR-0015c Phase 3)", () => {
  it("same peer yields the same Agent across 5 calls (and distinct peers get distinct Agents)", () => {
    const factory = buildPeerDispatcherFactory({
      insecure: false,
      ca: undefined,
    });
    const set = new PeerSet(
      ["https://seed-a.test:8443", "https://seed-b.test:8443"],
      [{ tlsFingerprint: "abcdef1234567890" }, { tlsFingerprint: "0123456789abcdef" }],
    );
    const [peerA, peerB] = set.snapshot();

    const a1 = factory(peerA);
    const a2 = factory(peerA);
    const a3 = factory(peerA);
    const a4 = factory(peerA);
    const a5 = factory(peerA);
    expect(a1).toBeInstanceOf(Agent);
    // Identity — not just equality. Same Agent instance every call.
    expect(a2).toBe(a1);
    expect(a3).toBe(a1);
    expect(a4).toBe(a1);
    expect(a5).toBe(a1);

    // Distinct peer → distinct Agent (still cached per-peer).
    const b1 = factory(peerB);
    const b2 = factory(peerB);
    expect(b1).toBeInstanceOf(Agent);
    expect(b1).not.toBe(a1);
    expect(b2).toBe(b1);

    // Peers without fingerprints get undefined — no Agent allocated.
    const plainSet = new PeerSet(["https://plain.test:8443"]);
    expect(factory(plainSet.pick())).toBeUndefined();
  });
});
