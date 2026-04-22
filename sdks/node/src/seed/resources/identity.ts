/** GET /api/v1/identity — Phase 1 resource. */

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
  opts?: { idempotent?: boolean },
) => Promise<T>;

export interface IdentityResource {
  (): Promise<SeedIdentity>;
  get(): Promise<SeedIdentity>;
}

export function makeIdentityResource(request: RequestFn): IdentityResource {
  const fn = (() =>
    request<SeedIdentity>("GET", "/api/v1/identity", {
      idempotent: true,
    })) as IdentityResource;
  fn.get = fn;
  return fn;
}
