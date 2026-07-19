/**
 * §D4 metric instrument catalog (ADR-0028 §D4, lines 148-161). Type-only
 * scaffolding, mirroring §D3's `ATTR_*` constant-catalog discipline in
 * `./telemetry.ts`: this module names the metric *instruments* the SDK is
 * expected to emit once a real metrics adapter exists (tracking issue
 * #70) -- it does not implement an OpenTelemetry meter, does not record
 * any measurement, and is not wired into any product client.
 *
 * ADR-0028 §D4 describes the metric catalog in PROSE ("request and stream
 * duration histograms", "request, retry, error, and cancellation
 * counters", ...), unlike its literal dotted event names (`request.start`,
 * ...) or its literal `cognitum.*` attribute names (§D3). Two naming
 * decisions were required here that are NOT direct ADR quotes:
 *
 * 1. Each bullet is expanded into one {@link MetricInstrumentKind} value
 *    per concrete instrument (e.g. "input, output, cache, and safety token
 *    counters" -> four values; "reserved, committed, released, and
 *    reconciled cost counters" -> four values), so a future metrics
 *    adapter has one concrete registration point per instrument rather
 *    than one opaque bucket per bullet. This yields 19 instruments total:
 *    2 duration histograms + 4 request-shape counters + 1 latency
 *    histogram + 4 token counters + 4 cost counters + 1 operation-state
 *    counter + 2 process counters + 1 verification counter.
 * 2. Each instrument's wire name follows the bare-dotted-word style of the
 *    §D4 *event* names (`request.start`, `stream.first_event`, ...) rather
 *    than the `cognitum.*`-namespaced style of the §D3 *attribute* names.
 *    An instrument name identifies a meter; an attribute key identifies a
 *    dimension recorded alongside a data point -- those are different
 *    roles, and reusing e.g. `cognitum.retry.count` for both the §D3
 *    `ATTR_RETRY_COUNT` attribute AND a §D4 retry-count instrument would
 *    conflate them, so instrument names deliberately omit the `cognitum.`
 *    prefix.
 * 3. {@link MetricInstrumentKind} follows this module's existing
 *    string-literal-union convention (see {@link TelemetrySeverity} in
 *    `./telemetry.ts`) rather than a TypeScript `enum`, so the
 *    per-instrument "which measurement kind" fact is carried by the
 *    {@link MEASUREMENT_KIND_BY_INSTRUMENT} lookup rather than a class
 *    method -- TypeScript string unions have no attached behavior.
 *
 * Per ADR-0028 §D4 (lines 159-161): "Request IDs, tenant IDs, operation
 * IDs, repository names, prompts, URLs, and raw model IDs MUST NOT be
 * metric dimensions. Money of different currencies is never summed into
 * one measurement." No validator enforces either rule in this pass -- this
 * is a discoverability note for whoever wires real metric emission in a
 * follow-up. The four `METRIC_COST_*` instruments below in particular MUST
 * be recorded as separate measurements per currency, never summed together.
 */

/**
 * Whether a {@link MetricInstrumentKind} is recorded as a histogram or a
 * monotonic counter. ADR-0028 §D4 explicitly distinguishes "duration ...
 * histograms" / "first-event latency histogram" from the various
 * "... counters" bullets.
 */
export type MeasurementKind = "histogram" | "counter";

/** "request ... duration histograms". */
export const METRIC_REQUEST_DURATION = "request.duration";
/** "... stream duration histograms". */
export const METRIC_STREAM_DURATION = "stream.duration";
/** "request ... counters". */
export const METRIC_REQUEST_COUNT = "request.count";
/** "... retry ... counters". */
export const METRIC_RETRY_COUNT = "retry.count";
/** "... error ... counters". */
export const METRIC_ERROR_COUNT = "error.count";
/** "... and cancellation counters". */
export const METRIC_CANCELLATION_COUNT = "cancellation.count";
/** "first-event latency histogram". */
export const METRIC_FIRST_EVENT_LATENCY = "stream.first_event.latency";
/** "input ... token counters when server-reported". */
export const METRIC_INPUT_TOKEN_COUNT = "token.input.count";
/** "... output ... token counters when server-reported". */
export const METRIC_OUTPUT_TOKEN_COUNT = "token.output.count";
/** "... cache ... token counters when server-reported". */
export const METRIC_CACHE_TOKEN_COUNT = "token.cache.count";
/** "... and safety token counters when server-reported". */
export const METRIC_SAFETY_TOKEN_COUNT = "token.safety.count";
/**
 * "reserved ... cost counters by currency". MUST NOT be summed across
 * currencies (ADR-0028 §D4 line 161).
 */
export const METRIC_COST_RESERVED = "cost.reserved";
/**
 * "... committed ... cost counters by currency". MUST NOT be summed
 * across currencies (ADR-0028 §D4 line 161).
 */
export const METRIC_COST_COMMITTED = "cost.committed";
/**
 * "... released ... cost counters by currency". MUST NOT be summed
 * across currencies (ADR-0028 §D4 line 161).
 */
