/**
 * PeerSet unit tests (Phase 1.5).
 *
 * Mirrors the Rust `PeerSet` unit tests in `sdks/rust/src/seed/peers.rs`.
 * No HTTP here — the suite exercises the pure data structure.
 */

import { describe, it, expect } from "vitest";
import { ConfigError } from "../../../src/errors.js";
import {
  PeerSet,
  normaliseBaseUrl,
} from "../../../src/seed/peers.js";

describe("PeerSet", () => {
  it("rejects an empty endpoint list", () => {
    expect(() => new PeerSet([])).toThrow(ConfigError);
  });

  it("normalises URLs (strips trailing slashes, keeps port)", () => {
    const set = new PeerSet(["https://a:8443/", "https://b:8443"]);
    const peers = set.snapshot();
    expect(peers[0].baseUrl).toBe("https://a:8443");
    expect(peers[1].baseUrl).toBe("https://b:8443");
  });

  it("rejects a non-http(s) scheme", () => {
    expect(() => new PeerSet(["ftp://a:8443"])).toThrow(ConfigError);
  });

  it("isMesh() reflects peer count", () => {
    expect(new PeerSet(["https://a:8443"]).isMesh()).toBe(false);
    expect(new PeerSet(["https://a:8443", "https://b:8443"]).isMesh()).toBe(true);
  });

  it("pick() returns the first peer when all are healthy + latency-unknown", () => {
    const set = new PeerSet(["https://a:8443", "https://b:8443", "https://c:8443"]);
    expect(set.pick().key).toBe("https://a:8443");
  });

  it("pick() prefers the peer with the lowest EMA latency", () => {
    const set = new PeerSet(["https://a:8443", "https://b:8443"]);
    set.markSuccess("https://a:8443", 500);
    set.markSuccess("https://b:8443", 50);
    expect(set.pick().key).toBe("https://b:8443");
  });

  it("pick() prefers healthy over degraded over unhealthy", () => {
    const set = new PeerSet(["https://a:8443", "https://b:8443"]);
    set.markFailure("https://a:8443", "serviceUnavailable"); // unhealthy
    set.markSuccess("https://b:8443", 100);
    expect(set.pick().key).toBe("https://b:8443");
  });

  it("nextAfter() returns a different peer", () => {
    const set = new PeerSet(["https://a:8443", "https://b:8443"]);
    const first = set.pick();
    const next = set.nextAfter(first);
    expect(next).toBeDefined();
    expect(next!.key).not.toBe(first.key);
  });

  it("nextAfter() returns undefined on a one-peer set", () => {
    const set = new PeerSet(["https://a:8443"]);
    const only = set.pick();
    expect(set.nextAfter(only)).toBeUndefined();
  });

  it("markFailure(503) immediately marks peer unhealthy", () => {
    const set = new PeerSet(["https://a:8443"]);
    set.markFailure("https://a:8443", "serviceUnavailable");
    expect(set.snapshot()[0].state).toBe("unhealthy");
  });

  it("markFailure() degrades then goes unhealthy after 3 non-503 failures", () => {
    const set = new PeerSet(["https://a:8443"]);
    set.markFailure("https://a:8443", "network");
    expect(set.snapshot()[0].state).toBe("degraded");
    set.markFailure("https://a:8443", "server5xx");
    expect(set.snapshot()[0].state).toBe("degraded");
    set.markFailure("https://a:8443", "timeout");
    expect(set.snapshot()[0].state).toBe("unhealthy");
  });

  it("markSuccess() promotes degraded to healthy and clears counter", () => {
    const set = new PeerSet(["https://a:8443"]);
    set.markFailure("https://a:8443", "network");
    set.markFailure("https://a:8443", "network");
    expect(set.snapshot()[0].state).toBe("degraded");
    expect(set.snapshot()[0].consecutiveFailures).toBe(2);
    set.markSuccess("https://a:8443", 42);
    const p = set.snapshot()[0];
    expect(p.state).toBe("healthy");
    expect(p.consecutiveFailures).toBe(0);
    expect(p.latencyEmaMs).toBe(42);
  });

  it("findByKey() accepts canonical and trailing-slash forms", () => {
    const set = new PeerSet(["https://a:8443"]);
    expect(set.findByKey("https://a:8443")?.key).toBe("https://a:8443");
    expect(set.findByKey("https://a:8443/")?.key).toBe("https://a:8443");
    expect(set.findByKey("https://missing:8443")).toBeUndefined();
  });

  it("snapshot() is a shallow copy — mutating it doesn't touch internal state", () => {
    const set = new PeerSet(["https://a:8443"]);
    const snap = set.snapshot();
    snap[0].state = "unhealthy"; // external mutation
    expect(set.snapshot()[0].state).toBe("healthy");
  });
});

describe("normaliseBaseUrl", () => {
  it("strips trailing slashes", () => {
    expect(normaliseBaseUrl("https://seed:8443///")).toBe("https://seed:8443");
  });
  it("rejects malformed URLs", () => {
    expect(() => normaliseBaseUrl("not-a-url")).toThrow(ConfigError);
  });
  it("rejects non-http(s) schemes", () => {
    expect(() => normaliseBaseUrl("file:///tmp/seed")).toThrow(ConfigError);
  });
});
