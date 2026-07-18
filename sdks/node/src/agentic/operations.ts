/**
 * OperationHandle / OperationState and transport-neutral pagination /
 * event-stream primitives (ADR-0019 §D5, ADR-0023 §D9). Type-only
 * scaffolding — issue #52 / M1. No polling loop or event-stream
 * implementation ships in this pass.
 */

import type { AgenticError } from "./errors.js";

/** Native lifecycle states for a durable remote operation (ADR-0023 §D9). */
export type OperationState =
  | "pending"
  | "running"
  | "approval_required"
  | "completed"
  | "failed"
  | "cancelled"
  | "cancellation_requested";

/** A point-in-time view of a durable operation, including terminal failures. */
export interface OperationSnapshot<TResult = unknown> {
  id: string;
  state: OperationState;
  result?: TResult;
  error?: AgenticError;
  updatedAt: string;
}

/** Options controlling {@link OperationHandle.wait}. */
export interface WaitOptions {
  waitDeadlineMs?: number;
  pollIntervalMs?: number;
}

/** Options controlling {@link OperationHandle.events}. */
export interface EventStreamOptions {
  lastEventId?: string;
  idleTimeoutMs?: number;
}

/** A single durable-operation event (ADR-0023 §D6). */
export interface OperationEvent<TPayload = unknown> {
  id: string;
  type: string;
  sequence?: number;
  occurredAt: string;
  payload: TPayload;
}

/**
 * Common handle contract for remote batches, pods, and HarnessaaS jobs
 * (ADR-0023 §D9). `events` and `cancel` are only present when the product
 * capability set declares support — see ADR-0019 §D6.
 */
export interface OperationHandle<TResult = unknown> {
  readonly id: string;
  readonly product: string;
  readonly originBinding: string;
  readonly tenantBinding?: string;
  readonly createdAt: string;

  get(): Promise<OperationSnapshot<TResult>>;
  wait(options?: WaitOptions): Promise<OperationSnapshot<TResult>>;
  events?(options?: EventStreamOptions): AsyncIterable<OperationEvent>;
  cancel?(): Promise<OperationSnapshot<TResult>>;
  result(): Promise<TResult>;
}

/** Cursor-based page request, independent of transport (HTTP query, RPC field, etc.). */
export interface PageRequest {
  cursor?: string;
  limit?: number;
}

/** A single page of results. */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
}
