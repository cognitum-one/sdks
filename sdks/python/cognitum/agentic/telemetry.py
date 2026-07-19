"""TelemetrySink / TelemetryEvent type-only stubs and safe semantic
attribute constants (ADR-0028 D1, D3).

This is M6's first pass: it freezes the sink contract, the event shape, and
the ``cognitum.*`` attribute name constants. Tracking issue #70 builds this
out further into a real emission pipeline -- trace propagation (D2), the
event/metric catalog (D4), dropped-event counting, and the content-free
fallback diagnostic hook all require the actual emit call sites this pass
does not wire up. No product client (meta_llm/meta_proxy/metaharness/
harnessaas) emits through this interface yet, and no OpenTelemetry adapter
ships in this pass.

The one piece of real logic in this module is :class:`NoopTelemetrySink`:
per D1, "a no-op sink is the default" is a functional requirement, not a
placeholder, so it is a genuine (if trivial) implementation.

Design decisions made in this pass where D1 does not fully specify a wire
shape (recorded here since they are not literal ADR quotes):

- :data:`TelemetrySeverity` is a conventional four-level set (``debug``,
  ``info``, ``warn``, ``error``) matching common logging/OpenTelemetry
  severity tiers. The ADR does not enumerate exact values.
- :class:`TraceContext` carries W3C ``trace_parent``/``trace_state``
  strings (D2's own vocabulary) so ``TelemetryEvent.trace_context`` has a
  stable optional shape for the D2 follow-up to populate; nothing
  constructs a non-``None`` value in this pass.
- ``attributes``/``measurements`` are open ``dict[str, Any]`` maps,
  matching how ``ExecutionReceipt.usage`` (``./receipts.py``) already
  models an open, schema-free map elsewhere in this module.
- ``TelemetrySink.flush`` takes a ``deadline_ms: float`` (milliseconds)
  rather than a duration object, so the same unit is usable verbatim across
  all three languages (Rust's ``u64``, Node's ``number`` would otherwise
  force a per-language conversion at the boundary).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

#: Severity of a :class:`TelemetryEvent`. ADR-0028 D1 does not specify exact
#: values -- see the module docstring for the design rationale.
TelemetrySeverity = Literal["debug", "info", "warn", "error"]


@dataclass(frozen=True)
class TraceContext:
    """W3C trace-context carrier (ADR-0028 D2).

    Optional at this layer: D2 trace propagation (generating or joining
    ``traceparent``/``tracestate``) is out of scope for this pass (tracking
    issue #70) -- this type exists so :attr:`TelemetryEvent.trace_context`
    has a stable shape for that follow-up to populate.
    """

    trace_parent: str | None = None
    trace_state: str | None = None


@dataclass(frozen=True)
class TelemetryEvent:
    """A single telemetry event (ADR-0028 D1).

    Per D1, sinks receive already-redacted events -- they never receive raw
    requests or responses through this interface. ``attributes``/
    ``measurements`` are open maps; the D3 attribute constants below name
    the stable, low-cardinality keys a caller SHOULD use when populating
    them.
    """

    name: str
    timestamp: str
    severity: TelemetrySeverity
    trace_context: TraceContext | None = None
    attributes: dict[str, Any] = field(default_factory=dict)
    measurements: dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class TelemetrySink(Protocol):
    """Optional telemetry sink boundary (ADR-0028 D1): "The core SDK
    defines a small optional sink rather than taking a required dependency
    on one observability vendor." Product clients accept a
    ``TelemetrySink``, mirroring the ``Protocol`` shape already established
    by :class:`~cognitum.agentic.credentials.CredentialProvider`
    (``./credentials.py``).

    Per D1, "Sink failures, timeouts, and backpressure MUST NOT fail or
    delay the product operation; the SDK counts dropped events and may
    emit one content-free diagnostic through a fallback hook." That
    call-site behavior (catching an ``emit``/``flush`` exception,
    incrementing a dropped-event counter, invoking the fallback hook)
    requires the actual emit call sites this pass does not wire up --
    tracked by issue #70. This protocol only defines the shape
    implementors satisfy.
    """

    async def emit(self, event: TelemetryEvent) -> None:
        """Emits one already-redacted :class:`TelemetryEvent`."""
        ...

    async def flush(self, deadline_ms: float) -> None:
        """Flushes any buffered events.

        ``deadline_ms`` bounds how long the sink may take; honoring the
        bound is the sink implementation's responsibility -- no shared
        timeout wrapper ships in this pass.
        """
        ...


class NoopTelemetrySink:
    """The default sink (ADR-0028 D1: "A no-op sink is the default.").

    This is real, functional logic, not a placeholder: ``emit`` performs no
    I/O and never raises; ``flush`` resolves immediately.
    """

    async def emit(self, event: TelemetryEvent) -> None:
        # Intentionally does nothing.
        return None

    async def flush(self, deadline_ms: float) -> None:
        # Intentionally resolves immediately.
        return None


# ---------------------------------------------------------------------
# D3: Safe semantic attribute names, `cognitum.*` namespace.
#
# These are named string CONSTANTS, not a Literal union: per D3 only the
# KEY names are fixed -- attribute VALUES are free-form (subject to each
# row's own cardinality rule below). This pass does not build a validator
# that enforces a cardinality rule at runtime; each constant's docstring
# records its rule from the ADR-0028 D3 table for future code to consult.
# ---------------------------------------------------------------------

#: ``cognitum.product`` -- e.g. ``meta-llm``. Cardinality rule: fixed set.
ATTR_PRODUCT = "cognitum.product"

#: ``cognitum.operation`` -- e.g. ``chat.completions.create``. Cardinality
#: rule: contract set.
ATTR_OPERATION = "cognitum.operation"

#: ``cognitum.protocol`` -- e.g. ``openai-chat``. Cardinality rule: contract
#: set.
ATTR_PROTOCOL = "cognitum.protocol"

#: ``cognitum.contract.version`` -- e.g. ``1.2``. Cardinality rule: low.
ATTR_CONTRACT_VERSION = "cognitum.contract.version"

#: ``cognitum.request.id`` -- opaque UUID. Cardinality rule: trace/log
#: only, never a metric label.
ATTR_REQUEST_ID = "cognitum.request.id"

#: ``cognitum.tenant.hash`` -- truncated keyed hash. Cardinality rule:
#: trace/log only.
ATTR_TENANT_HASH = "cognitum.tenant.hash"

#: ``cognitum.model.alias`` -- e.g. ``cognitum-auto``. Cardinality rule:
#: public aliases only; raw provider model optional and low-cardinality
#: guarded.
ATTR_MODEL_ALIAS = "cognitum.model.alias"

#: ``cognitum.tier`` -- ``low``, ``mid``, ``high``. Cardinality rule: fixed
#: set.
ATTR_TIER = "cognitum.tier"

#: ``cognitum.routing.plane`` -- ``local``, ``cloud``, ``passthrough``,
#: ``sponsored``. Cardinality rule: fixed set; only server/proxy-reported.
ATTR_ROUTING_PLANE = "cognitum.routing.plane"

#: ``cognitum.routing.reason`` -- contract code. Cardinality rule: bounded
#: enum, not free text.
ATTR_ROUTING_REASON = "cognitum.routing.reason"

#: ``cognitum.cache.result`` -- ``hit``, ``miss``, ``disabled``. Cardinality
#: rule: fixed set.
ATTR_CACHE_RESULT = "cognitum.cache.result"

#: ``cognitum.operation.state`` -- job/pod/batch state. Cardinality rule:
#: product contract set.
ATTR_OPERATION_STATE = "cognitum.operation.state"

#: ``cognitum.error.kind`` -- common error kind. Cardinality rule: fixed
#: set.
ATTR_ERROR_KIND = "cognitum.error.kind"

#: ``cognitum.retry.count`` -- integer. Cardinality rule: measurement.
ATTR_RETRY_COUNT = "cognitum.retry.count"


# ---------------------------------------------------------------------
# D4: Telemetry event names emitted "when a sink is configured" (ADR-0028
# D4, lines 126-146). These are named string CONSTANTS, one per literal
# dotted event name in the ADR's catalog -- unlike the metric instrument
# catalog (``./telemetry_metrics.py``), the ADR gives these as exact wire
# strings, so no naming decision was required beyond the
# ``EVENT_<SCREAMING_SNAKE_CASE>`` constant-naming convention itself. No
# emit call site exists in this pass -- these name the event a future call
# site MUST use, mirroring the D3 ``ATTR_*`` discipline above.
# ---------------------------------------------------------------------

#: ``request.start`` -- emitted when a request begins.
EVENT_REQUEST_START = "request.start"

#: ``request.retry_scheduled`` -- emitted when a retry has been scheduled.
EVENT_REQUEST_RETRY_SCHEDULED = "request.retry_scheduled"

#: ``request.end`` -- emitted when a request completes (success or failure).
EVENT_REQUEST_END = "request.end"

#: ``stream.first_event`` -- emitted on the first event of a stream.
EVENT_STREAM_FIRST_EVENT = "stream.first_event"

#: ``stream.end`` -- emitted when a stream completes.
EVENT_STREAM_END = "stream.end"

#: ``operation.state_changed`` -- emitted on an operation state transition.
EVENT_OPERATION_STATE_CHANGED = "operation.state_changed"

#: ``operation.wait_ended`` -- emitted when a caller's wait on an operation
#: ends.
EVENT_OPERATION_WAIT_ENDED = "operation.wait_ended"

#: ``capabilities.loaded`` -- emitted when a capability set has been loaded.
EVENT_CAPABILITIES_LOADED = "capabilities.loaded"

#: ``budget.reserved`` -- emitted when a cost reservation is made.
EVENT_BUDGET_RESERVED = "budget.reserved"

#: ``budget.committed`` -- emitted when a reservation is committed.
EVENT_BUDGET_COMMITTED = "budget.committed"

#: ``budget.released`` -- emitted when a reservation is released.
EVENT_BUDGET_RELEASED = "budget.released"

#: ``consent.required`` -- emitted when caller consent is required to
#: proceed.
EVENT_CONSENT_REQUIRED = "consent.required"

#: ``process.started`` -- emitted when a local subprocess starts.
EVENT_PROCESS_STARTED = "process.started"

#: ``process.ended`` -- emitted when a local subprocess ends.
EVENT_PROCESS_ENDED = "process.ended"

#: ``artifact.verified`` -- emitted when an artifact has been verified.
EVENT_ARTIFACT_VERIFIED = "artifact.verified"

#: ``evidence.verified`` -- emitted when evidence has been verified.
EVENT_EVIDENCE_VERIFIED = "evidence.verified"

#: ``telemetry.dropped`` -- emitted (via the fallback hook, per D1) when
#: the SDK drops a telemetry event.
EVENT_TELEMETRY_DROPPED = "telemetry.dropped"


__all__ = [
    "TelemetrySeverity",
    "TraceContext",
    "TelemetryEvent",
    "TelemetrySink",
    "NoopTelemetrySink",
    "ATTR_PRODUCT",
    "ATTR_OPERATION",
    "ATTR_PROTOCOL",
    "ATTR_CONTRACT_VERSION",
    "ATTR_REQUEST_ID",
    "ATTR_TENANT_HASH",
    "ATTR_MODEL_ALIAS",
    "ATTR_TIER",
    "ATTR_ROUTING_PLANE",
    "ATTR_ROUTING_REASON",
    "ATTR_CACHE_RESULT",
    "ATTR_OPERATION_STATE",
    "ATTR_ERROR_KIND",
    "ATTR_RETRY_COUNT",
    "EVENT_REQUEST_START",
    "EVENT_REQUEST_RETRY_SCHEDULED",
    "EVENT_REQUEST_END",
    "EVENT_STREAM_FIRST_EVENT",
    "EVENT_STREAM_END",
    "EVENT_OPERATION_STATE_CHANGED",
    "EVENT_OPERATION_WAIT_ENDED",
    "EVENT_CAPABILITIES_LOADED",
    "EVENT_BUDGET_RESERVED",
    "EVENT_BUDGET_COMMITTED",
    "EVENT_BUDGET_RELEASED",
    "EVENT_CONSENT_REQUIRED",
    "EVENT_PROCESS_STARTED",
    "EVENT_PROCESS_ENDED",
    "EVENT_ARTIFACT_VERIFIED",
    "EVENT_EVIDENCE_VERIFIED",
    "EVENT_TELEMETRY_DROPPED",
]
