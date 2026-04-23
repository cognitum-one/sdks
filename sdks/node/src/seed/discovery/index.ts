/**
 * Seed discovery providers (ADR-0016a §D6, ADR-0016b §"Discovery providers").
 *
 * Barrel re-export for the discovery surface. mDNS lives in a separate
 * subpath (`@cognitum/sdk/seed/discovery/mdns`) so the wire library
 * stays an opt-in dep.
 */

export type { DiscoveryProvider, DiscoveredPeer } from "./types.js";
export { ExplicitDiscovery } from "./explicit.js";
