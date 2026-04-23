/** GET /api/v1/witness/chain — Phase 1 resource. */

import type { CallOptions } from "../callOptions.js";

export interface WitnessEntry extends Record<string, unknown> {
  epoch: number;
  action?: string;
  signature?: string;
  timestamp?: string;
}

export interface WitnessChain extends Record<string, unknown> {
  entries?: WitnessEntry[];
  length?: number;
  head?: string;
}

type RequestFn = <T>(
  method: string,
  path: string,
  opts?: CallOptions & { idempotent?: boolean },
) => Promise<T>;

export interface WitnessResource {
  /** GET /api/v1/witness/chain — WiFi-read allowlist. */
  chain(opts?: CallOptions): Promise<WitnessChain>;
}

export function makeWitnessResource(request: RequestFn): WitnessResource {
  return {
    chain: (opts) =>
      request<WitnessChain>("GET", "/api/v1/witness/chain", {
        idempotent: true,
        ...(opts ?? {}),
      }),
  };
}
