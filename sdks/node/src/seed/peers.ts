/**
 * Peer routing and token-book stubs.
 *
 * Phase 1 supports a single endpoint; this module exists so that the
 * mesh-mode (Phase 1.5) surface can land without shifting imports.
 */

import type { SeedEndpoint, TokenBook } from "./config.js";

/** Phase 1 peer entry — one endpoint, one optional token. */
export interface Peer {
  baseUrl: string;
  /** Pairing token for this specific peer, or `undefined` if anonymous. */
  pairingToken?: string;
  /** Short label for logs (host:port). */
  label: string;
}

/** Build a single-peer list from a resolved config. */
export function singlePeer(baseUrl: string, pairingToken?: string): Peer[] {
  return [
    {
      baseUrl,
      pairingToken,
      label: labelFor(baseUrl),
    },
  ];
}

function labelFor(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return url;
  }
}

// Re-export config types so the Phase 1.5 mesh implementation has a
// stable symbol surface to import.
export type { SeedEndpoint, TokenBook };
