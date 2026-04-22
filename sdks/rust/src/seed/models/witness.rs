//! `GET /api/v1/witness/chain` response shape.

use serde::{Deserialize, Serialize};

use super::Extras;

/// Witness-chain integrity log.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WitnessChain {
    /// Chain length (entry count).
    #[serde(default)]
    pub chain_length: u64,
    /// Most recent witness hash, hex.
    #[serde(default)]
    pub last_hash: String,
    /// Optional genesis hash.
    #[serde(default)]
    pub genesis_hash: Option<String>,
    #[serde(flatten)]
    pub extras: Extras,
}
