/** Capability negotiation (ADR-0019 §D6). Type-only scaffolding — issue #52 / M1. */

/** Where a {@link CapabilitySet} came from. */
export type CapabilitySource = "server" | "static-compatibility-table";

/**
 * Runtime-advertised, versioned support for a named behavior.
 *
 * Unknown product versions MUST receive the intersection of proven-safe
 * capabilities, never the union (ADR-0019 §D6).
 */
export interface CapabilitySet {
  product: string;
  productVersion: string;
  protocol: string;
  protocolVersion: string;
  features: Record<string, boolean>;
  limitations: string[];
  authMethods: string[];
  source: CapabilitySource;
}
