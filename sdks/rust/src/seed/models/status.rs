//! `GET /api/v1/status` response shape.
//!
//! Shape per `seed/docs/seed/api-reference.md:30-42` with forward-compat
//! catch-all (live firmware emits extra fields such as
//! `witness_chain_length` that the reference doesn't document).

use serde::{Deserialize, Serialize};

use super::Extras;

/// Combined device / optimizer / delivery health snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Status {
    /// Opaque device identifier (UUIDv4).
    #[serde(default)]
    pub device_id: String,
    /// Process uptime in seconds.
    #[serde(default)]
    pub uptime_secs: u64,
    /// Optimizer epoch counter.
    #[serde(default)]
    pub epoch: u64,
    /// Total vectors in the store (indexed + tombstoned).
    #[serde(default)]
    pub total_vectors: u64,
    /// Tombstoned vectors pending compaction.
    #[serde(default)]
    pub deleted_vectors: u64,
    /// On-disk size of the vector store.
    #[serde(default)]
    pub file_size_bytes: u64,
    /// Vector dimension.
    #[serde(default)]
    pub dimension: u32,
    /// Whether the seed has any paired clients.
    #[serde(default)]
    pub paired: bool,
    /// Roles served by this seed (`custody`, `optimizer`, `delivery`…).
    #[serde(default)]
    pub roles: Vec<String>,
    /// Forward-compat sink for unmodeled fields.
    #[serde(flatten)]
    pub extras: Extras,
}
