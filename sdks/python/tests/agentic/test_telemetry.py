"""Tests for the telemetry sink/event stubs and D3 attribute constants
(ADR-0028 D1, D3).

Covers:

- ``NoopTelemetrySink.emit``/``flush`` genuinely do nothing and never raise;
- every D3 attribute constant is exactly the ADR-cited string;
- ``TelemetryEvent``/``TraceContext`` hold the values assigned to them.
"""

from __future__ import annotations

import pytest

from cognitum.agentic.telemetry import (
    ATTR_CACHE_RESULT,
    ATTR_CONTRACT_VERSION,
    ATTR_ERROR_KIND,
    ATTR_MODEL_ALIAS,
    ATTR_OPERATION,
    ATTR_OPERATION_STATE,
    ATTR_PRODUCT,
    ATTR_PROTOCOL,
    ATTR_REQUEST_ID,
    ATTR_RETRY_COUNT,
    ATTR_ROUTING_PLANE,
    ATTR_ROUTING_REASON,
    ATTR_TENANT_HASH,
    ATTR_TIER,
    EVENT_ARTIFACT_VERIFIED,
    EVENT_BUDGET_COMMITTED,
    EVENT_BUDGET_RELEASED,
    EVENT_BUDGET_RESERVED,
    EVENT_CAPABILITIES_LOADED,
    EVENT_CONSENT_REQUIRED,
    EVENT_EVIDENCE_VERIFIED,
    EVENT_OPERATION_STATE_CHANGED,
    EVENT_OPERATION_WAIT_ENDED,
    EVENT_PROCESS_ENDED,
    EVENT_PROCESS_STARTED,
    EVENT_REQUEST_END,
    EVENT_REQUEST_RETRY_SCHEDULED,
    EVENT_REQUEST_START,
    EVENT_STREAM_END,
    EVENT_STREAM_FIRST_EVENT,
    EVENT_TELEMETRY_DROPPED,
    NoopTelemetrySink,
    TelemetryEvent,
    TraceContext,
)


def _event(**overrides: object) -> TelemetryEvent:
    fields: dict[str, object] = {
        "name": "request.start",
        "timestamp": "2026-07-19T00:00:00Z",
        "severity": "info",
    }
    fields.update(overrides)
    return TelemetryEvent(**fields)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_noop_sink_emit_does_nothing_and_never_raises() -> None:
    sink = NoopTelemetrySink()
    await sink.emit(_event())


@pytest.mark.asyncio
async def test_noop_sink_flush_resolves_immediately_and_never_raises() -> None:
    sink = NoopTelemetrySink()
    await sink.flush(5_000.0)


@pytest.mark.asyncio
async def test_noop_sink_satisfies_the_telemetry_sink_protocol() -> None:
    from cognitum.agentic.telemetry import TelemetrySink

    sink: TelemetrySink = NoopTelemetrySink()
    assert isinstance(sink, TelemetrySink)
    await sink.emit(_event())
    await sink.flush(0.0)


def test_d3_attribute_constants_match_adr_0028_table_exactly() -> None:
    assert ATTR_PRODUCT == "cognitum.product"
    assert ATTR_OPERATION == "cognitum.operation"
    assert ATTR_PROTOCOL == "cognitum.protocol"
    assert ATTR_CONTRACT_VERSION == "cognitum.contract.version"
    assert ATTR_REQUEST_ID == "cognitum.request.id"
    assert ATTR_TENANT_HASH == "cognitum.tenant.hash"
    assert ATTR_MODEL_ALIAS == "cognitum.model.alias"
    assert ATTR_TIER == "cognitum.tier"
    assert ATTR_ROUTING_PLANE == "cognitum.routing.plane"
    assert ATTR_ROUTING_REASON == "cognitum.routing.reason"
    assert ATTR_CACHE_RESULT == "cognitum.cache.result"
    assert ATTR_OPERATION_STATE == "cognitum.operation.state"
    assert ATTR_ERROR_KIND == "cognitum.error.kind"
    assert ATTR_RETRY_COUNT == "cognitum.retry.count"


def test_telemetry_event_holds_assigned_fields_including_trace_context() -> None:
    event = _event(
        name="request.end",
        severity="warn",
        trace_context=TraceContext(trace_parent="00-abc-def-01", trace_state=None),
        attributes={ATTR_PRODUCT: "meta-llm"},
        measurements={ATTR_RETRY_COUNT: 2},
    )
    assert event.name == "request.end"
    assert event.severity == "warn"
    assert event.trace_context is not None
    assert event.trace_context.trace_parent == "00-abc-def-01"
    assert event.attributes[ATTR_PRODUCT] == "meta-llm"
    assert event.measurements[ATTR_RETRY_COUNT] == 2


def test_telemetry_event_defaults_trace_context_to_none_and_maps_to_empty() -> None:
    event = _event()
    assert event.trace_context is None
    assert event.attributes == {}
    assert event.measurements == {}


def test_d4_event_constants_match_adr_0028_catalog_exactly() -> None:
    assert EVENT_REQUEST_START == "request.start"
    assert EVENT_REQUEST_RETRY_SCHEDULED == "request.retry_scheduled"
    assert EVENT_REQUEST_END == "request.end"
    assert EVENT_STREAM_FIRST_EVENT == "stream.first_event"
    assert EVENT_STREAM_END == "stream.end"
    assert EVENT_OPERATION_STATE_CHANGED == "operation.state_changed"
    assert EVENT_OPERATION_WAIT_ENDED == "operation.wait_ended"
    assert EVENT_CAPABILITIES_LOADED == "capabilities.loaded"
    assert EVENT_BUDGET_RESERVED == "budget.reserved"
    assert EVENT_BUDGET_COMMITTED == "budget.committed"
    assert EVENT_BUDGET_RELEASED == "budget.released"
    assert EVENT_CONSENT_REQUIRED == "consent.required"
    assert EVENT_PROCESS_STARTED == "process.started"
    assert EVENT_PROCESS_ENDED == "process.ended"
    assert EVENT_ARTIFACT_VERIFIED == "artifact.verified"
    assert EVENT_EVIDENCE_VERIFIED == "evidence.verified"
    assert EVENT_TELEMETRY_DROPPED == "telemetry.dropped"


def test_d4_event_catalog_has_exactly_seventeen_entries() -> None:
    all_events = [
        EVENT_REQUEST_START,
        EVENT_REQUEST_RETRY_SCHEDULED,
        EVENT_REQUEST_END,
        EVENT_STREAM_FIRST_EVENT,
        EVENT_STREAM_END,
        EVENT_OPERATION_STATE_CHANGED,
        EVENT_OPERATION_WAIT_ENDED,
        EVENT_CAPABILITIES_LOADED,
        EVENT_BUDGET_RESERVED,
        EVENT_BUDGET_COMMITTED,
        EVENT_BUDGET_RELEASED,
        EVENT_CONSENT_REQUIRED,
        EVENT_PROCESS_STARTED,
        EVENT_PROCESS_ENDED,
        EVENT_ARTIFACT_VERIFIED,
        EVENT_EVIDENCE_VERIFIED,
        EVENT_TELEMETRY_DROPPED,
    ]
    assert len(all_events) == 17
    assert len(set(all_events)) == 17
