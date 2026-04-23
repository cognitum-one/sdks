/** OTA config + check-now — Phase 1 resources. */

import type { CallOptions } from "../callOptions.js";

export interface OtaConfig extends Record<string, unknown> {
  channel?: string;
  auto_update?: boolean;
  check_interval_secs?: number;
}

export interface OtaCheckResponse extends Record<string, unknown> {
  update_available?: boolean;
  current_version?: string;
  latest_version?: string;
  checked_at?: string;
}

type RequestFn = <T>(
  method: string,
  path: string,
  opts?: CallOptions & {
    body?: unknown;
    idempotent?: boolean;
  },
) => Promise<T>;

export interface OtaResource {
  /** GET /api/v1/ota/config — WiFi-read allowlist. */
  config(opts?: CallOptions): Promise<OtaConfig>;
  /** POST /api/v1/ota/check-now — idempotent probe; safe to retry. */
  checkNow(opts?: CallOptions): Promise<OtaCheckResponse>;
}

export function makeOtaResource(request: RequestFn): OtaResource {
  return {
    config: (opts) =>
      request<OtaConfig>("GET", "/api/v1/ota/config", {
        idempotent: true,
        ...(opts ?? {}),
      }),

    checkNow: (opts) =>
      request<OtaCheckResponse>("POST", "/api/v1/ota/check-now", {
        idempotent: true, // the seed merely re-checks; no destructive effect
        ...(opts ?? {}),
      }),
  };
}
