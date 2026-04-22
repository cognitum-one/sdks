//! Witness-chain resource — `/api/v1/witness/*`.

use crate::error::Error;
use crate::seed::client::SeedClient;
use crate::seed::models::WitnessChain;

/// Witness endpoints.
pub struct WitnessResource<'c> {
    pub(crate) client: &'c SeedClient,
}

impl<'c> WitnessResource<'c> {
    /// `GET /api/v1/witness/chain` (allowlisted read).
    pub async fn chain(&self) -> Result<WitnessChain, Error> {
        self.client.request_get("/witness/chain").await
    }
}
