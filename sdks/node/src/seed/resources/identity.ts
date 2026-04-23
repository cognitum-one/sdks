/** GET /api/v1/identity — Phase 1 resource. */

import type { CallOptions } from "../callOptions.js";

export interface SeedIdentity extends Record<string, unknown> {
  device_id: string;
  /** Public key in hex or base64 — seed-dependent. */
  public_key?: string;
  firmware_version?: string;
  epoch?: number;
}

type RequestFn = <T>(
  method: string,
  path: string,
  opts?: CallOptions & { idempotent?: boolean },
) => Promise<T>;

export interface IdentityResource {
  (opts?: CallOptions): Promise<SeedIdentity>;
  get(opts?: CallOptions): Promise<SeedIdentity>;
}

export function makeIdentityResource(request: RequestFn): IdentityResource {
  const fn = ((opts?: CallOptions) =>
    request<SeedIdentity>("GET", "/api/v1/identity", {
      idempotent: true,
      ...(opts ?? {}),
    })) as IdentityResource;
  fn.get = fn;
  return fn;
}
