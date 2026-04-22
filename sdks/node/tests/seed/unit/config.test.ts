import { describe, it, expect } from "vitest";
import { resolveSeedConfig } from "../../../src/seed/config.js";
import { ConfigError } from "../../../src/errors.js";

describe("resolveSeedConfig", () => {
  it("accepts a single-string endpoint", () => {
    const cfg = resolveSeedConfig({ endpoints: "https://cognitum.local:8443" });
    expect(cfg.baseUrl).toBe("https://cognitum.local:8443");
    expect(cfg.routing).toBe("pinned");
    expect(cfg.retries).toBe(3);
    expect(cfg.rateLimitRetry).toBe(true);
  });

  it("accepts a 1-element array", () => {
    const cfg = resolveSeedConfig({ endpoints: ["https://localhost:18443"] });
    expect(cfg.baseUrl).toBe("https://localhost:18443");
  });

  it("rejects a 2+ element array with Phase 1.5 note", () => {
    expect(() =>
      resolveSeedConfig({ endpoints: ["https://a:8443", "https://b:8443"] }),
    ).toThrow(/Phase 1\.5/);
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

  it("rejects `TokenBook` auth in Phase 1", () => {
    expect(() =>
      resolveSeedConfig({
        endpoints: "https://seed:8443",
        auth: { pairingToken: { laptop: "tok" } },
      }),
    ).toThrow(/TokenBook/);
  });

  it("accepts a string pairing token", () => {
    const cfg = resolveSeedConfig({
      endpoints: "https://seed:8443",
      auth: { pairingToken: "tok-abc" },
    });
    expect(cfg.pairingToken).toBe("tok-abc");
  });

  it("rejects a non-pinned routing strategy in Phase 1", () => {
    expect(() =>
      resolveSeedConfig({
        endpoints: "https://seed:8443",
        routing: "round-robin",
      }),
    ).toThrow(/Phase 1\.5/);
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

  it("defaults failover to retry-same on both connect-error and 5xx", () => {
    const cfg = resolveSeedConfig({ endpoints: "https://seed:8443" });
    expect(cfg.failover.onConnectError).toBe("retry-same");
    expect(cfg.failover.onStatus5xx).toBe("retry-same");
  });
});
