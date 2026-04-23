/**
 * `ExplicitDiscovery` unit tests (ADR-0016a §D6).
 *
 * The explicit provider is the Phase 1 default — it's a trivial wrapper
 * but the tests pin the normalisation invariants (trailing-slash strip,
 * non-http(s) rejection) that the rest of the pipeline relies on.
 */

import { describe, it, expect } from "vitest";
import { ExplicitDiscovery } from "../../../src/seed/discovery/explicit.js";
import { ConfigError } from "../../../src/errors.js";

describe("ExplicitDiscovery (ADR-0016a §D6)", () => {
  it("wraps a single URL string into a one-peer discovery result", async () => {
    const provider = new ExplicitDiscovery("https://seed-a.test:8443/");
    const peers = await provider.discover();
    expect(peers).toHaveLength(1);
    expect(peers[0].url).toBe("https://seed-a.test:8443");
    // Returned list must be a copy — mutating it should not affect
    // subsequent discover() calls.
    peers[0].url = "https://tampered";
    const peers2 = await provider.discover();
    expect(peers2[0].url).toBe("https://seed-a.test:8443");
  });

  it("wraps an array of URLs preserving order and rejects invalid input", async () => {
    const provider = new ExplicitDiscovery([
      "https://seed-a.test:8443",
      "https://seed-b.test:8443/",
    ]);
    const peers = await provider.discover();
    expect(peers.map((p) => p.url)).toEqual([
      "https://seed-a.test:8443",
      "https://seed-b.test:8443",
    ]);

    expect(() => new ExplicitDiscovery([])).toThrow(ConfigError);
    expect(
      () => new ExplicitDiscovery(["https://ok", ""] as unknown as string[]),
    ).toThrow(ConfigError);
    expect(() => new ExplicitDiscovery("ftp://bad")).toThrow(ConfigError);
  });
});
