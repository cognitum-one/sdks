//! Vector store request / response shapes.
//!
//! Phase 1 wraps `/api/v1/store/status`, `/query`, `/ingest`.

use serde::{Deserialize, Serialize};

use super::Extras;

/// `GET /api/v1/store/status` response shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StoreStatus {
    /// Total vectors in the store.
    #[serde(default)]
    pub total_vectors: u64,
    /// Tombstoned vectors awaiting compaction.
    #[serde(default)]
    pub deleted_vectors: u64,
    /// On-disk size of the vector file.
    #[serde(default)]
    pub file_size_bytes: u64,
    /// Vector dimension.
    #[serde(default)]
    pub dimension: u32,
    #[serde(flatten)]
    pub extras: Extras,
}

/// `POST /api/v1/store/query` request body.
///
/// Per swarm finding: the field is **`vector`**, not `query`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StoreQuery {
    /// The query vector. Length MUST equal the store's `dimension`.
    pub vector: Vec<f32>,
    /// Number of neighbors to return.
    pub k: u32,
}

/// `POST /api/v1/store/query` response body.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StoreQueryResult {
    /// Nearest-neighbor hits ordered by `distance` ascending.
    #[serde(default)]
    pub results: Vec<StoreQueryHit>,
    /// Wall-clock ms the seed spent on the query.
    #[serde(default)]
    pub query_ms: f64,
    #[serde(flatten)]
    pub extras: Extras,
}

/// A single nearest-neighbor hit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StoreQueryHit {
    /// Content-hashed 64-bit ID.
    #[serde(default)]
    pub id: u64,
    /// Distance (squared L2 or cosine depending on store config).
    #[serde(default)]
    pub distance: f32,
    /// Opaque metadata blob per-vector.
    #[serde(default)]
    pub metadata: serde_json::Value,
    #[serde(flatten)]
    pub extras: Extras,
}

/// One entry in a `POST /api/v1/store/ingest` batch.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StoreIngestEntry {
    /// Caller-supplied ID (will be rehashed server-side).
    pub id: String,
    /// Vector payload.
    pub values: Vec<f32>,
    /// Optional metadata blob.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// `POST /api/v1/store/ingest` request body.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StoreIngest {
    /// Vectors to upsert.
    pub vectors: Vec<StoreIngestEntry>,
}

/// `POST /api/v1/store/ingest` response body.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StoreIngestAck {
    /// Number of vectors accepted.
    #[serde(default)]
    pub ingested: u64,
    #[serde(flatten)]
    pub extras: Extras,
}
