//! OTA resource — `/api/v1/ota/*`.

use crate::error::Error;
use crate::seed::client::SeedClient;
use crate::seed::models::{OtaCheckNowAck, OtaConfig};

/// OTA endpoints.
pub struct OtaResource<'c> {
    pub(crate) client: &'c SeedClient,
}

impl<'c> OtaResource<'c> {
    /// `GET /api/v1/ota/config` (allowlisted read).
    pub async fn config(&self) -> Result<OtaConfig, Error> {
        self.client.request_get("/ota/config").await
    }

    /// `POST /api/v1/ota/check-now` — v0.20.0+. Requires pairing token
    /// (seed returns 403 otherwise). Not idempotent server-side but
    /// repeat-safe — the seed dedupes internally — so mark idempotent.
    pub async fn check_now(&self) -> Result<OtaCheckNowAck, Error> {
        self.client
            .request_post::<OtaCheckNowAck, _>("/ota/check-now", &serde_json::json!({}), true)
            .await
    }
}
