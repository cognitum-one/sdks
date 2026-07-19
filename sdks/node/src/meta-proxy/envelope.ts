/**
 * Result and metadata envelope (ADR-0025a §D3).
 *
 * Deliberately its OWN shape rather than a reuse of `MetaLlmResult`
 * (`../meta-llm/envelope.js`) — ADR-0025a §D3 specifies distinct fields
 * (`productVersion`, `routingReceipt`, `upstreamReceipt`) that `MetaLlmResult`
 * does not have, reflecting that every Proxy response must be able to carry
 * plane-routing evidence (§D4) that a direct Meta LLM response never needs.
 */

import type { MetaProxyRoutingReceipt } from "./status.js";

/**
 * Placeholder for an upstream (Cognitum-cloud) receipt forwarded through the
 * Proxy (ADR-0025a §D7, deferred). Kept as `unknown` rather than
 * `Record<string, unknown>` so callers cannot treat an absent receipt as a
 * shaped, empty object — same rationale as `MetaLlmReceipt`.
 */
export type MetaProxyUpstreamReceipt = unknown;

/** Per-response metadata carried alongside every {@link MetaProxyResult} (ADR-0025a §D3). */
export interface MetaProxyResponseMeta {
  requestId: string;
  productVersion?: string;
  protocolVersion?: string;
  httpStatus: number;
  /**
   * Seconds until retry is safe, per the standard `Retry-After` semantics —
   * note this is `retryAfter`, NOT `retryAfterMs` like `MetaLlmResponseMeta`
   * (ADR-0025a §D3 names the field `retry_after`, without a `_ms` suffix).
   */
  retryAfter?: number;
  /**
   * Plane-routing evidence for this response (ADR-0025a §D4). Populated
   * once inference operations exist (§D7) — `status()`/`capabilities()`
   * this pass do not attach one, since routing receipts describe an
   * inference call's plane selection, not the status endpoint itself.
   */
  routingReceipt?: MetaProxyRoutingReceipt;
  upstreamReceipt?: MetaProxyUpstreamReceipt;
  warnings?: string[];
  unknownHeaders?: Record<string, string>;
}

/** Envelope wrapping every MetaProxyClient operation result (ADR-0025a §D3). */
export interface MetaProxyResult<T> {
  data: T;
  meta: MetaProxyResponseMeta;
}

/**
 * Response headers already surfaced through a typed {@link MetaProxyResponseMeta}
 * field, plus standard HTTP framing/entity headers that would otherwise flood
 * `unknownHeaders` with noise on every single response (issue #92). Compared
 * case-insensitively (`Headers` keys are already lowercased by the Fetch API).
 * Everything else observed on the response is preserved under
 * `unknownHeaders` rather than silently dropped -- same "preserve what this
 * SDK doesn't yet model" convention used elsewhere in this codebase (e.g.
 * `MetaLlmReceipt.raw`).
 */
const KNOWN_RESPONSE_HEADERS = new Set([
  "x-cognitum-product-version",
  "x-cognitum-protocol-version",
  "x-cognitum-request-id",
  "retry-after",
  "content-type",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "date",
  "server",
  "vary",
  "location",
]);

/**
 * Collect every response header NOT in {@link KNOWN_RESPONSE_HEADERS} into
 * the `unknownHeaders` map. Returns `undefined` (not an empty object) when
 * nothing unrecognized was present, matching this codebase's "absent means
 * absent" convention elsewhere.
 */
export function collectUnknownHeaders(headers: Headers): Record<string, string> | undefined {
  const unknown: Record<string, string> = {};
  // `Headers.forEach` (not `.entries()`/`for...of`) — this project's
  // `tsconfig.json` lib list is `["ES2022", "DOM"]` without `DOM.Iterable`,
  // so `Headers` isn't typed as iterable here, but `forEach` is part of the
  // base (non-iterable) `DOM` lib and works identically.
  headers.forEach((value, name) => {
    if (KNOWN_RESPONSE_HEADERS.has(name.toLowerCase())) return;
    unknown[name.toLowerCase()] = value;
  });
  return Object.keys(unknown).length > 0 ? unknown : undefined;
}
