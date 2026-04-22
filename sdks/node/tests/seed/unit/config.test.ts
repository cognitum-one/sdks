import { describe, it, expect } from "vitest";
import { resolveSeedConfig } from "../../../src/seed/config.js";
import { ConfigError } from "../../../src/errors.js";

describe("resolveSeedConfig", () => {
  it("accepts a single-string endpoint", () => {
    const cfg = resolveSeedConfig({ endpoints: "https://cognitum.local:8443" });
    expect(cfg.baseUrl).toBe("https://cognitum.local:8443");
    expect(cfg.routing).toBe("session"); // Phase 1.5 default
    expect(cfg.retries).toBe(3);
    expect(cfg.rateLimitRetry).toBe(true);
  });

  it("accepts a 1-element array", () => {
    const cfg = resolveSeedConfig({ endpoints: ["https://localhost:18443"] });
    expect(cfg.baseUrl).toBe("https://localhost:18443");
  });

  it("accepts a 2+ element array (Phase 1.5 mesh mode)", () => {
    const cfg = resolveSeedConfig({
      endpoints: ["https://a:8443", "https://b:8443"],
    });
    expect(cfg.endpoints).toEqual(["https://a:8443", "https://b:8443"]);
    expect(cfg.baseUrl).toBe("https://a:8443");
  });

  it("rejects an empty endpoint list", () => {
    expect(() => resolveSeedConfig({ endpoints: [] })).toThrow(ConfigError);
  });

  it("rejects missing `endpoints`", () => {
    // @ts-expect-error intentional — runtime guard under test
    expect(() => resolveSeedConfig({})).toThrow(/endpoints/);
  });

  it("rejects a non-http(s) scheme", () => {
    expect(() =>
      resolveSeedConfig({ endpoints: "file:///tmp/seed" }),
    ).toThrow(ConfigError);
  });

  it("rejects a blank string", () => {
    expect(() => resolveSeedConfig({ endpoints: "   " })).toThrow(ConfigError);
  });

  it("rejects a malformed URL", () => {
    expect(() => resolveSeedConfig({ endpoints: "not-a-url" })).toThrow(ConfigError);
  });

  it("strips trailing slashes on the base URL", () => {
    const cfg = resolveSeedConfig({ endpoints: "https://seed:8443///" });
    expect(cfg.baseUrl).toBe("https://seed:8443");
  });

  it("accepts an inline pairingToken map (Phase 1.5 legacy shape)", () => {
    const cfg = resolveSeedConfig({
      endpoints: "https://seed:8443",
      auth: { pairingToken: { laptop: "tok" } },
    });
    expect(cfg.pairingToken).toBeUndefined();
    expect(cfg.pairingTokenMap).toEqual({ laptop: "tok" });
  });

  it("accepts a string pairing token", () => {
    const cfg = resolveSeedConfig({
      endpoints: "https://seed:8443",
      auth: { pairingToken: "tok-abc" },
    });
    expect(cfg.pairingToken).toBe("tok-abc");
  });

  it("accepts Phase 1.5 routing strategies", () => {
    const cfg = resolveSeedConfig({
      endpoints: "https://seed:8443",
      routing: "round-robin",
    });
    expect(cfg.routing).toBe("round-robin");
  });

  it("rejects unknown routing strategy", () => {
    expect(() =>
      resolveSeedConfig({
        endpoints: "https://seed:8443",
        // @ts-expect-error runtime guard under test
        routing: "nope",
      }),
    ).toThrow(/not recognised/);
  });

  it("defaults routing to session (Phase 1.5)", () => {
    const cfg = resolveSeedConfig({ endpoints: "https://seed:8443" });
    expect(cfg.routing).toBe("session");
  });

  it("defaults timeouts to ADR-0002 values (connect=5s, read=30s, total=60s)", () => {
    const cfg = resolveSeedConfig({ endpoints: "https://seed:8443" });
    expect(cfg.timeouts.connect).toBe(5_000);
    expect(cfg.timeouts.read).toBe(30_000);
    expect(cfg.timeouts.total).toBe(60_000);
  });

  it("honours caller-supplied timeouts", () => {
    const cfg = resolveSeedConfig({
      endpoints: "https://seed:8443",
      timeouts: { connect: 1000, read: 2000, total: 3000 },
    });
    expect(cfg.timeouts).toEqual({ connect: 1000, read: 2000, total: 3000 });
  });

  it("propagates the tls insecure flag", () => {
    const cfg = resolveSeedConfig({
      endpoints: "https://seed:8443",
      tls: { insecure: true },
    });
    expect(cfg.tls.insecure).toBe(true);
  });

  it("defaults failover to next-peer on both connect-error and 5xx (Phase 1.5)", () => {
    const cfg = resolveSeedConfig({ endpoints: "https://seed:8443" });
    expect(cfg.failover.onConnectError).toBe("next-peer");
    expect(cfg.failover.onStatus5xx).toBe("next-peer");
  });
});
