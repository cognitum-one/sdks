/**
 * TelemetrySink / TelemetryEvent type-only stubs and safe semantic attribute
 * constants (ADR-0028 §D1, §D3). This is M6's first pass: it freezes the
 * sink contract, the event shape, and the `cognitum.*` attribute name
 * constants. Tracking issue #70 builds this out further into a real
 * emission pipeline -- trace propagation (§D2), the event/metric catalog
 * (§D4), dropped-event counting, and the content-free fallback diagnostic
 * hook all require the actual emit call sites this pass does not wire up.
 * No product client (meta_llm/meta_proxy/metaharness/harnessaas) emits
 * through this interface yet, and no OpenTelemetry adapter ships in this
 * pass.
 *
 * The one piece of real logic in this module is {@link NoopTelemetrySink}:
 * per §D1, "a no-op sink is the default" is a functional requirement, not a
 * placeholder, so it is a genuine (if trivial) implementation.
 *
 * Design decisions made in this pass where §D1 does not fully specify a
 * wire shape (recorded here since they are not literal ADR quotes):
 * - {@link TelemetrySeverity} is a conventional four-level set (`debug`,
 *   `info`, `warn`, `error`) matching common logging/OpenTelemetry severity
 *   tiers. The ADR does not enumerate exact values.
 * - {@link TraceContext} carries W3C `traceParent`/`traceState` strings
 *   (§D2's own vocabulary) so `TelemetryEvent.traceContext` has a stable
 *   optional shape for the §D2 follow-up to populate; nothing constructs a
 *   defined value in this pass.
 * - `attributes`/`measurements` are open `Record<string, unknown>` maps,
 *   matching how `ExecutionReceipt.usage` (`./receipts.ts`) already models
 *   an open, schema-free map elsewhere in this module.
 * - `TelemetrySink.flush` takes a `deadlineMs: number` (milliseconds)
 *   rather than a `Date`, so the same unit is usable verbatim across all
 *   three languages (Rust's `u64`, Python's `float` seconds would otherwise
 *   force a per-language conversion at the boundary).
 */

/** Severity of a {@link TelemetryEvent}. ADR-0028 §D1 does not specify exact values -- see the module doc comment for the design rationale. */
export type TelemetrySeverity = "debug" | "info" | "warn" | "error";

/**
 * W3C trace-context carrier (ADR-0028 §D2). Optional at this layer: §D2
 * trace propagation (generating or joining `traceparent`/`tracestate`) is
 * out of scope for this pass (tracking issue #70) -- this type exists so
 * {@link TelemetryEvent.traceContext} has a stable shape for that follow-up
 * to populate.
 */
export interface TraceContext {
  traceParent?: string;
  traceState?: string;
}

/**
 * A single telemetry event (ADR-0028 §D1). Per §D1, sinks receive
 * already-redacted events -- they never receive raw requests or responses
 * through this interface. `attributes`/`measurements` are open maps; the
 * §D3 attribute constants below name the stable, low-cardinality keys a
 * caller SHOULD use when populating them.
 */
export interface TelemetryEvent {
  name: string;
  timestamp: string;
  severity: TelemetrySeverity;
  traceContext?: TraceContext;
  attributes: Record<string, unknown>;
  measurements: Record<string, unknown>;
}

/**
 * Optional telemetry sink boundary (ADR-0028 §D1): "The core SDK defines a
 * small optional sink rather than taking a required dependency on one
 * observability vendor." Product clients accept a `TelemetrySink`, mirroring
 * the async-method interface shape already established by
 * {@link CredentialProvider} (`./credentials.ts`).
 *
 * Per §D1, "Sink failures, timeouts, and backpressure MUST NOT fail or
 * delay the product operation; the SDK counts dropped events and may emit
 * one content-free diagnostic through a fallback hook." That call-site
 * behavior (catching an `emit`/`flush` rejection, incrementing a
 * dropped-event counter, invoking the fallback hook) requires the actual
 * emit call sites this pass does not wire up -- tracked by issue #70. This
 * interface only defines the shape implementors satisfy.
 */
