//! Custody resource — `/api/v1/custody/*`.

use crate::error::Error;
use crate::seed::client::SeedClient;
use crate::seed::models::CustodyEpoch;

/// Custody endpoints.
pub struct CustodyResource<'c> {
    pub(crate) client: &'c SeedClient,
}

impl<'c> CustodyResource<'c> {
    /// `GET /api/v1/custody/epoch` (allowlisted read).
    pub async fn epoch(&self) -> Result<CustodyEpoch, Error> {
        self.client.request_get("/custody/epoch").await
    }
}
