/**
 * Fingerprint parsing for mDNS TXT `fp=` (ADR-0015c Phase 3 §fp= cert
 * pinning, closes FINDING-28).
 *
 * The parser lives in `src/seed/discovery/mdns.ts` as `parseFingerprint`.
 * These tests pin the normalisation contract the transport layer relies
 * on — any change here affects the TLS pin comparison in
 * `src/seed/transport.ts:buildPinnedAgent`.
 */

import { describe, it, expect } from "vitest";
import {
  MdnsDiscovery,
  parseFingerprint,
} from "../../../src/seed/discovery/mdns.js";

interface StubPacket {
  answers?: Array<{ name: string; type: string; data: unknown }>;
  additionals?: Array<{ name: string; type: string; data: unknown }>;
}

const txtBuf = (entries: string[]): Uint8Array[] =>
  entries.map((e) => new TextEncoder().encode(e));

function makeStubFactory(
  responses: readonly StubPacket[],
): ConstructorParameters<typeof MdnsDiscovery>[0]["mdnsFactory"] {
  const factory = () => {
    const listeners: Array<(p: StubPacket) => void> = [];
    return {
      query(): void {
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
        cb?.();
      },
    };
  };
  return factory as unknown as ConstructorParameters<
    typeof MdnsDiscovery
  >[0]["mdnsFactory"];
}

describe("mDNS fp= parsing (ADR-0015c Phase 3 §fp= cert pinning)", () => {
  it("parses fp=sha256:<hex> into DiscoveredPeer.tlsFingerprint (lowercase, no colons)", async () => {
    // Three equivalent encodings of the same fingerprint: bare hex (seed
    // default, per discovery.rs:162), `sha256:` prefix (ADR-040
    // documented form), and legacy colon-separated form. All three
    // must normalise to the same canonical hex string.
    const factory = makeStubFactory([
      {
        answers: [
          {
            name: "cognitum-aaaa._cognitum._tcp.local",
            type: "TXT",
            data: txtBuf([
              "id=aaaa",
              "port=8443",
              "fp=sha256:ABCDEF1234567890",
            ]),
          },
          {
            name: "cognitum-bbbb._cognitum._tcp.local",
            type: "TXT",
            data: txtBuf(["id=bbbb", "port=8443", "fp=abcdef1234567890"]),
          },
          {
            name: "cognitum-cccc._cognitum._tcp.local",
            type: "TXT",
            data: txtBuf([
              "id=cccc",
              "port=8443",
              "fp=sha256:AB:CD:EF:12:34:56:78:90",
            ]),
          },
        ],
      },
    ]);

    const mdns = new MdnsDiscovery({ timeoutMs: 50, mdnsFactory: factory });
    const peers = await mdns.discover();
    await mdns.close();

    const byId = new Map(peers.map((p) => [p.deviceId ?? "", p]));
    expect(byId.get("aaaa")?.tlsFingerprint).toBe("abcdef1234567890");
    expect(byId.get("bbbb")?.tlsFingerprint).toBe("abcdef1234567890");
    expect(byId.get("cccc")?.tlsFingerprint).toBe("abcdef1234567890");
  });

  it("ignores malformed fp= values — peer still surfaces, tlsFingerprint undefined", async () => {
    const factory = makeStubFactory([
      {
        answers: [
          // odd hex length → rejected
          {
            name: "cognitum-odd._cognitum._tcp.local",
            type: "TXT",
            data: txtBuf(["id=odd", "port=8443", "fp=abc"]),
          },
          // non-hex chars → rejected
          {
            name: "cognitum-ghi._cognitum._tcp.local",
            type: "TXT",
            data: txtBuf(["id=ghi", "port=8443", "fp=sha256:ZZZZ"]),
          },
          // empty after prefix → rejected
          {
            name: "cognitum-emp._cognitum._tcp.local",
            type: "TXT",
            data: txtBuf(["id=emp", "port=8443", "fp=sha256:"]),
          },
        ],
      },
    ]);

    const mdns = new MdnsDiscovery({ timeoutMs: 50, mdnsFactory: factory });
    const peers = await mdns.discover();
    await mdns.close();

    expect(peers).toHaveLength(3);
    for (const p of peers) {
      expect(p.tlsFingerprint).toBeUndefined();
    }
  });

  it("rejects fp= below 16 hex chars (seed TXT minimum, 8 bytes of entropy)", () => {
    // Security: without a length floor, `fp=ab` is accepted by the old
    // parser and matches 1/256 of ANY self-signed cert because the
    // transport layer uses startsWith() against the actual SHA-256 hex.
    // An attacker on the tailnet / local LAN advertising `fp=ab` via
    // mDNS could brute-force a matching cert offline in seconds.
    //
    // The seed firmware truncates to 16 hex chars in its TXT record
    // (8 bytes → 64 bits of search space). Anything shorter is either
    // malformed or an adversarial short prefix. Reject.
    expect(parseFingerprint("ab")).toBeUndefined();
    expect(parseFingerprint("abcd")).toBeUndefined();
    expect(parseFingerprint("abcdef01")).toBeUndefined(); // 8 hex = 4 bytes
    expect(parseFingerprint("abcdef0123456789")).toBe("abcdef0123456789"); // 16 hex = floor
    expect(parseFingerprint("sha256:ab")).toBeUndefined();
    expect(parseFingerprint("ab:cd:ef")).toBeUndefined(); // 6 hex after colon-strip
  });

  it("rejects fp= above 64 hex chars (SHA-256 max, 32 bytes)", () => {
    // A valid SHA-256 is exactly 32 bytes = 64 lowercase hex chars.
    // Anything longer is either a padded attacker string or a different
    // hash algorithm — neither safe to accept as a pin.
    const sha256Max = "a".repeat(64);
    const overLong = "a".repeat(66);
    expect(parseFingerprint(sha256Max)).toBe(sha256Max);
    expect(parseFingerprint(overLong)).toBeUndefined();
    expect(parseFingerprint("a".repeat(128))).toBeUndefined(); // would-be SHA-512
  });

  it("missing fp= entry → DiscoveredPeer.tlsFingerprint is undefined", async () => {
    const factory = makeStubFactory([
      {
        answers: [
          {
            name: "cognitum-plain._cognitum._tcp.local",
            type: "TXT",
            data: txtBuf(["id=plain", "port=8443"]),
          },
        ],
      },
    ]);

    const mdns = new MdnsDiscovery({ timeoutMs: 50, mdnsFactory: factory });
    const peers = await mdns.discover();
    await mdns.close();

    expect(peers).toHaveLength(1);
    expect(peers[0].tlsFingerprint).toBeUndefined();
    // And ensure the exported helper agrees directly.
    expect(parseFingerprint(undefined)).toBeUndefined();
    expect(parseFingerprint("")).toBeUndefined();
  });
});
