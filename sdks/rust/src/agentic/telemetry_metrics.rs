//! §D4 metric instrument catalog (ADR-0028 §D4, lines 148-161). Type-only
//! scaffolding, mirroring §D3's `ATTR_*` constant-catalog discipline in
//! `./telemetry.rs`: this module names the metric *instruments* the SDK is
//! expected to emit once a real metrics adapter exists (tracking issue
//! #70) — it does not implement an OpenTelemetry meter, does not record
//! any measurement, and is not wired into any product client.
//!
//! ADR-0028 §D4 describes the metric catalog in PROSE ("request and stream
//! duration histograms", "request, retry, error, and cancellation
//! counters", ...), unlike its literal dotted event names (`request.start`,
//! ...) or its literal `cognitum.*` attribute names (§D3). Two naming
//! decisions were required here that are NOT direct ADR quotes:
//!
//! 1. Each bullet is expanded into one [`MetricInstrumentKind`] variant per
//!    concrete instrument (e.g. "input, output, cache, and safety token
//!    counters" -> four variants; "reserved, committed, released, and
//!    reconciled cost counters" -> four variants), so a future metrics
//!    adapter has one concrete registration point per instrument rather
//!    than one opaque bucket per bullet. This yields 19 variants total:
//!    2 duration histograms + 4 request-shape counters + 1 latency
//!    histogram + 4 token counters + 4 cost counters + 1 operation-state
//!    counter + 2 process counters + 1 verification counter.
//! 2. Each variant's wire name ([`MetricInstrumentKind::instrument_name`])
//!    follows the bare-dotted-word style of the §D4 *event* names
//!    (`request.start`, `stream.first_event`, ...) rather than the
//!    `cognitum.*`-namespaced style of the §D3 *attribute* names. An
//!    instrument name identifies a meter; an attribute key identifies a
//!    dimension recorded alongside a data point — those are different
//!    roles, and reusing e.g. `cognitum.retry.count` for both the §D3
//!    `ATTR_RETRY_COUNT` attribute AND a §D4 retry-count instrument would
//!    conflate them, so instrument names deliberately omit the `cognitum.`
//!    prefix.
//!
//! Per ADR-0028 §D4 (lines 159-161): "Request IDs, tenant IDs, operation
//! IDs, repository names, prompts, URLs, and raw model IDs MUST NOT be
//! metric dimensions. Money of different currencies is never summed into
//! one measurement." No validator enforces either rule in this pass — this
//! is a discoverability note for whoever wires real metric emission in a
//! follow-up. The four `Cost*` variants below in particular MUST be
//! recorded as separate measurements per currency, never summed together.

use serde::{Deserialize, Serialize};

/// Whether a [`MetricInstrumentKind`] is recorded as a histogram or a
/// monotonic counter. ADR-0028 §D4 explicitly distinguishes "duration ...
/// histograms" / "first-event latency histogram" from the various
/// "... counters" bullets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeasurementKind {
    Histogram,
    Counter,
}

/// The default metric instrument catalog (ADR-0028 §D4, lines 148-157).
/// One variant per concrete instrument named or implied by the §D4 prose
/// list — see the module doc comment for how bullets were expanded into
/// variants and how [`instrument_name`](MetricInstrumentKind::instrument_name)
/// was chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricInstrumentKind {
    /// "request ... duration histograms".
    RequestDuration,
    /// "... stream duration histograms".
    StreamDuration,
    /// "request ... counters".
    RequestCount,
    /// "... retry ... counters".
    RetryCount,
    /// "... error ... counters".
    ErrorCount,
    /// "... and cancellation counters".
    CancellationCount,
    /// "first-event latency histogram".
    FirstEventLatency,
    /// "input ... token counters when server-reported".
    InputTokenCount,
    /// "... output ... token counters when server-reported".
    OutputTokenCount,
    /// "... cache ... token counters when server-reported".
    CacheTokenCount,
    /// "... and safety token counters when server-reported".
    SafetyTokenCount,
    /// "reserved ... cost counters by currency". MUST NOT be summed across
    /// currencies (ADR-0028 §D4 line 161).
    CostReserved,
    /// "... committed ... cost counters by currency". MUST NOT be summed
    /// across currencies (ADR-0028 §D4 line 161).
    CostCommitted,
    /// "... released ... cost counters by currency". MUST NOT be summed
    /// across currencies (ADR-0028 §D4 line 161).
    CostReleased,
    /// "... and reconciled cost counters by currency". MUST NOT be summed
    /// across currencies (ADR-0028 §D4 line 161).
    CostReconciled,
    /// "operation state-transition counters".
    OperationStateTransitionCount,
    /// "process exit ... counters".
    ProcessExitCount,
    /// "... and forced-termination counters".
    ProcessForcedTerminationCount,
    /// "verification result counters".
    VerificationResultCount,
}

