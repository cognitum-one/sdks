"""Tests for the D4 metric instrument catalog (ADR-0028 D4, lines 148-161).

Covers:

- the catalog has exactly nineteen instruments;
- every instrument constant is exactly the designed wire string;
- ``measurement_kind_of`` matches the ADR's histogram-vs-counter
  classification for every instrument.
"""

from __future__ import annotations

from cognitum.agentic.telemetry_metrics import (
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
    MetricInstrumentKind,
    measurement_kind_of,
)


def test_catalog_has_exactly_nineteen_instruments() -> None:
    assert len(ALL_METRIC_INSTRUMENT_KINDS) == 19
    assert len(set(ALL_METRIC_INSTRUMENT_KINDS)) == 19


def test_instrument_constants_match_designed_wire_strings() -> None:
    assert METRIC_REQUEST_DURATION == "request.duration"
    assert METRIC_STREAM_DURATION == "stream.duration"
    assert METRIC_REQUEST_COUNT == "request.count"
    assert METRIC_RETRY_COUNT == "retry.count"
    assert METRIC_ERROR_COUNT == "error.count"
    assert METRIC_CANCELLATION_COUNT == "cancellation.count"
    assert METRIC_FIRST_EVENT_LATENCY == "stream.first_event.latency"
    assert METRIC_INPUT_TOKEN_COUNT == "token.input.count"
    assert METRIC_OUTPUT_TOKEN_COUNT == "token.output.count"
    assert METRIC_CACHE_TOKEN_COUNT == "token.cache.count"
    assert METRIC_SAFETY_TOKEN_COUNT == "token.safety.count"
    assert METRIC_COST_RESERVED == "cost.reserved"
    assert METRIC_COST_COMMITTED == "cost.committed"
    assert METRIC_COST_RELEASED == "cost.released"
    assert METRIC_COST_RECONCILED == "cost.reconciled"
    assert METRIC_OPERATION_STATE_TRANSITION_COUNT == "operation.state_transition.count"
    assert METRIC_PROCESS_EXIT_COUNT == "process.exit.count"
    assert METRIC_PROCESS_FORCED_TERMINATION_COUNT == "process.forced_termination.count"
    assert METRIC_VERIFICATION_RESULT_COUNT == "verification.result.count"


def test_measurement_kind_matches_adr_histogram_vs_counter_classification() -> None:
    histograms: set[MetricInstrumentKind] = {
        METRIC_REQUEST_DURATION,
        METRIC_STREAM_DURATION,
        METRIC_FIRST_EVENT_LATENCY,
    }
    for kind in histograms:
        assert measurement_kind_of(kind) == "histogram"

    for kind in ALL_METRIC_INSTRUMENT_KINDS:
        if kind not in histograms:
            assert measurement_kind_of(kind) == "counter"


def test_measurement_kind_by_instrument_covers_every_catalog_entry() -> None:
    for kind in ALL_METRIC_INSTRUMENT_KINDS:
        assert kind in MEASUREMENT_KIND_BY_INSTRUMENT
