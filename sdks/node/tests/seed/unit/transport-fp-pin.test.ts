/**
 * TLS cert-fingerprint pinning (ADR-0015c Phase 3 §fp= cert pinning).
 *
 * Covers:
 *  1. Matching fingerprint → `checkServerIdentity` accepts (returns undefined).
 *  2. Mismatched fingerprint → returns an Error with code TLS_PIN_ERROR.
 *  3. `tls.insecure` still works when no fingerprint is set (back-compat).
 *  4. A pin failure classifies as `TlsPinError` even when wrapped in
 *     fetch's generic `TypeError: fetch failed` — no cycle, no insecure
 *     fallback.
 *
 * The pin comparator is tested directly against stubbed cert objects so
 * we don't need a TLS handshake. Full end-to-end (real HTTPS server) is
 * covered by live-seed integration tests when mDNS is available.
 */

import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  buildPeerDispatcherFactory,
  buildPinnedAgent,
  classifyPinFailure,
  makePinCheckServerIdentity,
} from "../../../src/seed/transport.js";
import { TlsPinError, NetworkError } from "../../../src/errors.js";
import { SeedClient } from "../../../src/seed/client.js";
import { PeerSet } from "../../../src/seed/peers.js";

// Deterministic fake DER body — SHA-256 hex is computed below so the
// fingerprint we pin against is numerically correct.
const fakeDer = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);
const fakeDerSha = createHash("sha256").update(fakeDer).digest("hex");
const fakePrefix16 = fakeDerSha.slice(0, 16); // seed truncates to 16 hex chars

