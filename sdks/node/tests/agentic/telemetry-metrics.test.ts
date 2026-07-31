/**
 * Tests for the §D4 metric instrument catalog (ADR-0028 §D4, lines
 * 148-161).
 *
 * Covers:
 * - the catalog has exactly nineteen instruments;
 * - every instrument constant is exactly the designed wire string;
 * - `measurementKindOf` matches the ADR's histogram-vs-counter
 *   classification for every instrument.
 */

import { describe, it, expect } from "vitest";
import {
  ALL_METRIC_INSTRUMENT_KINDS,
  MEASUREMENT_KIND_BY_INSTRUMENT,
  METRIC_CACHE_TOKEN_COUNT,
  METRIC_CANCELLATION_COUNT,
  METRIC_COST_COMMITTED,
  METRIC_COST_RECONCILED,
  METRIC_COST_RELEASED,
  METRIC_COST_RESERVED,
  METRIC_ERROR_COUNT,
  METRIC_FIRST_EVENT_LATENCY,
  METRIC_INPUT_TOKEN_COUNT,
  METRIC_OPERATION_STATE_TRANSITION_COUNT,
  METRIC_OUTPUT_TOKEN_COUNT,
  METRIC_PROCESS_EXIT_COUNT,
  METRIC_PROCESS_FORCED_TERMINATION_COUNT,
  METRIC_REQUEST_COUNT,
  METRIC_REQUEST_DURATION,
  METRIC_RETRY_COUNT,
  METRIC_SAFETY_TOKEN_COUNT,
  METRIC_STREAM_DURATION,
  METRIC_VERIFICATION_RESULT_COUNT,
  measurementKindOf,
  type MetricInstrumentKind,
} from "../../src/agentic/telemetry-metrics.js";

describe("ADR-0028 §D4 metric instrument catalog", () => {
  it("has exactly nineteen instruments", () => {
    expect(ALL_METRIC_INSTRUMENT_KINDS).toHaveLength(19);
    expect(new Set(ALL_METRIC_INSTRUMENT_KINDS).size).toBe(19);
  });

  it("instrument constants match the designed wire strings", () => {
    expect(METRIC_REQUEST_DURATION).toBe("request.duration");
    expect(METRIC_STREAM_DURATION).toBe("stream.duration");
    expect(METRIC_REQUEST_COUNT).toBe("request.count");
    expect(METRIC_RETRY_COUNT).toBe("retry.count");
    expect(METRIC_ERROR_COUNT).toBe("error.count");
    expect(METRIC_CANCELLATION_COUNT).toBe("cancellation.count");
    expect(METRIC_FIRST_EVENT_LATENCY).toBe("stream.first_event.latency");
    expect(METRIC_INPUT_TOKEN_COUNT).toBe("token.input.count");
    expect(METRIC_OUTPUT_TOKEN_COUNT).toBe("token.output.count");
    expect(METRIC_CACHE_TOKEN_COUNT).toBe("token.cache.count");
    expect(METRIC_SAFETY_TOKEN_COUNT).toBe("token.safety.count");
    expect(METRIC_COST_RESERVED).toBe("cost.reserved");
    expect(METRIC_COST_COMMITTED).toBe("cost.committed");
    expect(METRIC_COST_RELEASED).toBe("cost.released");
    expect(METRIC_COST_RECONCILED).toBe("cost.reconciled");
    expect(METRIC_OPERATION_STATE_TRANSITION_COUNT).toBe("operation.state_transition.count");
    expect(METRIC_PROCESS_EXIT_COUNT).toBe("process.exit.count");
    expect(METRIC_PROCESS_FORCED_TERMINATION_COUNT).toBe("process.forced_termination.count");
    expect(METRIC_VERIFICATION_RESULT_COUNT).toBe("verification.result.count");
  });

  it("classifies histograms vs counters per the ADR's explicit split", () => {
    const histograms: MetricInstrumentKind[] = [
      METRIC_REQUEST_DURATION,
      METRIC_STREAM_DURATION,
      METRIC_FIRST_EVENT_LATENCY,
    ];
    for (const kind of histograms) {
      expect(measurementKindOf(kind)).toBe("histogram");
    }

    for (const kind of ALL_METRIC_INSTRUMENT_KINDS) {
      if (!histograms.includes(kind)) {
        expect(measurementKindOf(kind)).toBe("counter");
      }
    }
  });

  it("MEASUREMENT_KIND_BY_INSTRUMENT covers every catalog entry", () => {
    for (const kind of ALL_METRIC_INSTRUMENT_KINDS) {
      expect(MEASUREMENT_KIND_BY_INSTRUMENT[kind]).toBeDefined();
    }
  });
});
