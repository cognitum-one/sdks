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
