"""D4 metric instrument catalog (ADR-0028 D4, lines 148-161).

Type-only scaffolding, mirroring D3's ``ATTR_*`` constant-catalog
discipline in ``./telemetry.py``: this module names the metric
*instruments* the SDK is expected to emit once a real metrics adapter
exists (tracking issue #70) -- it does not implement an OpenTelemetry
meter, does not record any measurement, and is not wired into any product
client.

ADR-0028 D4 describes the metric catalog in PROSE ("request and stream
duration histograms", "request, retry, error, and cancellation counters",
...), unlike its literal dotted event names (``request.start``, ...) or
its literal ``cognitum.*`` attribute names (D3). Three naming decisions
were required here that are NOT direct ADR quotes:

1. Each bullet is expanded into one :data:`MetricInstrumentKind` value per
   concrete instrument (e.g. "input, output, cache, and safety token
   counters" -> four values; "reserved, committed, released, and
   reconciled cost counters" -> four values), so a future metrics adapter
   has one concrete registration point per instrument rather than one
   opaque bucket per bullet. This yields 19 instruments total: 2 duration
   histograms + 4 request-shape counters + 1 latency histogram + 4 token
   counters + 4 cost counters + 1 operation-state counter + 2 process
   counters + 1 verification counter.
2. Each instrument's wire name follows the bare-dotted-word style of the
   D4 *event* names (``request.start``, ``stream.first_event``, ...)
   rather than the ``cognitum.*``-namespaced style of the D3 *attribute*
   names. An instrument name identifies a meter; an attribute key
   identifies a dimension recorded alongside a data point -- those are
   different roles, and reusing e.g. ``cognitum.retry.count`` for both the
   D3 ``ATTR_RETRY_COUNT`` attribute AND a D4 retry-count instrument would
   conflate them, so instrument names deliberately omit the ``cognitum.``
   prefix.
3. :data:`MetricInstrumentKind` follows this package's existing
   ``Literal`` type-alias convention (see :data:`TelemetrySeverity` in
   ``./telemetry.py``) rather than an :class:`enum.Enum`, matching how
   ``AgenticErrorKind``/``CostFinality``/``VerificationLevel`` are already
   modeled elsewhere in this package. The per-instrument "which
   measurement kind" fact is carried by the
   :data:`MEASUREMENT_KIND_BY_INSTRUMENT` mapping rather than a bound
   method, since a ``Literal`` has no attached behavior.

Per ADR-0028 D4 (lines 159-161): "Request IDs, tenant IDs, operation IDs,
repository names, prompts, URLs, and raw model IDs MUST NOT be metric
dimensions. Money of different currencies is never summed into one
measurement." No validator enforces either rule in this pass -- this is a
discoverability note for whoever wires real metric emission in a
follow-up. The four ``METRIC_COST_*`` instruments below in particular MUST
be recorded as separate measurements per currency, never summed together.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Final, Literal

#: Whether a :data:`MetricInstrumentKind` is recorded as a histogram or a
#: monotonic counter. ADR-0028 D4 explicitly distinguishes "duration ...
#: histograms" / "first-event latency histogram" from the various
#: "... counters" bullets.
MeasurementKind = Literal["histogram", "counter"]

# Each constant below is annotated `Final` (with no explicit type) so mypy
# infers its narrowest literal type -- required so these constants can
# populate the `MetricInstrumentKind` Literal alias and the
# `ALL_METRIC_INSTRUMENT_KINDS`/`MEASUREMENT_KIND_BY_INSTRUMENT` containers
# below without widening to plain `str`.

#: "request ... duration histograms".
METRIC_REQUEST_DURATION: Final = "request.duration"

#: "... stream duration histograms".
METRIC_STREAM_DURATION: Final = "stream.duration"

#: "request ... counters".
METRIC_REQUEST_COUNT: Final = "request.count"

#: "... retry ... counters".
METRIC_RETRY_COUNT: Final = "retry.count"

#: "... error ... counters".
METRIC_ERROR_COUNT: Final = "error.count"

#: "... and cancellation counters".
METRIC_CANCELLATION_COUNT: Final = "cancellation.count"

#: "first-event latency histogram".
METRIC_FIRST_EVENT_LATENCY: Final = "stream.first_event.latency"

#: "input ... token counters when server-reported".
METRIC_INPUT_TOKEN_COUNT: Final = "token.input.count"

#: "... output ... token counters when server-reported".
METRIC_OUTPUT_TOKEN_COUNT: Final = "token.output.count"

#: "... cache ... token counters when server-reported".
METRIC_CACHE_TOKEN_COUNT: Final = "token.cache.count"

#: "... and safety token counters when server-reported".
METRIC_SAFETY_TOKEN_COUNT: Final = "token.safety.count"

#: "reserved ... cost counters by currency". MUST NOT be summed across
#: currencies (ADR-0028 D4 line 161).
METRIC_COST_RESERVED: Final = "cost.reserved"

#: "... committed ... cost counters by currency". MUST NOT be summed
#: across currencies (ADR-0028 D4 line 161).
METRIC_COST_COMMITTED: Final = "cost.committed"

#: "... released ... cost counters by currency". MUST NOT be summed
#: across currencies (ADR-0028 D4 line 161).
METRIC_COST_RELEASED: Final = "cost.released"

#: "... and reconciled cost counters by currency". MUST NOT be summed
#: across currencies (ADR-0028 D4 line 161).
METRIC_COST_RECONCILED: Final = "cost.reconciled"

#: "operation state-transition counters".
METRIC_OPERATION_STATE_TRANSITION_COUNT: Final = "operation.state_transition.count"

#: "process exit ... counters".
METRIC_PROCESS_EXIT_COUNT: Final = "process.exit.count"

#: "... and forced-termination counters".
METRIC_PROCESS_FORCED_TERMINATION_COUNT: Final = "process.forced_termination.count"

#: "verification result counters".
METRIC_VERIFICATION_RESULT_COUNT: Final = "verification.result.count"

#: The default metric instrument catalog (ADR-0028 D4, lines 148-157). See
#: the module docstring for how ADR prose bullets were expanded into these
#: 19 instrument names.
MetricInstrumentKind = Literal[
    "request.duration",
    "stream.duration",
    "request.count",
    "retry.count",
    "error.count",
    "cancellation.count",
    "stream.first_event.latency",
    "token.input.count",
    "token.output.count",
    "token.cache.count",
    "token.safety.count",
    "cost.reserved",
    "cost.committed",
    "cost.released",
    "cost.reconciled",
    "operation.state_transition.count",
    "process.exit.count",
    "process.forced_termination.count",
    "verification.result.count",
]

#: Every catalog value, in ADR-0028 D4 prose order. Used by tests to
#: assert the catalog's cardinality and cross-language parity.
ALL_METRIC_INSTRUMENT_KINDS: tuple[MetricInstrumentKind, ...] = (
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
)

#: Histogram vs counter per instrument, per ADR-0028 D4's explicit
#: distinction.
MEASUREMENT_KIND_BY_INSTRUMENT: Mapping[MetricInstrumentKind, MeasurementKind] = {
    METRIC_REQUEST_DURATION: "histogram",
    METRIC_STREAM_DURATION: "histogram",
    METRIC_REQUEST_COUNT: "counter",
    METRIC_RETRY_COUNT: "counter",
    METRIC_ERROR_COUNT: "counter",
    METRIC_CANCELLATION_COUNT: "counter",
    METRIC_FIRST_EVENT_LATENCY: "histogram",
    METRIC_INPUT_TOKEN_COUNT: "counter",
    METRIC_OUTPUT_TOKEN_COUNT: "counter",
    METRIC_CACHE_TOKEN_COUNT: "counter",
    METRIC_SAFETY_TOKEN_COUNT: "counter",
    METRIC_COST_RESERVED: "counter",
    METRIC_COST_COMMITTED: "counter",
    METRIC_COST_RELEASED: "counter",
    METRIC_COST_RECONCILED: "counter",
    METRIC_OPERATION_STATE_TRANSITION_COUNT: "counter",
    METRIC_PROCESS_EXIT_COUNT: "counter",
    METRIC_PROCESS_FORCED_TERMINATION_COUNT: "counter",
    METRIC_VERIFICATION_RESULT_COUNT: "counter",
}


def measurement_kind_of(kind: MetricInstrumentKind) -> MeasurementKind:
    """Looks up the measurement kind for one instrument."""
    return MEASUREMENT_KIND_BY_INSTRUMENT[kind]


__all__ = [
    "MeasurementKind",
    "MetricInstrumentKind",
    "METRIC_REQUEST_DURATION",
    "METRIC_STREAM_DURATION",
    "METRIC_REQUEST_COUNT",
    "METRIC_RETRY_COUNT",
    "METRIC_ERROR_COUNT",
    "METRIC_CANCELLATION_COUNT",
    "METRIC_FIRST_EVENT_LATENCY",
    "METRIC_INPUT_TOKEN_COUNT",
    "METRIC_OUTPUT_TOKEN_COUNT",
    "METRIC_CACHE_TOKEN_COUNT",
    "METRIC_SAFETY_TOKEN_COUNT",
    "METRIC_COST_RESERVED",
    "METRIC_COST_COMMITTED",
    "METRIC_COST_RELEASED",
    "METRIC_COST_RECONCILED",
    "METRIC_OPERATION_STATE_TRANSITION_COUNT",
    "METRIC_PROCESS_EXIT_COUNT",
    "METRIC_PROCESS_FORCED_TERMINATION_COUNT",
    "METRIC_VERIFICATION_RESULT_COUNT",
    "ALL_METRIC_INSTRUMENT_KINDS",
    "MEASUREMENT_KIND_BY_INSTRUMENT",
    "measurement_kind_of",
]
