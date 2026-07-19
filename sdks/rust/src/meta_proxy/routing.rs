//! Data-plane routing intent and decode-time verification (ADR-0025a §D5).
//!
//! The SDK does NOT implement a router. Per §D5 ("The SDK communicates
//! supported intent and verifies the decision; it does not implement another
//! router"), this module carries exactly two things:
//!
//!  - [`RoutingIntent`], the caller-supplied intent forwarded to the Proxy;
//!  - [`assert_routing_receipt_matches_intent`], the one decode-time check
//!    §D5 rule 7 mandates: "`required_plane` mismatch is a protocol violation
//!    even if output succeeds."
//!
//! No plane selection, failover, consent evaluation, or utilization-threshold
//! logic lives here — those are the Proxy's job (§D5), and the economy/standard
//! thresholds are "implementation data, not SDK constants."

use crate::agentic::{AgenticError, AgenticErrorKind};

use super::status::{MetaProxyRoutingReceipt, RoutingPlane, WorkloadPolicy};
use super::PRODUCT;

/// Caller intent describing which plane(s) and policy a request may use
/// (ADR-0025a §D5). This is transmitted to the Proxy, which does the actual
/// routing; the SDK only states intent and verifies the receipt.
#[derive(Debug, Clone)]
pub struct RoutingIntent {
    /// When set, the response's routing receipt MUST report this exact plane
    /// or the call is a protocol violation (§D5 rule 7) — even on an
    /// otherwise-successful 200.
    pub required_plane: Option<RoutingPlane>,
    /// Planes the caller is willing to accept when `required_plane` is unset.
    /// Advisory intent forwarded to the Proxy; the SDK does not itself select
    /// among them.
    pub allowed_planes: Vec<RoutingPlane>,
    /// Workload urgency (§D5). `critical` suppresses automatic failover on the
    /// Proxy side; the SDK does not implement that, it only conveys the class.
    pub workload_policy: WorkloadPolicy,
    /// Optional utilization ceiling (0.0..=1.0). Interpreted by the Proxy
    /// against its own thresholds — "implementation data, not SDK constants."
    pub max_utilization: Option<f64>,
    /// ADR-0022 consent grant IDs the caller is presenting (§D5/§D9). Presence
    /// of a credential is never consent — these are the explicit grants.
    pub consent_grants: Vec<String>,
    /// Whether the caller opts into training contribution (§D5/§D9). Reported
    /// independently and without content.
    pub training_share: bool,
    /// Whether an unavailable required plane should fail rather than degrade
    /// (§D5). Conveyed to the Proxy; not acted on locally.
    pub fail_if_unavailable: bool,
}

impl Default for RoutingIntent {
    fn default() -> Self {
        Self {
            required_plane: None,
            allowed_planes: Vec::new(),
            workload_policy: WorkloadPolicy::Standard,
            max_utilization: None,
            consent_grants: Vec::new(),
            training_share: false,
            fail_if_unavailable: false,
        }
    }
}

/// Verify a routing receipt against the caller's intent (ADR-0025a §D5 rule
/// 7). Returns `Err(Protocol)` — deliberately NON-retryable, since a retry
/// "never changes plane" (§D5 rule 2) so it could not fix a plane mismatch —
/// when `intent.required_plane` is set and does not equal the receipt's
/// `selected_plane`. A protocol violation here holds even when the HTTP call
/// was a 200 with a well-formed body.
///
/// `intent` is `Option` so the caller can pass it through unconditionally;
/// `None` (or a `required_plane` of `None`) is always `Ok(())` — an
/// unconstrained request accepts whatever plane the Proxy chose.
#[allow(clippy::result_large_err)]
pub(crate) fn assert_routing_receipt_matches_intent(
    intent: Option<&RoutingIntent>,
    receipt: &MetaProxyRoutingReceipt,
) -> Result<(), AgenticError> {
    let Some(required) = intent.and_then(|i| i.required_plane) else {
        return Ok(());
    };
    if required.wire_str() == receipt.selected_plane {
        return Ok(());
    }
    Err(AgenticError {
        product: Some(PRODUCT.to_owned()),
        operation: Some("chat_completions".to_owned()),
        request_id: Some(receipt.request_id.clone()),
        ..AgenticError::new(
            AgenticErrorKind::Protocol,
            format!(
                "routing receipt reports selected_plane \"{}\" but the caller required \
                 plane \"{}\" (ADR-0025a §D5 rule 7: a required_plane mismatch is a \
                 protocol violation even if output succeeds)",
                receipt.selected_plane,
                required.wire_str(),
            ),
        )
    })
}
