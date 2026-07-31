//! `TelemetrySink` / `TelemetryEvent` type-only stubs and safe semantic
//! attribute constants (ADR-0028 §D1, §D3). This is M6's first pass: it
//! freezes the sink contract, the event shape, and the `cognitum.*`
//! attribute name constants. Tracking issue #70 builds this out further into
//! a real emission pipeline — trace propagation (§D2), the event/metric
//! catalog (§D4), dropped-event counting, and the content-free fallback
//! diagnostic hook all require the actual emit call sites this pass does not
//! wire up. No product client (`meta_llm`, `meta_proxy`, `metaharness`,
//! `harnessaas`) emits through this interface yet, and no OpenTelemetry
//! adapter ships in this pass.
//!
//! The one piece of real logic in this module is [`NoopTelemetrySink`]: per
//! §D1, "a no-op sink is the default" is a functional requirement, not a
//! placeholder, so it is a genuine (if trivial) implementation.
//!
//! Design decisions made in this pass where §D1 does not fully specify a
//! wire shape (recorded here since they are not literal ADR quotes):
//! - [`TelemetrySeverity`] is a conventional four-level set (`debug`, `info`,
//!   `warn`, `error`) matching common logging/OpenTelemetry severity tiers.
//!   The ADR does not enumerate exact values.
//! - [`TraceContext`] carries W3C `trace_parent`/`trace_state` strings
//!   (§D2's own vocabulary) so [`TelemetryEvent::trace_context`] has a
//!   stable optional shape for the §D2 follow-up to populate; nothing
//!   constructs a non-`None` value in this pass.
//! - `attributes`/`measurements` are open `HashMap<String, serde_json::Value>`
//!   maps, matching how `ExecutionReceipt::usage` (`./receipts.rs`) already
//!   models an open, schema-free map elsewhere in this module.
//! - `TelemetrySink::flush` takes a `deadline_ms: u64` (milliseconds) rather
//!   than a `std::time::Duration`, so the same unit is usable verbatim
//!   across all three languages (Node's `number`, Python's `float` seconds
//!   would otherwise force a per-language conversion at the boundary).

use std::collections::HashMap;
use std::fmt;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::agentic::errors::AgenticError;

/// Severity of a [`TelemetryEvent`]. ADR-0028 §D1 does not specify exact
/// values — see the module doc comment for the design rationale.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TelemetrySeverity {
    Debug,
    Info,
    Warn,
    Error,
}

/// W3C trace-context carrier (ADR-0028 §D2). Optional at this layer: §D2
/// trace propagation (generating or joining `traceparent`/`tracestate`) is
/// out of scope for this pass (tracking issue #70) — this type exists so
/// [`TelemetryEvent::trace_context`] has a stable shape for that follow-up
/// to populate.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceContext {
    pub trace_parent: Option<String>,
    pub trace_state: Option<String>,
}

/// A single telemetry event (ADR-0028 §D1). Per §D1, sinks receive
/// already-redacted events — they never receive raw requests or responses
/// through this interface. `attributes`/`measurements` are open maps; the
/// §D3 attribute constants below name the stable, low-cardinality keys a
/// caller SHOULD use when populating them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryEvent {
    pub name: String,
    pub timestamp: String,
    pub severity: TelemetrySeverity,
    pub trace_context: Option<TraceContext>,
    pub attributes: HashMap<String, serde_json::Value>,
    pub measurements: HashMap<String, serde_json::Value>,
}

/// Optional telemetry sink boundary (ADR-0028 §D1): "The core SDK defines a
/// small optional sink rather than taking a required dependency on one
/// observability vendor." Product clients accept `Arc<dyn TelemetrySink>`,
/// mirroring the `Arc<dyn CredentialProvider>` / `Arc<dyn SecretRedactor>`
/// trait-object pattern already used on `RequestContext` (`./context.rs`),
/// and the `#[async_trait]` + `Send + Sync` shape already established by
/// `CredentialProvider` (`./credentials.rs`).
///
/// Per §D1, "Sink failures, timeouts, and backpressure MUST NOT fail or
/// delay the product operation; the SDK counts dropped events and may emit
/// one content-free diagnostic through a fallback hook." That call-site
/// behavior (catching an `emit`/`flush` error, incrementing a dropped-event
/// counter, invoking the fallback hook) requires the actual emit call sites
/// this pass does not wire up — tracked by issue #70. This trait only
/// defines the shape implementors satisfy; `emit`/`flush` returning
/// `Result` lets an implementor report failure without this trait itself
/// deciding how a caller reacts to it.
#[async_trait]
pub trait TelemetrySink: fmt::Debug + Send + Sync {
    /// Emits one already-redacted [`TelemetryEvent`].
    async fn emit(&self, event: TelemetryEvent) -> Result<(), AgenticError>;

