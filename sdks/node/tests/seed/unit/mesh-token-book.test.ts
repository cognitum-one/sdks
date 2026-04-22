/**
 * TokenBook + SecretString + pairAll unit tests (Phase 1.5).
 *
 * Mirrors `sdks/rust/src/seed/token_book.rs` tests.
 */

import { describe, it, expect } from "vitest";
import {
  InMemoryTokenBook,
  SecretString,
  pairAll,
} from "../../../src/seed/tokenBook.js";

describe("SecretString", () => {
  it("exposes the raw value only via reveal()", () => {
    const s = new SecretString("hunter2");
    expect(s.reveal()).toBe("hunter2");
    expect(s.length).toBe(7);
    expect(s.isEmpty()).toBe(false);
  });

  it("redacts in toString / toJSON / inspect", () => {
    const s = new SecretString("top-secret-token");
    const str = s.toString();
    expect(str).not.toContain("top-secret-token");
    expect(str).toMatch(/redacted/);

    const json = JSON.stringify({ token: s });
    expect(json).not.toContain("top-secret-token");
    expect(json).toContain("<redacted>");
  });

  it("rejects non-string values at construction", () => {
    // @ts-expect-error runtime guard under test
    expect(() => new SecretString(42)).toThrow(TypeError);
  });

  it("handles empty strings cleanly", () => {
    const s = new SecretString("");
    expect(s.isEmpty()).toBe(true);
    expect(s.length).toBe(0);
  });
});

describe("InMemoryTokenBook", () => {
  it("get/set/delete round-trip", () => {
    const book = new InMemoryTokenBook();
    expect(book.get("https://a:8443")).toBeUndefined();

    book.set("https://a:8443", new SecretString("tok-a"));
    expect(book.get("https://a:8443")?.reveal()).toBe("tok-a");
    expect(book.size).toBe(1);

    book.delete("https://a:8443");
    expect(book.get("https://a:8443")).toBeUndefined();
    expect(book.size).toBe(0);
  });

  it("normalises trailing slashes on keys", () => {
    const book = new InMemoryTokenBook();
    book.set("https://a:8443/", new SecretString("tok"));
    expect(book.get("https://a:8443")?.reveal()).toBe("tok");
    expect(book.get("https://a:8443/")?.reveal()).toBe("tok");
  });

  it("delete is idempotent", () => {
    const book = new InMemoryTokenBook();
    expect(() => book.delete("https://missing:8443")).not.toThrow();
  });

  it("fromEntries seeds multi-peer maps (raw string or SecretString)", () => {
    const book = InMemoryTokenBook.fromEntries([
      ["https://a:8443", "tok-a"],
      ["https://b:8443", new SecretString("tok-b")],
    ]);
    expect(book.get("https://a:8443")?.reveal()).toBe("tok-a");
    expect(book.get("https://b:8443")?.reveal()).toBe("tok-b");
    expect(book.size).toBe(2);
  });

  it("keeps per-peer entries distinct", () => {
    const book = new InMemoryTokenBook();
    book.set("https://a:8443", new SecretString("tok-a"));
    book.set("https://b:8443", new SecretString("tok-b"));
    expect(book.get("https://a:8443")?.reveal()).toBe("tok-a");
    expect(book.get("https://b:8443")?.reveal()).toBe("tok-b");
    expect(book.get("https://a:8443")?.reveal()).not.toBe(
      book.get("https://b:8443")?.reveal(),
    );
  });
});

describe("pairAll", () => {
  it("invokes the helper once per peer and stores tokens in order", async () => {
    const book = new InMemoryTokenBook();
    const peers = ["https://a:8443", "https://b:8443"];
    const calls: string[] = [];
    const helper = async (peerUrl: string, clientName: string) => {
      calls.push(`${peerUrl}|${clientName}`);
      return {
        client_name: clientName,
        token: `tok-${peerUrl.includes("a:") ? "a" : "b"}`,
      };
    };

    const results = await pairAll(peers, "cli", helper, book);

    expect(calls).toEqual([
      "https://a:8443|cli",
      "https://b:8443|cli",
    ]);
    expect(results).toHaveLength(2);
    expect(book.get("https://a:8443")?.reveal()).toBe("tok-a");
    expect(book.get("https://b:8443")?.reveal()).toBe("tok-b");
  });

  it("supports the `pairing_token` alias (seed wire name)", async () => {
    const book = new InMemoryTokenBook();
    const helper = async () => ({ pairing_token: "tok-wire" });
    await pairAll(["https://a:8443"], "cli", helper, book);
    expect(book.get("https://a:8443")?.reveal()).toBe("tok-wire");
  });

  it("propagates helper errors", async () => {
    const helper = async () => {
      throw new Error("pair failed");
    };
    await expect(
      pairAll(["https://a:8443"], "cli", helper),
    ).rejects.toThrow(/pair failed/);
  });

  it("rejects empty peer list", async () => {
    await expect(
      pairAll([], "cli", async () => ({ token: "tok" })),
    ).rejects.toThrow(/at least one peer/);
  });

  it("rejects blank clientName", async () => {
    await expect(
      pairAll(["https://a:8443"], "", async () => ({ token: "tok" })),
    ).rejects.toThrow(/clientName/);
  });
});
