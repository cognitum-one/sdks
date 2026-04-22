/** Pairing resource — POST/DELETE/GET on /api/v1/pair. */

export interface PairStatus extends Record<string, unknown> {
  paired: boolean;
  client_count?: number;
  pairing_window_open?: boolean;
  window_remaining_secs?: number;
}

export interface PairCreateParams {
  /** Human-readable name for this client/device. */
  clientName: string;
}

export interface PairCreateResponse extends Record<string, unknown> {
  client_name: string;
  pairing_token: string;
  expires_at?: string;
}

type RequestFn = <T>(
  method: string,
  path: string,
  opts?: {
    body?: unknown;
    idempotent?: boolean;
  },
) => Promise<T>;

export interface PairResource {
  /** GET /api/v1/pair/status — WiFi-read allowlist. */
  status(): Promise<PairStatus>;
  /** POST /api/v1/pair — open pairing window must be active. */
  create(params: PairCreateParams): Promise<PairCreateResponse>;
  /** DELETE /api/v1/pair/{name} — revoke a named client. */
  delete(clientName: string): Promise<void>;
}

export function makePairResource(request: RequestFn): PairResource {
  return {
    status: () =>
      request<PairStatus>("GET", "/api/v1/pair/status", { idempotent: true }),

    create: async (params) => {
      if (!params || typeof params.clientName !== "string" || !params.clientName.trim()) {
        throw new TypeError("pair.create: `clientName` is required");
      }
      // Wire shape: seed expects `{ "client_name": "..." }`.
      return request<PairCreateResponse>("POST", "/api/v1/pair", {
        body: { client_name: params.clientName },
        idempotent: false,
      });
    },

    delete: async (clientName) => {
      if (typeof clientName !== "string" || !clientName.trim()) {
        throw new TypeError("pair.delete: `clientName` is required");
      }
      await request<void>("DELETE", `/api/v1/pair/${encodeURIComponent(clientName)}`, {
        idempotent: true,
      });
    },
  };
}