export const METRIC_COST_RELEASED = "cost.released";
/**
 * "... and reconciled cost counters by currency". MUST NOT be summed
 * across currencies (ADR-0028 §D4 line 161).
 */
export const METRIC_COST_RECONCILED = "cost.reconciled";
/** "operation state-transition counters". */
export const METRIC_OPERATION_STATE_TRANSITION_COUNT = "operation.state_transition.count";
/** "process exit ... counters". */
export const METRIC_PROCESS_EXIT_COUNT = "process.exit.count";
/** "... and forced-termination counters". */
export const METRIC_PROCESS_FORCED_TERMINATION_COUNT = "process.forced_termination.count";
/** "verification result counters". */
export const METRIC_VERIFICATION_RESULT_COUNT = "verification.result.count";

/**
 * The default metric instrument catalog (ADR-0028 §D4, lines 148-157). See
 * the module doc comment for how ADR prose bullets were expanded into
 * these 19 instrument names.
 */
export type MetricInstrumentKind =
  | typeof METRIC_REQUEST_DURATION
  | typeof METRIC_STREAM_DURATION
  | typeof METRIC_REQUEST_COUNT
  | typeof METRIC_RETRY_COUNT
  | typeof METRIC_ERROR_COUNT
  | typeof METRIC_CANCELLATION_COUNT
  | typeof METRIC_FIRST_EVENT_LATENCY
  | typeof METRIC_INPUT_TOKEN_COUNT
  | typeof METRIC_OUTPUT_TOKEN_COUNT
  | typeof METRIC_CACHE_TOKEN_COUNT
  | typeof METRIC_SAFETY_TOKEN_COUNT
  | typeof METRIC_COST_RESERVED
  | typeof METRIC_COST_COMMITTED
  | typeof METRIC_COST_RELEASED
  | typeof METRIC_COST_RECONCILED
  | typeof METRIC_OPERATION_STATE_TRANSITION_COUNT
  | typeof METRIC_PROCESS_EXIT_COUNT
  | typeof METRIC_PROCESS_FORCED_TERMINATION_COUNT
  | typeof METRIC_VERIFICATION_RESULT_COUNT;

/**
 * Every catalog value, in ADR-0028 §D4 prose order. Used by tests to
 * assert the catalog's cardinality and cross-language parity.
 */
export const ALL_METRIC_INSTRUMENT_KINDS: readonly MetricInstrumentKind[] = [
  METRIC_REQUEST_DURATION,
  METRIC_STREAM_DURATION,
  METRIC_REQUEST_COUNT,
  METRIC_RETRY_COUNT,
  METRIC_ERROR_COUNT,
  METRIC_CANCELLATION_COUNT,
  METRIC_FIRST_EVENT_LATENCY,
  METRIC_INPUT_TOKEN_COUNT,
  METRIC_OUTPUT_TOKEN_COUNT,
  METRIC_CACHE_TOKEN_COUNT,
  METRIC_SAFETY_TOKEN_COUNT,
  METRIC_COST_RESERVED,
  METRIC_COST_COMMITTED,
  METRIC_COST_RELEASED,
  METRIC_COST_RECONCILED,
  METRIC_OPERATION_STATE_TRANSITION_COUNT,
  METRIC_PROCESS_EXIT_COUNT,
  METRIC_PROCESS_FORCED_TERMINATION_COUNT,
  METRIC_VERIFICATION_RESULT_COUNT,
];

/**
 * Histogram vs counter per instrument, per ADR-0028 §D4's explicit
 * distinction.
 */
export const MEASUREMENT_KIND_BY_INSTRUMENT: Readonly<Record<MetricInstrumentKind, MeasurementKind>> = {
  [METRIC_REQUEST_DURATION]: "histogram",
  [METRIC_STREAM_DURATION]: "histogram",
  [METRIC_REQUEST_COUNT]: "counter",
  [METRIC_RETRY_COUNT]: "counter",
  [METRIC_ERROR_COUNT]: "counter",
  [METRIC_CANCELLATION_COUNT]: "counter",
  [METRIC_FIRST_EVENT_LATENCY]: "histogram",
  [METRIC_INPUT_TOKEN_COUNT]: "counter",
  [METRIC_OUTPUT_TOKEN_COUNT]: "counter",
  [METRIC_CACHE_TOKEN_COUNT]: "counter",
  [METRIC_SAFETY_TOKEN_COUNT]: "counter",
  [METRIC_COST_RESERVED]: "counter",
  [METRIC_COST_COMMITTED]: "counter",
  [METRIC_COST_RELEASED]: "counter",
  [METRIC_COST_RECONCILED]: "counter",
  [METRIC_OPERATION_STATE_TRANSITION_COUNT]: "counter",
  [METRIC_PROCESS_EXIT_COUNT]: "counter",
  [METRIC_PROCESS_FORCED_TERMINATION_COUNT]: "counter",
  [METRIC_VERIFICATION_RESULT_COUNT]: "counter",
};

/** Looks up the measurement kind for one instrument. */
export function measurementKindOf(kind: MetricInstrumentKind): MeasurementKind {
  return MEASUREMENT_KIND_BY_INSTRUMENT[kind];
}
