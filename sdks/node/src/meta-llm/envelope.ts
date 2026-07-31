/**
 * Result and metadata envelope (ADR-0024a §D4). The receipt/drift-
 * comparison logic described in §D4's "body and headers duplicate receipt
 * fields" paragraph remains deferred (still not implemented this pass —
 * only decoding a receipt already present on the response, not comparing
 * it against header/body duplicates), but `MetaLlmReceipt` itself is now
 * the concrete ADR-0024b §D3 shape (issue #59, D11 migration step 1)
 * rather than the earlier `unknown` placeholder.
 */

import type { MetaLlmReceipt } from "./types/receipt.js";
export type { MetaLlmReceipt } from "./types/receipt.js";

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
