//! `GET /api/v1/custody/epoch` response shape.

use serde::{Deserialize, Serialize};

use super::Extras;

/// Custody epoch record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CustodyEpoch {
    /// Monotonic epoch counter.
    #[serde(default)]
    pub epoch: u64,
    /// Epoch root hash (hex).
    #[serde(default)]
    pub root_hash: String,
    /// ISO-8601 timestamp the epoch opened.
    #[serde(default)]
    pub opened_at: Option<String>,
    #[serde(flatten)]
    pub extras: Extras,
}
