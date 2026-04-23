//! Pairing request / response shapes for `/api/v1/pair{,/status}`.

use std::fmt;

use serde::{Deserialize, Serialize};

use super::Extras;
use crate::seed::token_book::SecretString;

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
///
/// The `token` field is wrapped in [`SecretString`] per
/// [cognitum-one/sdks#15] so that the raw pairing token does not leak
/// through `{:?}` / `tracing::debug!` dumps of the response. Use
/// `response.token.as_str()` on the request path when the string value
/// is required; the manual [`fmt::Debug`] impl below redacts it.
///
/// `PartialEq` is intentionally not derived (would require `PartialEq`
/// on `SecretString`, which invites timing-sensitive comparisons — and
/// nothing in the SDK compares two `PairCreateResponse`s).
///
/// [cognitum-one/sdks#15]: https://github.com/cognitum-one/sdks/issues/15
#[derive(Clone, Serialize, Deserialize)]
pub struct PairCreateResponse {
    /// Echoes the submitted client name.
    #[serde(default)]
    pub client_name: String,
    /// Opaque pairing token — send as `X-Pairing-Token` on writes.
    #[serde(default)]
    pub token: SecretString,
    /// Optional ISO-8601 expiry timestamp.
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(flatten)]
    pub extras: Extras,
}

impl fmt::Debug for PairCreateResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairCreateResponse")
            .field("client_name", &self.client_name)
            // Never print the token value — #15 security fix.
            .field("token", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .field("extras", &self.extras)
            .finish()
    }
}
