/**
 * Result and metadata envelope (ADR-0024a §D4). Type-only this pass — the
 * receipt/drift-comparison logic described in §D4's "body and headers
 * duplicate receipt fields" paragraph is deferred to the follow-up issue
 * that lands ADR-0024b's `MetaLlmReceipt`.
 */

/**
 * Placeholder for ADR-0024b's `MetaLlmReceipt`. Kept as `unknown` rather than
 * `Record<string, unknown>` so callers cannot accidentally treat an absent
 * receipt as a shaped, empty object (ADR-0024a §D4: "Missing metadata
 * remains missing").
 */
export type MetaLlmReceipt = unknown;

/** Per-response metadata carried alongside every {@link MetaLlmResult} (ADR-0024a §D4). */
export interface MetaLlmResponseMeta {
  requestId: string;
  protocolVersion?: string;
  httpStatus: number;
  retryAfterMs?: number;
  idempotentReplay?: boolean;
  receipt?: MetaLlmReceipt;
  warnings?: string[];
  unknownHeaders?: Record<string, string>;
}

/** Envelope wrapping every MetaLlmClient operation result (ADR-0024a §D4). */
export interface MetaLlmResult<T> {
  data: T;
  meta: MetaLlmResponseMeta;
}