describe("transport — fp= TLS pinning (ADR-0015c Phase 3)", () => {
  it("peer with matching fingerprint → checkServerIdentity accepts (undefined)", () => {
    const check = makePinCheckServerIdentity(
      "https://seed.local:8443",
      fakePrefix16,
    );
    // Pass a fake "peer cert" shaped like Node's PeerCertificate.
    const accepted = check("seed.local", { raw: fakeDer });
    expect(accepted).toBeUndefined();

    // Full-length match also works (future firmware may advertise 64 hex).
    const checkFull = makePinCheckServerIdentity(
      "https://seed.local:8443",
      fakeDerSha,
    );
    expect(checkFull("seed.local", { raw: fakeDer })).toBeUndefined();

    // And buildPinnedAgent returns an actual undici Agent.
    const agent = buildPinnedAgent(
      "https://seed.local:8443",
      fakePrefix16,
    );
    expect(agent).toBeDefined();
    expect(typeof agent.close).toBe("function");
  });

  it("short `expected` fp (< 16 hex) rejected by defense-in-depth at match layer", () => {
    // Even if a caller bypasses parseFingerprint() and hands a short
    // prefix directly to buildPinnedAgent (e.g. a hand-rolled PeerSet),
    // makePinCheckServerIdentity MUST reject it. Prevents
    // fp=ab → matches 1/256 of any cert via startsWith. See security
    // audit C1.
    const shortCheck = makePinCheckServerIdentity(
      "https://seed.local:8443",
      "ab", // would have matched 1/256 of fakeDer's SHA-256
    );
    const rejected = shortCheck("seed.local", { raw: fakeDer });
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error & { code?: string }).code).toBe("TLS_PIN_ERROR");

    // Odd length (not whole bytes) also rejected.
    const oddCheck = makePinCheckServerIdentity(
      "https://seed.local:8443",
      "abc", // 3 hex chars, odd — cannot be a real byte-prefix
    );
    expect(oddCheck("seed.local", { raw: fakeDer })).toBeInstanceOf(Error);

    // Over-long (>64 hex) also rejected — would-be SHA-512 or padded.
    const longCheck = makePinCheckServerIdentity(
      "https://seed.local:8443",
      "a".repeat(66),
    );
    expect(longCheck("seed.local", { raw: fakeDer })).toBeInstanceOf(Error);
  });

  it("peer with mismatched fingerprint → Error marked TLS_PIN_ERROR, classifies as TlsPinError", () => {
    const check = makePinCheckServerIdentity(
      "https://seed.local:8443",
      "abcdef1234567890", // does NOT match fakeDerSha
    );
    const rejected = check("seed.local", { raw: fakeDer });
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error & { code?: string }).code).toBe(
      "TLS_PIN_ERROR",
    );

    // classifyPinFailure unwraps the marker into a typed TlsPinError,
    // even when undici re-wraps it into a "fetch failed" TypeError.
    const wrapped = new TypeError("fetch failed");
    (wrapped as Error & { cause?: unknown }).cause = rejected;
    const pin = classifyPinFailure(wrapped);
    expect(pin).toBeInstanceOf(TlsPinError);
    expect(pin?.peerKey).toBe("https://seed.local:8443");
    expect(pin?.expectedFingerprint).toBe("abcdef1234567890");
    expect(pin?.actualFingerprint).toBe(fakeDerSha);

    // Unrelated error → classifier returns undefined (does NOT
    // misclassify a generic NetworkError as a pin failure).
    expect(classifyPinFailure(new Error("ECONNREFUSED"))).toBeUndefined();
    expect(classifyPinFailure(new NetworkError("boom"))).toBeUndefined();
  });

  it("peer with NO fingerprint + tls.insecure → insecure path still works (back-compat)", () => {
    // When no peer has a fingerprint, buildPeerDispatcherFactory returns
    // undefined for every peer — meaning the request flows through the
    // client-wide dispatcher (which honours tls.insecure per issue #18).
    const factory = buildPeerDispatcherFactory({
      insecure: true,
      ca: undefined,
    });
    const set = new PeerSet(["https://plain.test:8443"]);
    const peer = set.pick();
    expect(peer.tlsFingerprint).toBeUndefined();
    expect(factory(peer)).toBeUndefined();

    // And the tls.ca branch short-circuits the factory entirely —
    // user-supplied CA wins regardless of per-peer fingerprints.
    const caFactory = buildPeerDispatcherFactory({
      insecure: false,
      ca: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
    });
    const setWithFp = new PeerSet(
      ["https://pinned.test:8443"],
      [{ tlsFingerprint: fakePrefix16 }],
    );
    // Even with a fingerprint, tls.ca precedence means the factory
    // returns undefined — the client-wide CA dispatcher handles it.
    expect(caFactory(setWithFp.pick())).toBeUndefined();
  });

  it("fingerprint mismatch propagates as TlsPinError from SeedClient.request (no cycle, no insecure fallback)", async () => {
    // Stub fetch that throws a TLS_PIN_ERROR-shaped error the same way
    // undici would when checkServerIdentity rejects. We assert the
    // client surfaces TlsPinError rather than cycling to the "next"
    // peer or degrading to a NetworkError.
    let called = 0;
    const stubFetch = (async () => {
      called += 1;
      const inner = new Error(
        "TLS fingerprint mismatch for https://seed.local:8443: expected abcdef, got deadbeef",
      ) as Error & {
        code?: string;
        peerKey?: string;
        expectedFingerprint?: string;
        actualFingerprint?: string;
      };
      inner.code = "TLS_PIN_ERROR";
      inner.peerKey = "https://seed.local:8443";
      inner.expectedFingerprint = "abcdef";
      inner.actualFingerprint = "deadbeef";
      const outer = new TypeError("fetch failed");
      (outer as Error & { cause?: unknown }).cause = inner;
      throw outer;
    }) as unknown as typeof fetch;

    // Single-peer client with insecure=true — if pinning fell back to
    // insecure we'd see the stub return success. Instead the pin
    // failure must surface immediately.
    const client = new SeedClient({
      endpoints: "https://seed.local:8443",
      tls: { insecure: true },
      retries: 3, // prove we do NOT retry a pin failure
      fetch: stubFetch,
    });

    await expect(client.status.get()).rejects.toBeInstanceOf(TlsPinError);
    expect(called).toBe(1); // no cycling, no retry
  });
});
