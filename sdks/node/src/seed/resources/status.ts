/** GET /api/v1/status — Phase 1 resource. */

import type { CallOptions } from "../callOptions.js";

/** Wire-verified response shape (2026-04-22 against seed v0.20.0). */
export interface SeedStatus extends Record<string, unknown> {
  device_id: string;
  uptime_secs: number;
  epoch: number;
  total_vectors: number;
  deleted_vectors: number;
  file_size_bytes: number;
  dimension: number;
  paired: boolean;
  roles: string[];
  /** Optional — present on newer firmwares. */
  witness_chain_length?: number;
}

/** Request signature exposed by `SeedClient`. */
type RequestFn = <T>(
  method: string,
  path: string,
  opts?: CallOptions & { idempotent?: boolean },
) => Promise<T>;

export interface StatusResource {
  /** Fetch seed status (idempotent, WiFi-allowlist endpoint). */
  (opts?: CallOptions): Promise<SeedStatus>;
  /** Alias: `client.status()` reads ergonomically as a call OR member. */
  get(opts?: CallOptions): Promise<SeedStatus>;
}

export function makeStatusResource(request: RequestFn): StatusResource {
  const fn = ((opts?: CallOptions) =>
    request<SeedStatus>("GET", "/api/v1/status", {
      idempotent: true,
      ...(opts ?? {}),
    })) as StatusResource;
  fn.get = fn;
  return fn;
}
