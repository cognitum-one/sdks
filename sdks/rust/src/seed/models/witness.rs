//! `GET /api/v1/witness/chain` response shape.

use serde::{Deserialize, Serialize};

use super::Extras;

/// Witness-chain integrity log.
///
/// The reference seed currently returns `{depth, epoch, head_hash}` —
/// none of which were the fields this model originally declared. Rather
/// than bake in the current server-side naming (which may still churn),
/// we keep the struct field-free and rely on the `extras` catch-all
/// (`#[serde(flatten)]`) to expose whatever the seed sends. This is
/// forward-compatible by construction.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WitnessChain {
    #[serde(flatten)]
    pub extras: Extras,
}