export interface TelemetrySink {
  /** Emits one already-redacted {@link TelemetryEvent}. */
  emit(event: TelemetryEvent): Promise<void>;
  /**
   * Flushes any buffered events. `deadlineMs` bounds how long the sink may
   * take; honoring the bound is the sink implementation's responsibility --
   * no shared timeout wrapper ships in this pass.
   */
  flush(deadlineMs: number): Promise<void>;
}

/**
 * The default sink (ADR-0028 §D1: "A no-op sink is the default."). This is
 * real, functional logic, not a placeholder: `emit` performs no I/O and
 * never rejects; `flush` resolves immediately.
 */
export class NoopTelemetrySink implements TelemetrySink {
  async emit(_event: TelemetryEvent): Promise<void> {
    // Intentionally does nothing.
  }

  async flush(_deadlineMs: number): Promise<void> {
    // Intentionally resolves immediately.
  }
}

// ---------------------------------------------------------------------
// §D3: Safe semantic attribute names, `cognitum.*` namespace.
//
// These are named string CONSTANTS, not a union type: per §D3 only the KEY
// names are fixed -- attribute VALUES are free-form (subject to each row's
// own cardinality rule below). This pass does not build a validator that
// enforces a cardinality rule at runtime; each constant's doc comment
// records its rule from the ADR-0028 §D3 table for future code to consult.
// ---------------------------------------------------------------------

/** `cognitum.product` -- e.g. `meta-llm`. Cardinality rule: fixed set. */
export const ATTR_PRODUCT = "cognitum.product";

/** `cognitum.operation` -- e.g. `chat.completions.create`. Cardinality rule: contract set. */
export const ATTR_OPERATION = "cognitum.operation";

/** `cognitum.protocol` -- e.g. `openai-chat`. Cardinality rule: contract set. */
export const ATTR_PROTOCOL = "cognitum.protocol";

/** `cognitum.contract.version` -- e.g. `1.2`. Cardinality rule: low. */
export const ATTR_CONTRACT_VERSION = "cognitum.contract.version";

/** `cognitum.request.id` -- opaque UUID. Cardinality rule: trace/log only, never a metric label. */
export const ATTR_REQUEST_ID = "cognitum.request.id";

/** `cognitum.tenant.hash` -- truncated keyed hash. Cardinality rule: trace/log only. */
export const ATTR_TENANT_HASH = "cognitum.tenant.hash";

/** `cognitum.model.alias` -- e.g. `cognitum-auto`. Cardinality rule: public aliases only; raw provider model optional and low-cardinality guarded. */
export const ATTR_MODEL_ALIAS = "cognitum.model.alias";

/** `cognitum.tier` -- `low`, `mid`, `high`. Cardinality rule: fixed set. */
export const ATTR_TIER = "cognitum.tier";

/** `cognitum.routing.plane` -- `local`, `cloud`, `passthrough`, `sponsored`. Cardinality rule: fixed set; only server/proxy-reported. */
export const ATTR_ROUTING_PLANE = "cognitum.routing.plane";

/** `cognitum.routing.reason` -- contract code. Cardinality rule: bounded enum, not free text. */
export const ATTR_ROUTING_REASON = "cognitum.routing.reason";

/** `cognitum.cache.result` -- `hit`, `miss`, `disabled`. Cardinality rule: fixed set. */
export const ATTR_CACHE_RESULT = "cognitum.cache.result";

/** `cognitum.operation.state` -- job/pod/batch state. Cardinality rule: product contract set. */
export const ATTR_OPERATION_STATE = "cognitum.operation.state";

/** `cognitum.error.kind` -- common error kind. Cardinality rule: fixed set. */
export const ATTR_ERROR_KIND = "cognitum.error.kind";

/** `cognitum.retry.count` -- integer. Cardinality rule: measurement. */
export const ATTR_RETRY_COUNT = "cognitum.retry.count";
