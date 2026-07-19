//! Status, capabilities, and plane-evidence wire types (ADR-0025a §D4).
//!
//! No service-owned OpenAPI contract exists yet for `/status` (§D11 gate #1
//! is not yet published), so `MetaProxyStatus` stays intentionally
//! permissive (`raw` passthrough for unrecognized fields), matching the
//! same convention `crate::meta_llm::discovery` uses for the same reason.
//!
//! `RoutingPlane` and `WorkloadPolicy` are formally defined in §D5
//! (data-plane and policy model), which is explicitly OUT of scope for this
//! pass — they are declared here only because §D4's `MetaProxyStatus`
//! fields reference them. No routing, consent, or plane-selection LOGIC
//! from §D5 is implemented here.

use std::collections::HashMap;

use serde_json::Value;

/// The plane an inference request is (or would be) routed through
/// (ADR-0025a §D5). Reference-only in this pass — no plane-selection logic
/// is implemented; `MetaProxyStatus` fields that carry a plane are typed as
/// plain `String` (see its doc comment) rather than this enum, consistent
/// with "no contract yet" fields elsewhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoutingPlane {
    Local,
    CognitumCloud,
    AnthropicPassthrough,
    SponsoredCognitum,
}

/// Workload urgency classification (ADR-0025a §D5). Reference-only this pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkloadPolicy {
    Critical,
    Standard,
    Economy,
}

/// `status()` response (ADR-0025a §D4). `configured_plane`/`selected_plane`/
/// `workload_policy` are typed as plain `String` rather than the
/// [`RoutingPlane`]/[`WorkloadPolicy`] enums above — the Proxy's `/status`
/// route has no published OpenAPI contract yet (§D11 gate #1), so this
/// stays permissive rather than pretending to validate a contract that
/// does not exist, matching `MetaLlmHealth`'s precedent. Values SHOULD be
/// one of the documented constants but the SDK does not reject an
/// unrecognized one.
#[derive(Debug, Clone)]
pub struct MetaProxyStatus {
    pub product_version: String,
    pub protocol_version: Option<String>,
    /// SDK/protocol compatibility range, format not yet contracted (§D11 gate #2).
    pub compatible_sdk_range: Option<String>,
    pub process_state: String,
    /// The loopback `host:port` the Proxy is bound to.
    pub bind: Option<String>,
    pub configured_plane: String,
    pub selected_plane: String,
    pub routing_reason: Option<String>,
    pub automatic_usage_state: Option<String>,
    pub utilization: Option<f64>,
    pub reset_at: Option<String>,
    pub workload_policy: Option<String>,
    pub sponsored_available: Option<bool>,
    pub cloud_credential_source: Option<String>,
    pub limitations: Vec<String>,
    pub request_id: String,
    /// Unrecognized fields from the server response, preserved verbatim.
    pub raw: HashMap<String, Value>,
}

impl MetaProxyStatus {
    /// The wire keys `parse_status` (in `super::client`) treats as "known"
    /// — everything else observed on the response body goes to `raw`.
    pub(crate) fn known_keys() -> &'static [&'static str] {
        &[
            "product_version",
            "protocol_version",
            "compatible_sdk_range",
            "process_state",
            "bind",
            "configured_plane",
            "selected_plane",
            "routing_reason",
            "automatic_usage_state",
            "utilization",
            "reset_at",
            "workload_policy",
            "sponsored_available",
            "cloud_credential_source",
            "limitations",
            "request_id",
        ]
    }
}

/// Plane-routing evidence attached to an inference response or terminal
/// stream event (ADR-0025a §D4). Reserved for §D7 (inference/forwarding
/// contract) — `status()`/`capabilities()` in this pass never construct
/// one, since a routing receipt describes an inference call's plane
/// selection, which does not exist yet. Declared now so §D4's full contract
/// is represented in the type system ahead of §D7 landing.
#[derive(Debug, Clone)]
pub struct MetaProxyRoutingReceipt {
    pub request_id: String,
    pub configured_plane: String,
    pub selected_plane: String,
    pub routing_reason: Option<String>,
    pub automatic: bool,
    pub workload_policy: Option<String>,
    pub consent_evidence_id: Option<String>,
    pub upstream_receipt: Option<Value>,
    pub local_usage: Option<HashMap<String, Value>>,
    pub degraded: bool,
    pub warnings: Option<Vec<String>>,
}
