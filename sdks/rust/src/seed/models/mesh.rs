//! Mesh observability response shapes (Phase 2 — ADR-0016a §D8).
//!
//! All four structs use `#[serde(flatten)] extras: Extras` so that fields
//! the live firmware adds after v0.20.0 deserialize cleanly. Verified
//! against the live seed (`ad7d7e7b-56e7-4e03-b078-939209858144`, firmware
//! v0.20.0) on 2026-04-22.
//!
//! Live JSON captured via `curl -sk https://169.254.42.1:8443/api/v1/<p>`:
//!
//! * `/network/mesh/status` →
//!   `{"ap_active":true,"auto_mesh":false,"connected_to_seed":false,
//!     "device_id":"…","has_mesh_password":false,"peer_count":0,
//!     "peers":[]}`
//! * `/peers` →
//!   `{"count":0,"discovery_active":true,"peers":[]}`
//! * `/swarm/status` →
//!   `{"device_id":"…","discovery_active":true,"epoch":20564,
//!     "peer_count":0,"total_vectors":8460,"uptime_secs":23054}`
//! * `/cluster/health` →
//!   `{"auto_sync_interval_secs":60,"cluster_enabled":true,
//!     "discovery_active":true,"last_sync_attempt":1776906597,
//!     "peer_count":0,"peers":[]}`

use serde::{Deserialize, Serialize};

use super::Extras;

/// `GET /api/v1/network/mesh/status` — mesh membership / AP snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MeshStatus {
    /// Whether the seed is currently broadcasting its soft-AP.
    #[serde(default)]
    pub ap_active: bool,
    /// Auto-join policy (explicit operator toggle).
    #[serde(default)]
    pub auto_mesh: bool,
    /// Whether this seed currently holds an uplink to another seed.
    #[serde(default)]
    pub connected_to_seed: bool,
    /// Reporter's own device id (UUIDv4).
    #[serde(default)]
    pub device_id: String,
    /// Whether a shared mesh credential has been configured.
    #[serde(default)]
    pub has_mesh_password: bool,
    /// Discovered mesh peer count (may be 0 on a lone seed).
    #[serde(default)]
    pub peer_count: u64,
    /// Discovered peer summaries. Shape is intentionally free-form on the
    /// wire (v0.20.0 emits `[]`); when entries appear, the SDK surfaces
    /// them as `serde_json::Value` so we don't bake a schema we haven't
    /// seen populated on a live seed yet.
    #[serde(default)]
    pub peers: Vec<serde_json::Value>,
    /// Forward-compat sink for unmodeled fields.
    #[serde(flatten)]
    pub extras: Extras,
}

/// `GET /api/v1/peers` — discovery peer table.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MeshPeers {
    /// Number of entries in `peers`.
    #[serde(default)]
    pub count: u64,
    /// Whether the discovery loop is active.
    #[serde(default)]
    pub discovery_active: bool,
    /// Discovered peers (shape free-form on the wire — see `MeshStatus::peers`).
    #[serde(default)]
    pub peers: Vec<serde_json::Value>,
    /// Forward-compat sink for unmodeled fields.
    #[serde(flatten)]
    pub extras: Extras,
}

/// `GET /api/v1/swarm/status` — swarm-mode observability. Shares several
/// fields with `/status` by design (the seed reports its own view of the
/// swarm here rather than introducing a second top-level endpoint).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SwarmStatus {
    /// Reporter's own device id.
    #[serde(default)]
    pub device_id: String,
    /// Whether the discovery loop is active.
    #[serde(default)]
    pub discovery_active: bool,
    /// Optimizer epoch counter.
    #[serde(default)]
    pub epoch: u64,
    /// Discovered peer count.
    #[serde(default)]
    pub peer_count: u64,
    /// Total vectors in the store (mirrors `/status`).
    #[serde(default)]
    pub total_vectors: u64,
    /// Process uptime seconds.
    #[serde(default)]
    pub uptime_secs: u64,
    /// Forward-compat sink for unmodeled fields.
    #[serde(flatten)]
    pub extras: Extras,
}

/// `GET /api/v1/cluster/health` — cluster / auto-sync status.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClusterHealth {
    /// Auto-sync interval in seconds (0 when auto-sync is disabled).
    #[serde(default)]
    pub auto_sync_interval_secs: u64,
    /// Whether cluster mode is enabled.
    #[serde(default)]
    pub cluster_enabled: bool,
    /// Whether the discovery loop is active.
    #[serde(default)]
    pub discovery_active: bool,
    /// UNIX timestamp (seconds) of the last auto-sync attempt.
    #[serde(default)]
    pub last_sync_attempt: i64,
    /// Peer count from the cluster's point of view.
    #[serde(default)]
    pub peer_count: u64,
    /// Peer summaries (shape free-form on the wire — see `MeshStatus::peers`).
    #[serde(default)]
    pub peers: Vec<serde_json::Value>,
    /// Forward-compat sink for unmodeled fields.
    #[serde(flatten)]
    pub extras: Extras,
}
