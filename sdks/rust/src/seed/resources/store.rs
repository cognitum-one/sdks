//! Vector-store resource — `/api/v1/store/*`.

use crate::error::Error;
use crate::seed::client::SeedClient;
use crate::seed::models::{StoreIngest, StoreIngestAck, StoreQuery, StoreQueryResult, StoreStatus};

/// Vector store endpoints.
pub struct StoreResource<'c> {
    pub(crate) client: &'c SeedClient,
}

impl<'c> StoreResource<'c> {
    /// `GET /api/v1/store/status` (allowlisted read).
    pub async fn status(&self) -> Result<StoreStatus, Error> {
        self.client.request_get("/store/status").await
    }

    /// `POST /api/v1/store/query` — read-with-body. Attested idempotent
    /// per ADR-0005 §"Caller-attested idempotency": safe to retry.
    pub async fn query(&self, req: StoreQuery) -> Result<StoreQueryResult, Error> {
        self.client.request_post("/store/query", &req, true).await
    }

    /// `POST /api/v1/store/ingest` — mutating; NOT idempotent.
    pub async fn ingest(&self, req: StoreIngest) -> Result<StoreIngestAck, Error> {
        self.client.request_post("/store/ingest", &req, false).await
    }
}
