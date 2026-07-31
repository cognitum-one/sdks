/** Result and metadata envelope for HarnessaaSClient operations (ADR-0027a). */

/** Per-response metadata carried alongside every {@link HarnessaaSResult}. */
export interface HarnessaaSResponseMeta {
  requestId: string;
  httpStatus: number;
  retryAfterMs?: number;
}

/** Envelope wrapping every HarnessaaSClient operation result. */
export interface HarnessaaSResult<T> {
  data: T;
  meta: HarnessaaSResponseMeta;
}
