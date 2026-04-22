/** GET /api/v1/custody/epoch — Phase 1 resource. */

export interface CustodyEpoch extends Record<string, unknown> {
  epoch: number;
}

type RequestFn = <T>(
  method: string,
  path: string,
  opts?: { idempotent?: boolean },
) => Promise<T>;

export interface CustodyResource {
  /** GET /api/v1/custody/epoch — WiFi-read allowlist. */
  epoch(): Promise<CustodyEpoch>;
}

export function makeCustodyResource(request: RequestFn): CustodyResource {
  return {
    epoch: () =>
      request<CustodyEpoch>("GET", "/api/v1/custody/epoch", {
        idempotent: true,
      }),
  };
}
