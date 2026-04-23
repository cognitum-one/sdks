//! Mesh observability resource — `/api/v1/{network/mesh/status,peers,
//! swarm/status,cluster/health}` (Phase 2 — ADR-0016a §D8).
//!
//! All four endpoints are allowlisted reads on firmware v0.20.0. Shapes
//! live in [`crate::seed::models::mesh`]; every struct carries a
//! `#[serde(flatten)] extras: Extras` so additional fields from newer
//! firmwares deserialize without breaking the SDK.

use crate::error::Error;
use crate::seed::client::SeedClient;
use crate::seed::config::CallOptions;
use crate::seed::models::{ClusterHealth, MeshPeers, MeshStatus, SwarmStatus};

/// Mesh observability endpoints.
pub struct MeshResource<'c> {
    pub(crate) client: &'c SeedClient,
}

impl<'c> MeshResource<'c> {
    /// `GET /api/v1/network/mesh/status` — mesh membership + AP snapshot.
    pub async fn status(&self) -> Result<MeshStatus, Error> {
        self.client.request_get("/network/mesh/status").await
    }

    /// [`Self::status`] with per-call [`CallOptions`] overrides.
    pub async fn status_with(&self, opts: CallOptions) -> Result<MeshStatus, Error> {
        self.client
            .request_get_opts("/network/mesh/status", &opts)
            .await
    }

    /// `GET /api/v1/peers` — discovery peer table.
    pub async fn peers(&self) -> Result<MeshPeers, Error> {
        self.client.request_get("/peers").await
    }

    /// [`Self::peers`] with per-call [`CallOptions`] overrides.
    pub async fn peers_with(&self, opts: CallOptions) -> Result<MeshPeers, Error> {
        self.client.request_get_opts("/peers", &opts).await
    }

    /// `GET /api/v1/swarm/status` — swarm-mode observability.
    pub async fn swarm_status(&self) -> Result<SwarmStatus, Error> {
        self.client.request_get("/swarm/status").await
    }

    /// [`Self::swarm_status`] with per-call [`CallOptions`] overrides.
    pub async fn swarm_status_with(&self, opts: CallOptions) -> Result<SwarmStatus, Error> {
        self.client.request_get_opts("/swarm/status", &opts).await
    }

    /// `GET /api/v1/cluster/health` — cluster / auto-sync status.
    pub async fn cluster_health(&self) -> Result<ClusterHealth, Error> {
        self.client.request_get("/cluster/health").await
    }

    /// [`Self::cluster_health`] with per-call [`CallOptions`] overrides.
    pub async fn cluster_health_with(&self, opts: CallOptions) -> Result<ClusterHealth, Error> {
        self.client.request_get_opts("/cluster/health", &opts).await
    }
}
