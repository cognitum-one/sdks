//! Pairing request / response shapes for `/api/v1/pair{,/status}`.

use serde::{Deserialize, Serialize};

use super::Extras;

/// `GET /api/v1/pair/status` response shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PairStatus {
    /// Whether the seed has at least one paired client.
    #[serde(default)]
    pub paired: bool,
    /// Number of currently-paired clients.
    #[serde(default)]
    pub client_count: u32,
    /// Whether a new-client pairing window is currently open.
    #[serde(default)]
    pub pairing_window_open: bool,
    /// Seconds left in the current pairing window.
    #[serde(default)]
    pub window_remaining_secs: u32,
    #[serde(flatten)]
    pub extras: Extras,
}

/// `POST /api/v1/pair` request body.
///
/// Strict: typos in the client name fail fast client-side.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PairCreate {
    /// Human-readable client name (stored server-side for unpair).
    pub client_name: String,
}

/// `POST /api/v1/pair` response body.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PairCreateResponse {
    /// Echoes the submitted client name.
    #[serde(default)]
    pub client_name: String,
    /// Opaque pairing token — send as `X-Pairing-Token` on writes.
    #[serde(default)]
    pub token: String,
    /// Optional ISO-8601 expiry timestamp.
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(flatten)]
    pub extras: Extras,
}