impl MetricInstrumentKind {
    /// Every catalog variant, in ADR-0028 §D4 prose order. Used by tests to
    /// assert the catalog's cardinality and cross-language parity.
    pub const ALL: &'static [MetricInstrumentKind] = &[
        Self::RequestDuration,
        Self::StreamDuration,
        Self::RequestCount,
        Self::RetryCount,
        Self::ErrorCount,
        Self::CancellationCount,
        Self::FirstEventLatency,
        Self::InputTokenCount,
        Self::OutputTokenCount,
        Self::CacheTokenCount,
        Self::SafetyTokenCount,
        Self::CostReserved,
        Self::CostCommitted,
        Self::CostReleased,
        Self::CostReconciled,
        Self::OperationStateTransitionCount,
        Self::ProcessExitCount,
        Self::ProcessForcedTerminationCount,
        Self::VerificationResultCount,
    ];

    /// The instrument's stable wire name. See the module doc comment for
    /// why this does not carry the `cognitum.*` prefix used by §D3
    /// attributes.
    pub fn instrument_name(&self) -> &'static str {
        match self {
            Self::RequestDuration => "request.duration",
            Self::StreamDuration => "stream.duration",
            Self::RequestCount => "request.count",
            Self::RetryCount => "retry.count",
            Self::ErrorCount => "error.count",
            Self::CancellationCount => "cancellation.count",
            Self::FirstEventLatency => "stream.first_event.latency",
            Self::InputTokenCount => "token.input.count",
            Self::OutputTokenCount => "token.output.count",
            Self::CacheTokenCount => "token.cache.count",
            Self::SafetyTokenCount => "token.safety.count",
            Self::CostReserved => "cost.reserved",
            Self::CostCommitted => "cost.committed",
            Self::CostReleased => "cost.released",
            Self::CostReconciled => "cost.reconciled",
            Self::OperationStateTransitionCount => "operation.state_transition.count",
            Self::ProcessExitCount => "process.exit.count",
            Self::ProcessForcedTerminationCount => "process.forced_termination.count",
            Self::VerificationResultCount => "verification.result.count",
        }
    }

    /// Histogram vs counter, per ADR-0028 §D4's explicit distinction.
    pub fn measurement_kind(&self) -> MeasurementKind {
        match self {
            Self::RequestDuration | Self::StreamDuration | Self::FirstEventLatency => {
                MeasurementKind::Histogram
            }
            Self::RequestCount
            | Self::RetryCount
            | Self::ErrorCount
            | Self::CancellationCount
            | Self::InputTokenCount
            | Self::OutputTokenCount
            | Self::CacheTokenCount
            | Self::SafetyTokenCount
            | Self::CostReserved
            | Self::CostCommitted
            | Self::CostReleased
            | Self::CostReconciled
            | Self::OperationStateTransitionCount
            | Self::ProcessExitCount
            | Self::ProcessForcedTerminationCount
            | Self::VerificationResultCount => MeasurementKind::Counter,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_exactly_nineteen_instruments() {
        assert_eq!(MetricInstrumentKind::ALL.len(), 19);
    }

    #[test]
    fn instrument_names_match_expected_wire_strings() {
        assert_eq!(MetricInstrumentKind::RequestDuration.instrument_name(), "request.duration");
        assert_eq!(MetricInstrumentKind::StreamDuration.instrument_name(), "stream.duration");
        assert_eq!(MetricInstrumentKind::RequestCount.instrument_name(), "request.count");
        assert_eq!(MetricInstrumentKind::RetryCount.instrument_name(), "retry.count");
        assert_eq!(MetricInstrumentKind::ErrorCount.instrument_name(), "error.count");
        assert_eq!(
            MetricInstrumentKind::CancellationCount.instrument_name(),
            "cancellation.count"
        );
        assert_eq!(
            MetricInstrumentKind::FirstEventLatency.instrument_name(),
            "stream.first_event.latency"
        );
        assert_eq!(MetricInstrumentKind::InputTokenCount.instrument_name(), "token.input.count");
        assert_eq!(MetricInstrumentKind::OutputTokenCount.instrument_name(), "token.output.count");
        assert_eq!(MetricInstrumentKind::CacheTokenCount.instrument_name(), "token.cache.count");
        assert_eq!(MetricInstrumentKind::SafetyTokenCount.instrument_name(), "token.safety.count");
        assert_eq!(MetricInstrumentKind::CostReserved.instrument_name(), "cost.reserved");
        assert_eq!(MetricInstrumentKind::CostCommitted.instrument_name(), "cost.committed");
        assert_eq!(MetricInstrumentKind::CostReleased.instrument_name(), "cost.released");
        assert_eq!(MetricInstrumentKind::CostReconciled.instrument_name(), "cost.reconciled");
        assert_eq!(
            MetricInstrumentKind::OperationStateTransitionCount.instrument_name(),
            "operation.state_transition.count"
        );
        assert_eq!(MetricInstrumentKind::ProcessExitCount.instrument_name(), "process.exit.count");
        assert_eq!(
            MetricInstrumentKind::ProcessForcedTerminationCount.instrument_name(),
            "process.forced_termination.count"
        );
        assert_eq!(
            MetricInstrumentKind::VerificationResultCount.instrument_name(),
            "verification.result.count"
        );
    }

    #[test]
    fn measurement_kind_matches_adr_histogram_vs_counter_classification() {
        let histograms = [
            MetricInstrumentKind::RequestDuration,
            MetricInstrumentKind::StreamDuration,
            MetricInstrumentKind::FirstEventLatency,
        ];
        for kind in histograms {
            assert_eq!(kind.measurement_kind(), MeasurementKind::Histogram, "{kind:?}");
        }

        for kind in MetricInstrumentKind::ALL {
            if !histograms.contains(kind) {
                assert_eq!(kind.measurement_kind(), MeasurementKind::Counter, "{kind:?}");
            }
        }
    }

    #[test]
    fn all_const_has_no_duplicate_instrument_names() {
        let mut names: Vec<&str> =
            MetricInstrumentKind::ALL.iter().map(|k| k.instrument_name()).collect();
        let original_len = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), original_len, "duplicate instrument names found");
    }
}
