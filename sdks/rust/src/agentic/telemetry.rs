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
}
