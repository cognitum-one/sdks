/** Vector store — status / query / ingest. */

import type { CallOptions } from "../callOptions.js";

export interface StoreStatus extends Record<string, unknown> {
  total_vectors: number;
  deleted_vectors: number;
  dimension: number;
  file_size_bytes?: number;
  epoch?: number;
}

/**
 * Query payload — swarm-verified (2026-04-22): the seed expects
 * `{ vector: number[], k: number }`, NOT `{ query, k }`. An earlier
 * version of ADR-0015a mis-documented the field name; this binding is
 * the source of truth until the ADR is updated.
 */
export interface StoreQueryParams {
  vector: number[];
  k: number;
  /** Optional distance metric hint. */
  metric?: "cosine" | "euclidean" | "dot";
}

export interface StoreQueryHit extends Record<string, unknown> {
  id: number | string;
  distance: number;
  metadata?: Record<string, unknown>;
}

export interface StoreQueryResponse extends Record<string, unknown> {
  results: StoreQueryHit[];
  query_ms?: number;
}

export interface StoreIngestItem {
  /** Optional content-hash / user-supplied id. */
  id?: string;
  values: number[];
  metadata?: Record<string, unknown>;
}

export interface StoreIngestParams {
  vectors: StoreIngestItem[];
}

export interface StoreIngestResponse extends Record<string, unknown> {
  ingested: number;
  witness_chain_length?: number;
  epoch?: number;
}

type RequestFn = <T>(
  method: string,
  path: string,
  opts?: CallOptions & {
    body?: unknown;
    idempotent?: boolean;
  },
) => Promise<T>;

export interface StoreResource {
  /** GET /api/v1/store/status — WiFi-read allowlist. */
  status(opts?: CallOptions): Promise<StoreStatus>;
  /** POST /api/v1/store/query — treated as idempotent for retry purposes. */
  query(params: StoreQueryParams, opts?: CallOptions): Promise<StoreQueryResponse>;
  /** POST /api/v1/store/ingest — not idempotent; no retry on read-timeout. */
  ingest(params: StoreIngestParams, opts?: CallOptions): Promise<StoreIngestResponse>;
}

export function makeStoreResource(request: RequestFn): StoreResource {
  return {
    status: (opts) =>
      request<StoreStatus>("GET", "/api/v1/store/status", {
        idempotent: true,
        ...(opts ?? {}),
      }),

    query: (params, opts) => {
      if (!params || !Array.isArray(params.vector) || typeof params.k !== "number") {
        throw new TypeError("store.query: { vector: number[], k: number } required");
      }
      return request<StoreQueryResponse>("POST", "/api/v1/store/query", {
        body: {
          vector: params.vector,
          k: params.k,
          ...(params.metric ? { metric: params.metric } : {}),
        },
        idempotent: true, // read-only query; safe to retry on timeout
        ...(opts ?? {}),
      });
    },

    ingest: (params, opts) => {
      if (!params || !Array.isArray(params.vectors) || params.vectors.length === 0) {
        throw new TypeError("store.ingest: { vectors: StoreIngestItem[] } required (non-empty)");
      }
      return request<StoreIngestResponse>("POST", "/api/v1/store/ingest", {
        body: { vectors: params.vectors },
        idempotent: false,
        ...(opts ?? {}),
      });
    },
  };
}
