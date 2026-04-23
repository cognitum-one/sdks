//! Session handle (ADR-0016a §D9).
//!
//! A [`SeedSession`] pins one peer for the duration of its lifetime so
//! reads and writes land on the same seed (read-your-writes within a
//! session — ADR-0016a §D4). The handle mirrors the resource accessors
//! on [`SeedClient`](super::SeedClient); all requests issued through it
//! route to the pinned peer unless the peer fails hard (see
//! [`SeedClient::request_on_peer`](super::client::SeedClient)).

use crate::error::Error;

use super::client::SeedClient;
use super::models::{
    CustodyEpoch, Identity, OtaCheckNowAck, OtaConfig, PairCreate, PairCreateResponse, PairStatus,
    Status, StoreIngest, StoreIngestAck, StoreQuery, StoreQueryResult, StoreStatus, WitnessChain,
};

/// Handle that pins one peer for the duration of a logical request
/// sequence.
///
/// Cheap to create — holds a borrow of the parent client and a canonical
/// peer URL. Drop the handle to release the pin; the underlying client
/// state is unchanged (the pin is advisory, enforced at dispatch time).
#[derive(Debug)]
pub struct SeedSession<'c> {
    pub(crate) client: &'c SeedClient,
    /// Normalized peer key (`Endpoint::key()`) of the pinned peer.
    pub(crate) pinned_peer: String,
}

impl<'c> SeedSession<'c> {
    /// URL of the peer this session is pinned to (canonical form, no
    /// trailing slash).
    pub fn pinned_peer(&self) -> &str {
        &self.pinned_peer
    }

    // -- top-level conveniences (mirror SeedClient) -----------------------

    /// `GET /api/v1/status` against the pinned peer.
    pub async fn status(&self) -> Result<Status, Error> {
        self.client
            .request_on_peer_get("/status", Some(&self.pinned_peer))
            .await
    }

    /// `GET /api/v1/identity` against the pinned peer.
    pub async fn identity(&self) -> Result<Identity, Error> {
        self.client
            .request_on_peer_get("/identity", Some(&self.pinned_peer))
            .await
    }

    // -- resource accessors (mirror SeedClient but route through session) --

    /// Pairing resource on the pinned peer.
    pub fn pair(&self) -> SessionPair<'_, 'c> {
        SessionPair { session: self }
    }

    /// Vector-store resource on the pinned peer.
    pub fn store(&self) -> SessionStore<'_, 'c> {
        SessionStore { session: self }
    }

    /// Witness resource on the pinned peer.
    pub fn witness(&self) -> SessionWitness<'_, 'c> {
        SessionWitness { session: self }
    }

    /// Custody resource on the pinned peer.
    pub fn custody(&self) -> SessionCustody<'_, 'c> {
        SessionCustody { session: self }
    }

    /// OTA resource on the pinned peer.
    pub fn ota(&self) -> SessionOta<'_, 'c> {
        SessionOta { session: self }
    }
}

/// Pair resource accessor pinned to a [`SeedSession`]'s peer.
#[derive(Debug)]
pub struct SessionPair<'s, 'c> {
    session: &'s SeedSession<'c>,
}

impl<'s, 'c> SessionPair<'s, 'c> {
    /// `GET /api/v1/pair/status`.
    pub async fn status(&self) -> Result<PairStatus, Error> {
        self.session
            .client
            .request_on_peer_get("/pair/status", Some(&self.session.pinned_peer))
            .await
    }

    /// `POST /api/v1/pair`.
    pub async fn create(&self, req: PairCreate) -> Result<PairCreateResponse, Error> {
        self.session
            .client
            .request_on_peer_post("/pair", &req, false, Some(&self.session.pinned_peer))
            .await
    }
}

/// Store resource accessor pinned to a [`SeedSession`]'s peer.
#[derive(Debug)]
pub struct SessionStore<'s, 'c> {
    session: &'s SeedSession<'c>,
}

impl<'s, 'c> SessionStore<'s, 'c> {
    /// `GET /api/v1/store/status`.
    pub async fn status(&self) -> Result<StoreStatus, Error> {
        self.session
            .client
            .request_on_peer_get("/store/status", Some(&self.session.pinned_peer))
            .await
    }

    /// `POST /api/v1/store/query` (idempotent read-with-body).
    pub async fn query(&self, req: StoreQuery) -> Result<StoreQueryResult, Error> {
        self.session
            .client
            .request_on_peer_post("/store/query", &req, true, Some(&self.session.pinned_peer))
            .await
    }

    /// `POST /api/v1/store/ingest` (mutating, NOT idempotent).
    pub async fn ingest(&self, req: StoreIngest) -> Result<StoreIngestAck, Error> {
        self.session
            .client
            .request_on_peer_post(
                "/store/ingest",
                &req,
                false,
                Some(&self.session.pinned_peer),
            )
            .await
    }
}

/// Witness resource accessor pinned to a [`SeedSession`]'s peer.
#[derive(Debug)]
pub struct SessionWitness<'s, 'c> {
    session: &'s SeedSession<'c>,
}

impl<'s, 'c> SessionWitness<'s, 'c> {
    /// `GET /api/v1/witness/chain`.
    pub async fn chain(&self) -> Result<WitnessChain, Error> {
        self.session
            .client
            .request_on_peer_get("/witness/chain", Some(&self.session.pinned_peer))
            .await
    }
}

/// Custody resource accessor pinned to a [`SeedSession`]'s peer.
#[derive(Debug)]
pub struct SessionCustody<'s, 'c> {
    session: &'s SeedSession<'c>,
}

impl<'s, 'c> SessionCustody<'s, 'c> {
    /// `GET /api/v1/custody/epoch`.
    pub async fn epoch(&self) -> Result<CustodyEpoch, Error> {
        self.session
            .client
            .request_on_peer_get("/custody/epoch", Some(&self.session.pinned_peer))
            .await
    }
}

/// OTA resource accessor pinned to a [`SeedSession`]'s peer.
#[derive(Debug)]
pub struct SessionOta<'s, 'c> {
    session: &'s SeedSession<'c>,
}

impl<'s, 'c> SessionOta<'s, 'c> {
    /// `GET /api/v1/ota/config`.
    pub async fn config(&self) -> Result<OtaConfig, Error> {
        self.session
            .client
            .request_on_peer_get("/ota/config", Some(&self.session.pinned_peer))
            .await
    }

    /// `POST /api/v1/ota/check-now`.
    pub async fn check_now(&self) -> Result<OtaCheckNowAck, Error> {
        self.session
            .client
            .request_on_peer_post(
                "/ota/check-now",
                &serde_json::Value::Null,
                false,
                Some(&self.session.pinned_peer),
            )
            .await
    }
}
