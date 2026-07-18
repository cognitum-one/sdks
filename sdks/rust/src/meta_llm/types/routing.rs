//! ADR-0024b §D2: routing types and precedence. Issue #59, D11 migration
//! step 1 ("Release routing receipt and usage read-only support after
//! ADR-0024a serving").
//!
//! `ModelSelector` deliberately has NO escape hatch for a raw provider
//! model ID -- `Auto`, a `ModelTier`, or a contract-declared alias string
//! are the only three shapes the audited resolver accepts; anything else
//! is rejected server-side as `model_not_found` (§D2). This is a
//! deliberate rejection, not an oversight, so no fourth "raw model id"
//! variant is added here.
//!
//! Unlike the Node/Python SDKs (where routing enums are string literal
//! types/`Literal`s that are NOT enforced at runtime), Rust's closed
//! `enum`s make sending an unrecognized `ModelTier`/`FallbackPolicy`/
//! `EscalationStrategy`/`CacheMode`/`SafetyMode` a *compile-time*
//! impossibility -- there is no runtime "unrecognized enum member" state
//! to reject for those fields. The one remaining runtime-checkable
//! invariant is `ModelSelector::ContractDeclaredAlias`'s `alias: String`,
//! which could still be empty; [`assert_sendable_routing_controls`]
//! checks exactly that, mirroring the other two languages' validation
//! for the one field a Rust enum can't close off by construction.
//!
//! Unknown values RECEIVED from the server (e.g. a `resolved_tier` that
//! predates this SDK's enum) must be preserved rather than dropped -- see
//! `super::receipt`, which types those response fields as plain `String`
//! so an unrecognized wire value still round-trips instead of being
//! rejected.
//!
//! Body controls win over `X-Cognitum-*` headers (§D2) -- this SDK never
//! exposes a generic header-override surface for routing, safety, auth,
//! request ID, idempotency, trace, host, or content-length fields (see
//! `super::super::nonstream`/`super::super::client`: headers are built
//! internally from typed fields only), so there is no header path these
//! controls could lose to.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelTier {
    Low,
    Mid,
    High,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModelSelector {
    Auto,
    Tier { tier: ModelTier },
    ContractDeclaredAlias { alias: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FallbackPolicy {
    FailFast,
    BestEffort,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EscalationStrategy {
    StreamOneshot,
    PostHoc,
    Buffered,
    Inflight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CacheMode {
    Disabled,
    Exact,
    Semantic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SafetyMode {
    Block,
    Warn,
    Redact,
}

/// Opaque, sanitized attribution metadata (ADR-0024b §D2). Included in
/// operation/idempotency metadata where contracted, but never treated as
/// tenant, budget, rate-limit, or resource-owner authority.
pub type SubTenantAttribution = String;

/// ADR-0024b §D2's `MetaLlmRoutingControls`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct MetaLlmRoutingControls {
    pub model: Option<ModelSelector>,
    pub min_tier: Option<ModelTier>,
    pub max_tier: Option<ModelTier>,
    pub fallback_policy: Option<FallbackPolicy>,
    pub escalation: Option<EscalationStrategy>,
    pub cache: Option<CacheMode>,
    pub safety: Option<SafetyMode>,
    pub sub_tenant_id: Option<SubTenantAttribution>,
}

/// Raised by [`assert_sendable_routing_controls`]; never raised by response parsing.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct UnsendableRoutingControlsError(pub String);

/// Validates a caller-supplied `MetaLlmRoutingControls` immediately before
/// it is serialized onto the wire. The closed Rust `enum`s already make
/// most "unrecognized value" states unconstructible; this only covers the
/// one field that can't be closed off that way (see module docs).
pub fn assert_sendable_routing_controls(
    controls: Option<&MetaLlmRoutingControls>,
) -> Result<(), UnsendableRoutingControlsError> {
    let Some(controls) = controls else {
        return Ok(());
    };
    if let Some(ModelSelector::ContractDeclaredAlias { alias }) = &controls.model {
        if alias.is_empty() {
            return Err(UnsendableRoutingControlsError(
                "ModelSelector::ContractDeclaredAlias requires a non-empty alias string"
                    .to_owned(),
            ));
        }
    }
    Ok(())
}
