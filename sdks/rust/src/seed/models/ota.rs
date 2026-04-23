//! OTA config + check-now shapes for `/api/v1/ota/{config,check-now}`.

use serde::{Deserialize, Serialize};

use super::Extras;

/// `GET /api/v1/ota/config` response shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OtaConfig {
    /// Whether OTA is enabled.
    #[serde(default)]
    pub enabled: bool,
    /// Update channel (e.g. `stable`, `beta`).
    #[serde(default)]
    pub channel: String,
    /// How often (in seconds) the seed polls the manifest.
    #[serde(default)]
    pub check_interval_secs: u64,
    #[serde(flatten)]
    pub extras: Extras,
}

/// `POST /api/v1/ota/check-now` response shape (v0.20.0+).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OtaCheckNowAck {
    /// Whether a fresh manifest fetch was triggered.
    #[serde(default)]
    pub triggered: bool,
    /// Human-readable message from the seed.
    #[serde(default)]
    pub message: String,
    /// Effective poll interval (echoed from config).
    #[serde(default)]
    pub check_interval_secs: u64,
    /// Effective channel (echoed from config).
    #[serde(default)]
    pub channel: String,
    #[serde(flatten)]
    pub extras: Extras,
}
