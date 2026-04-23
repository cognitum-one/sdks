//! `GET /api/v1/identity` response shape.

use serde::{Deserialize, Serialize};

use super::Extras;

/// Immutable identity document per `seed/docs/seed/api-reference.md` §identity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Identity {
    /// Opaque device ID (UUIDv4).
    #[serde(default)]
    pub device_id: String,
    /// Public key (Ed25519, base64 or hex — seed decides).
    #[serde(default)]
    pub public_key: String,
    /// Firmware version tag.
    #[serde(default)]
    pub firmware_version: String,
    /// Forward-compat sink.
    #[serde(flatten)]
    pub extras: Extras,
}
