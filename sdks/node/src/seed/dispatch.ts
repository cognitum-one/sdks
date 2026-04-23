/**
 * Dispatch outcome + HTTP status classifier for {@link SeedClient.request}.
 *
 * Kept in its own module so the failover state machine in `client.ts` stays
 * focused on the mesh-routing loop. The classifier here mirrors the Rust
 * `classify_status` / `dispatch_status_outcome` pair from
 * `sdks/rust/src/seed/client.rs` and the Phase 1 `mapHttpError` helper.
 */

import {
  AuthError,
  CognitumError,
  ConflictError,
  NotFoundError,
  NotImplementedError,
  RateLimitError,
  ServiceUnavailableError,
  ValidationError,
} from "../errors.js";
import { parseRetryAfterHeader, parseSeedRetryAfter } from "./retry.js";
import type { PeerErrorClass } from "./peers.js";

/** Dispatch outcome for a single HTTP attempt. */
export type DispatchOutcome<T> =
  | { kind: "ok"; value: T }
  | {
      kind: "err";
      disposition: "cycle" | "pin" | "surface";
      peerClass?: PeerErrorClass;
      retryHintMs?: number;
      error: CognitumError;
    };

/**
 * Translate an HTTP error response into a {@link DispatchOutcome}.
 *
 * - `cycle` → try `PeerSet.nextAfter`; fall through to ADR-0005 retry.
 * - `pin`   → 429; stay on the same peer, apply backoff.
 * - `surface` → auth / validation / not-found / 501; propagate.
 */
export async function classifyErrorResponse<T>(
  res: Response,
  path: string,
): Promise<DispatchOutcome<T>> {
  const rawBody = await res.text().catch(() => "");
  const parsed = tryJson(rawBody);
  const message =
    extractMessage(parsed) ?? res.statusText ?? `HTTP ${res.status}`;
  const status = res.status;

  switch (status) {
    case 400:
    case 422:
      return surface(new ValidationError(message));
    case 401:
      return surface(new AuthError(`unauthorized: ${message}`));
    case 403:
      return surface(new AuthError(`forbidden: ${message}`));
    case 404:
      return surface(new NotFoundError(message));
    case 409:
      return surface(new ConflictError(message));
    case 429: {
      const headerHint = parseRetryAfterHeader(res.headers.get("Retry-After"));
      const bodyHint = parseSeedRetryAfter(parsed);
      const retryAfterMs = headerHint ?? bodyHint ?? 1000;
      return {
        kind: "err",
        disposition: "pin",
        retryHintMs: retryAfterMs,
        error: new RateLimitError(retryAfterMs, message),
      };
    }
    case 501:
      return surface(new NotImplementedError(path, message));
    case 503: {
      const headerHint = parseRetryAfterHeader(res.headers.get("Retry-After"));
      return {
        kind: "err",
        disposition: "cycle",
        peerClass: "serviceUnavailable",
        retryHintMs: headerHint ?? undefined,
        error: new ServiceUnavailableError(headerHint, message),
      };
    }
    default:
      if (status >= 500) {
        return {
          kind: "err",
          disposition: "cycle",
          peerClass: "server5xx",
          error: new ServiceUnavailableError(
            undefined,
            `HTTP ${status}: ${message}`,
          ),
        };
      }
      return surface(
        new CognitumError(`HTTP ${status}: ${message}`, "API_ERROR", status),
      );
  }
}

/** Extract a human-readable message from the seed's JSON error envelope. */
export function extractMessage(parsed: unknown): string | undefined {
  if (parsed && typeof parsed === "object") {
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.error === "string") return rec.error;
    if (typeof rec.message === "string") return rec.message;
  }
  return undefined;
}

/** Parse JSON defensively — returns `undefined` on malformed input. */
export function tryJson(body: string): unknown {
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function surface<T>(error: CognitumError): DispatchOutcome<T> {
  return { kind: "err", disposition: "surface", error };
}
