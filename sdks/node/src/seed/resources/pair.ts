/** Pairing resource — POST/DELETE/GET on /api/v1/pair. */

import type { CallOptions } from "../callOptions.js";
import { SecretString } from "../tokenBook.js";

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

/**
 * Wire shape returned by `POST /api/v1/pair`. Raw JSON — the bare
 * pairing token is visible as `pairing_token`. Never expose this type
 * directly to callers; use {@link PairCreateResponse} instead, which
 * wraps the token in a {@link SecretString} so it cannot leak via
 * `JSON.stringify` / `console.log` / `util.inspect`.
 *
 * @internal
 */
interface PairCreateWireResponse {
  client_name: string;
  pairing_token: string;
  expires_at?: string;
}

/**
 * Typed response from {@link PairResource.create}. The pairing token is
 * wrapped in a {@link SecretString} — it redacts itself when serialised
 * (`JSON.stringify` → `"<redacted>"`), stringified, or inspected by
 * Node's `util.inspect`. Call `.reveal()` to obtain the raw string at
 * the one-and-only write site (e.g. `tokenBook.set(url, token)`).
 *
 * The plain-string `pairing_token` field is deliberately omitted — the
 * earlier shape where it appeared as a top-level string was removed to
 * close issue cognitum-one/sdks#15 (token leaks via default logging).
 */
export interface PairCreateResponse {
  /** Echoed client name (seed returns it verbatim). */
  client_name: string;
  /**
   * Redacted pairing token. Use `.reveal()` to get the raw string —
   * typically `book.set(peerUrl, response.token)`.
   */
  token: SecretString;
  /** ISO-8601 expiry, when the seed provided one. */
  expires_at?: string;
}

type RequestFn = <T>(
  method: string,
  path: string,
  opts?: CallOptions & {
    body?: unknown;
    idempotent?: boolean;
  },
) => Promise<T>;

export interface PairResource {
  /** GET /api/v1/pair/status — WiFi-read allowlist. */
  status(opts?: CallOptions): Promise<PairStatus>;
  /** POST /api/v1/pair — open pairing window must be active. */
  create(params: PairCreateParams, opts?: CallOptions): Promise<PairCreateResponse>;
  /** DELETE /api/v1/pair/{name} — revoke a named client. */
  delete(clientName: string, opts?: CallOptions): Promise<void>;
}

export function makePairResource(request: RequestFn): PairResource {
  return {
    status: (opts) =>
      request<PairStatus>("GET", "/api/v1/pair/status", {
        idempotent: true,
        ...(opts ?? {}),
      }),

    create: async (params, opts) => {
      if (!params || typeof params.clientName !== "string" || !params.clientName.trim()) {
        throw new TypeError("pair.create: `clientName` is required");
      }
      // Wire shape: seed expects `{ "client_name": "..." }`.
      const wire = await request<PairCreateWireResponse>("POST", "/api/v1/pair", {
        body: { client_name: params.clientName },
        idempotent: false,
        ...(opts ?? {}),
      });
      // Wrap the token in SecretString immediately so that even if the
      // caller logs the entire response, Node's `util.inspect` /
      // JSON.stringify will print `<redacted>` instead of the raw token.
      const rawToken = typeof wire?.pairing_token === "string" ? wire.pairing_token : "";
      const response: PairCreateResponse = {
        client_name: wire?.client_name ?? params.clientName,
        token: new SecretString(rawToken),
      };
      if (typeof wire?.expires_at === "string") {
        response.expires_at = wire.expires_at;
      }
      return response;
    },

    delete: async (clientName, opts) => {
      if (typeof clientName !== "string" || !clientName.trim()) {
        throw new TypeError("pair.delete: `clientName` is required");
      }
      await request<void>("DELETE", `/api/v1/pair/${encodeURIComponent(clientName)}`, {
        idempotent: true,
        ...(opts ?? {}),
      });
    },
  };
}
