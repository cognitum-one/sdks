/**
 * `ExplicitDiscovery` — trivial {@link DiscoveryProvider} that wraps a
 * caller-supplied list of endpoint URLs. Used internally so the rest of
 * the `SeedClient` pipeline can assume it always has a provider, not a
 * mixed `string | string[] | DiscoveryProvider` union.
 *
 * Explicit-list discovery is the Phase 1 required mode (ADR-0016a §D6);
 * mDNS is Phase 1.5 opt-in.
 */

import { ConfigError } from "../../errors.js";
import { normaliseBaseUrl } from "../peers.js";
import type { DiscoveryProvider, DiscoveredPeer } from "./types.js";

/**
 * Wrap a single URL or an array of URLs into a {@link DiscoveryProvider}.
 * URLs are normalised via {@link normaliseBaseUrl} — trailing slashes
 * stripped, non-http(s) schemes rejected with {@link ConfigError}.
 */
export class ExplicitDiscovery implements DiscoveryProvider {
  private readonly peers: DiscoveredPeer[];

  constructor(endpoints: string | readonly string[]) {
    const list = Array.isArray(endpoints) ? endpoints : [endpoints];
    if (list.length === 0) {
      throw new ConfigError("ExplicitDiscovery requires at least one endpoint");
    }
    this.peers = list.map((url, idx) => {
      if (typeof url !== "string" || !url.trim()) {
        throw new ConfigError(
          `endpoints[${idx}] must be a non-empty URL string`,
        );
      }
      return { url: normaliseBaseUrl(url) };
    });
  }

  async discover(): Promise<DiscoveredPeer[]> {
    // Return a fresh copy so callers can't mutate our internal list.
    return this.peers.map((p) => ({ ...p }));
  }
}
