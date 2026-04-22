//! `GET /api/v1/custody/epoch` response shape.

use serde::{Deserialize, Serialize};

use super::Extras;

/// Custody epoch record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CustodyEpoch {
    /// Monotonic epoch counter.
    #[serde(default)]
    pub epoch: u64,
    #[serde(flatten)]
    pub extras: Extras,
}