    /// Flushes any buffered events. `deadline_ms` bounds how long the sink
    /// may take; honoring the bound is the sink implementation's
    /// responsibility — no shared timeout wrapper ships in this pass.
    async fn flush(&self, deadline_ms: u64) -> Result<(), AgenticError>;
}

/// The default sink (ADR-0028 §D1: "A no-op sink is the default."). This is
/// real, functional logic, not a placeholder: `emit` performs no I/O and
/// never fails; `flush` resolves immediately.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopTelemetrySink;

impl NoopTelemetrySink {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl TelemetrySink for NoopTelemetrySink {
    async fn emit(&self, _event: TelemetryEvent) -> Result<(), AgenticError> {
        Ok(())
    }

    async fn flush(&self, _deadline_ms: u64) -> Result<(), AgenticError> {
        Ok(())
    }
}

// ---------------------------------------------------------------------
// §D3: Safe semantic attribute names, `cognitum.*` namespace.
//
// These are named string CONSTANTS, not an enum: per §D3 only the KEY names
// are fixed — attribute VALUES are free-form (subject to each row's own
// cardinality rule below). This pass does not build a validator that
// enforces a cardinality rule at runtime; each constant's doc comment
// records its rule from the ADR-0028 §D3 table for future code to consult.
// ---------------------------------------------------------------------

/// `cognitum.product` — e.g. `meta-llm`. Cardinality rule: fixed set.
pub const ATTR_PRODUCT: &str = "cognitum.product";

/// `cognitum.operation` — e.g. `chat.completions.create`. Cardinality rule:
/// contract set.
pub const ATTR_OPERATION: &str = "cognitum.operation";

/// `cognitum.protocol` — e.g. `openai-chat`. Cardinality rule: contract set.
pub const ATTR_PROTOCOL: &str = "cognitum.protocol";

/// `cognitum.contract.version` — e.g. `1.2`. Cardinality rule: low.
pub const ATTR_CONTRACT_VERSION: &str = "cognitum.contract.version";

/// `cognitum.request.id` — opaque UUID. Cardinality rule: trace/log only,
/// never a metric label.
pub const ATTR_REQUEST_ID: &str = "cognitum.request.id";

/// `cognitum.tenant.hash` — truncated keyed hash. Cardinality rule:
/// trace/log only.
pub const ATTR_TENANT_HASH: &str = "cognitum.tenant.hash";

/// `cognitum.model.alias` — e.g. `cognitum-auto`. Cardinality rule: public
/// aliases only; raw provider model optional and low-cardinality guarded.
pub const ATTR_MODEL_ALIAS: &str = "cognitum.model.alias";

/// `cognitum.tier` — `low`, `mid`, `high`. Cardinality rule: fixed set.
pub const ATTR_TIER: &str = "cognitum.tier";

/// `cognitum.routing.plane` — `local`, `cloud`, `passthrough`, `sponsored`.
/// Cardinality rule: fixed set; only server/proxy-reported.
pub const ATTR_ROUTING_PLANE: &str = "cognitum.routing.plane";

/// `cognitum.routing.reason` — contract code. Cardinality rule: bounded
/// enum, not free text.
pub const ATTR_ROUTING_REASON: &str = "cognitum.routing.reason";

/// `cognitum.cache.result` — `hit`, `miss`, `disabled`. Cardinality rule:
/// fixed set.
pub const ATTR_CACHE_RESULT: &str = "cognitum.cache.result";

/// `cognitum.operation.state` — job/pod/batch state. Cardinality rule:
/// product contract set.
pub const ATTR_OPERATION_STATE: &str = "cognitum.operation.state";

/// `cognitum.error.kind` — common error kind. Cardinality rule: fixed set.
pub const ATTR_ERROR_KIND: &str = "cognitum.error.kind";

/// `cognitum.retry.count` — integer. Cardinality rule: measurement.
pub const ATTR_RETRY_COUNT: &str = "cognitum.retry.count";

// ---------------------------------------------------------------------
// §D4: Telemetry event names emitted "when a sink is configured" (ADR-0028
// §D4, lines 126-146). These are named string CONSTANTS, one per literal
// dotted event name in the ADR's catalog — unlike the metric instrument
// catalog (`./telemetry_metrics.rs`), the ADR gives these as exact wire
// strings, so no naming decision was required beyond the
// `EVENT_<SCREAMING_SNAKE_CASE>` constant-naming convention itself. No emit
// call site exists in this pass — these name the event a future call site
// MUST use, mirroring the §D3 `ATTR_*` discipline above.
// ---------------------------------------------------------------------

/// `request.start` — emitted when a request begins.
pub const EVENT_REQUEST_START: &str = "request.start";

/// `request.retry_scheduled` — emitted when a retry has been scheduled.
pub const EVENT_REQUEST_RETRY_SCHEDULED: &str = "request.retry_scheduled";

/// `request.end` — emitted when a request completes (success or failure).
pub const EVENT_REQUEST_END: &str = "request.end";

/// `stream.first_event` — emitted on the first event of a stream.
pub const EVENT_STREAM_FIRST_EVENT: &str = "stream.first_event";

/// `stream.end` — emitted when a stream completes.
pub const EVENT_STREAM_END: &str = "stream.end";

/// `operation.state_changed` — emitted on an operation state transition.
pub const EVENT_OPERATION_STATE_CHANGED: &str = "operation.state_changed";

/// `operation.wait_ended` — emitted when a caller's wait on an operation ends.
pub const EVENT_OPERATION_WAIT_ENDED: &str = "operation.wait_ended";

/// `capabilities.loaded` — emitted when a capability set has been loaded.
pub const EVENT_CAPABILITIES_LOADED: &str = "capabilities.loaded";

/// `budget.reserved` — emitted when a cost reservation is made.
pub const EVENT_BUDGET_RESERVED: &str = "budget.reserved";

/// `budget.committed` — emitted when a reservation is committed.
pub const EVENT_BUDGET_COMMITTED: &str = "budget.committed";

/// `budget.released` — emitted when a reservation is released.
pub const EVENT_BUDGET_RELEASED: &str = "budget.released";

/// `consent.required` — emitted when caller consent is required to proceed.
pub const EVENT_CONSENT_REQUIRED: &str = "consent.required";

/// `process.started` — emitted when a local subprocess starts.
pub const EVENT_PROCESS_STARTED: &str = "process.started";

/// `process.ended` — emitted when a local subprocess ends.
pub const EVENT_PROCESS_ENDED: &str = "process.ended";

/// `artifact.verified` — emitted when an artifact has been verified.
pub const EVENT_ARTIFACT_VERIFIED: &str = "artifact.verified";

/// `evidence.verified` — emitted when evidence has been verified.
pub const EVENT_EVIDENCE_VERIFIED: &str = "evidence.verified";

/// `telemetry.dropped` — emitted (via the fallback hook, per §D1) when the
/// SDK drops a telemetry event.
pub const EVENT_TELEMETRY_DROPPED: &str = "telemetry.dropped";

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_event() -> TelemetryEvent {
        TelemetryEvent {
            name: "request.start".to_string(),
            timestamp: "2026-07-19T00:00:00Z".to_string(),
            severity: TelemetrySeverity::Info,
            trace_context: None,
            attributes: HashMap::new(),
            measurements: HashMap::new(),
        }
    }

