//! Wire-type models for the seed module.
//!
//! Every response struct follows the forward-compat pattern per ADR-0006
//! §"unknown-field":
//!
//! * Known fields are typed.
//! * Unknown fields are captured via `#[serde(flatten)] extras: Extras`
//!   which is a [`BTreeMap<String, serde_json::Value>`].
//!
//! Request types use `#[serde(deny_unknown_fields)]` so typos fail fast
//! client-side before the seed rejects them.

pub mod custody;
pub mod identity;
pub mod mesh;
pub mod ota;
pub mod pair;
pub mod status;
pub mod store;
pub mod witness;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Catch-all for forward-compatible fields the SDK does not model yet.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(transparent)]
pub struct Extras(pub BTreeMap<String, serde_json::Value>);

impl Extras {
    /// Read an extra field by name.
    pub fn get(&self, key: &str) -> Option<&serde_json::Value> {
        self.0.get(key)
    }

    /// Whether any extras were captured.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

pub use custody::CustodyEpoch;
pub use identity::Identity;
pub use mesh::{ClusterHealth, MeshPeers, MeshStatus, SwarmStatus};
pub use ota::{OtaCheckNowAck, OtaConfig};
pub use pair::{PairCreate, PairCreateResponse, PairStatus};
pub use status::Status;
pub use store::{
    StoreIngest, StoreIngestAck, StoreIngestEntry, StoreQuery, StoreQueryHit, StoreQueryResult,
    StoreStatus,
};
pub use witness::WitnessChain;
