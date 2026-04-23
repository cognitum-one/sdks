/** GET /api/v1/custody/epoch — Phase 1 resource. */

import type { CallOptions } from "../callOptions.js";

export interface CustodyEpoch extends Record<string, unknown> {
  epoch: number;
}

type RequestFn = <T>(
  method: string,
  path: string,
  opts?: CallOptions & { idempotent?: boolean },
) => Promise<T>;

export interface CustodyResource {
  /** GET /api/v1/custody/epoch — WiFi-read allowlist. */
  epoch(opts?: CallOptions): Promise<CustodyEpoch>;
}

export function makeCustodyResource(request: RequestFn): CustodyResource {
  return {
    epoch: (opts) =>
      request<CustodyEpoch>("GET", "/api/v1/custody/epoch", {
        idempotent: true,
        ...(opts ?? {}),
      }),
  };
}