    #[tokio::test]
    async fn noop_sink_emit_does_nothing_and_never_errors() {
        let sink = NoopTelemetrySink::new();
        let result = sink.emit(sample_event()).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn noop_sink_flush_resolves_immediately_and_never_errors() {
        let sink = NoopTelemetrySink::new();
        let result = sink.flush(5_000).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn noop_sink_usable_as_a_trait_object() {
        let sink: Box<dyn TelemetrySink> = Box::new(NoopTelemetrySink::new());
        assert!(sink.emit(sample_event()).await.is_ok());
        assert!(sink.flush(0).await.is_ok());
    }

    #[test]
    fn d3_attribute_constants_match_adr_0028_table_exactly() {
        assert_eq!(ATTR_PRODUCT, "cognitum.product");
        assert_eq!(ATTR_OPERATION, "cognitum.operation");
        assert_eq!(ATTR_PROTOCOL, "cognitum.protocol");
        assert_eq!(ATTR_CONTRACT_VERSION, "cognitum.contract.version");
        assert_eq!(ATTR_REQUEST_ID, "cognitum.request.id");
        assert_eq!(ATTR_TENANT_HASH, "cognitum.tenant.hash");
        assert_eq!(ATTR_MODEL_ALIAS, "cognitum.model.alias");
        assert_eq!(ATTR_TIER, "cognitum.tier");
        assert_eq!(ATTR_ROUTING_PLANE, "cognitum.routing.plane");
        assert_eq!(ATTR_ROUTING_REASON, "cognitum.routing.reason");
        assert_eq!(ATTR_CACHE_RESULT, "cognitum.cache.result");
        assert_eq!(ATTR_OPERATION_STATE, "cognitum.operation.state");
        assert_eq!(ATTR_ERROR_KIND, "cognitum.error.kind");
        assert_eq!(ATTR_RETRY_COUNT, "cognitum.retry.count");
    }

    #[test]
    fn telemetry_event_serializes_camel_case_and_round_trips() {
        let event = TelemetryEvent {
            name: "request.end".to_string(),
            timestamp: "2026-07-19T00:00:01Z".to_string(),
            severity: TelemetrySeverity::Warn,
            trace_context: Some(TraceContext {
                trace_parent: Some("00-abc-def-01".to_string()),
                trace_state: None,
            }),
            attributes: HashMap::from([(
                ATTR_PRODUCT.to_string(),
                serde_json::json!("meta-llm"),
            )]),
            measurements: HashMap::new(),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["traceContext"]["traceParent"], serde_json::json!("00-abc-def-01"));
        assert_eq!(json["severity"], serde_json::json!("warn"));

        let round_tripped: TelemetryEvent = serde_json::from_value(json).unwrap();
        assert_eq!(round_tripped.name, "request.end");
        assert_eq!(round_tripped.severity, TelemetrySeverity::Warn);
    }

    #[test]
    fn d4_event_constants_match_adr_0028_catalog_exactly() {
        assert_eq!(EVENT_REQUEST_START, "request.start");
        assert_eq!(EVENT_REQUEST_RETRY_SCHEDULED, "request.retry_scheduled");
        assert_eq!(EVENT_REQUEST_END, "request.end");
        assert_eq!(EVENT_STREAM_FIRST_EVENT, "stream.first_event");
        assert_eq!(EVENT_STREAM_END, "stream.end");
        assert_eq!(EVENT_OPERATION_STATE_CHANGED, "operation.state_changed");
        assert_eq!(EVENT_OPERATION_WAIT_ENDED, "operation.wait_ended");
        assert_eq!(EVENT_CAPABILITIES_LOADED, "capabilities.loaded");
        assert_eq!(EVENT_BUDGET_RESERVED, "budget.reserved");
        assert_eq!(EVENT_BUDGET_COMMITTED, "budget.committed");
        assert_eq!(EVENT_BUDGET_RELEASED, "budget.released");
        assert_eq!(EVENT_CONSENT_REQUIRED, "consent.required");
        assert_eq!(EVENT_PROCESS_STARTED, "process.started");
        assert_eq!(EVENT_PROCESS_ENDED, "process.ended");
        assert_eq!(EVENT_ARTIFACT_VERIFIED, "artifact.verified");
        assert_eq!(EVENT_EVIDENCE_VERIFIED, "evidence.verified");
        assert_eq!(EVENT_TELEMETRY_DROPPED, "telemetry.dropped");
    }

    #[test]
    fn d4_event_catalog_has_exactly_seventeen_entries() {
        let all = [
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
        ];
        assert_eq!(all.len(), 17);
    }
}
