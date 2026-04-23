//! Direct-to-seed API module.
//!
//! Phase 1 (single-seed mode) delivers the 12-endpoint subset listed in
//! ADR-0014a §"Phase 1 delivery":
//!
//! ```text
//! GET    /api/v1/status                  -> SeedClient::status()
//! GET    /api/v1/identity                -> SeedClient::identity()
//! GET    /api/v1/pair/status             -> client.pair().status()
//! POST   /api/v1/pair                    -> client.pair().create(..)
//! DELETE /api/v1/pair/{client_name}      -> client.pair().delete(..)
//! GET    /api/v1/witness/chain           -> client.witness().chain()
//! GET    /api/v1/custody/epoch           -> client.custody().epoch()
//! GET    /api/v1/store/status            -> client.store().status()
//! POST   /api/v1/store/query             -> client.store().query(..)
//! POST   /api/v1/store/ingest            -> client.store().ingest(..)
//! GET    /api/v1/ota/config              -> client.ota().config()
//! POST   /api/v1/ota/check-now           -> client.ota().check_now()
//! ```
//!
//! Usage:
//!
//! ```no_run
//! use cognitum_rs::seed::{SeedAuth, SeedClient, SeedTls};
//!
//! # async fn example() -> Result<(), cognitum_rs::Error> {
//! let client = SeedClient::builder()
//!     .endpoint("https://localhost:18443")
//!     .auth(SeedAuth::None)
//!     .tls(SeedTls::Insecure)         // dev-only, swap for Pinned in prod
//!     .build()?;
//!
//! let status = client.status().await?;
//! println!("paired = {}", status.paired);
//! # Ok(())
//! # }
//! ```
//!
//! Mesh-mode (multiple peers, `Routing::Balanced` / `Routing::Failover`)
//! is Phase 1.5. The builder already accepts the knobs but rejects
//! non-`Pinned` routing at build time with a `not_implemented` error.

pub mod client;
pub mod config;
pub mod discovery;
pub mod error;
pub mod health;
pub mod models;
pub mod peers;
pub mod resources;
pub mod retry;
pub mod session;
pub mod tls_pin;
pub mod token_book;

pub use client::{SeedClient, SeedClientBuilder};
pub use config::{
    CallOptions, Consistency, Failover, Prefer, Routing, SeedAuth, SeedTls, Timeouts,
};
#[cfg(feature = "mdns")]
pub use discovery::MdnsDiscovery;
pub use discovery::{DiscoveredPeer, Discovery, Explicit, TailscaleDiscovery};
pub use models::{
    ClusterHealth, CustodyEpoch, Extras, Identity, MeshPeers, MeshStatus, OtaCheckNowAck,
    OtaConfig, PairCreate, PairCreateResponse, PairStatus, Status, StoreIngest, StoreIngestAck,
    StoreIngestEntry, StoreQuery, StoreQueryHit, StoreQueryResult, StoreStatus, SwarmStatus,
    WitnessChain,
};
pub use peers::{Endpoint, Peer, PeerErrorClass, PeerSet, PeerState};
pub use session::{
    SeedSession, SessionCustody, SessionOta, SessionPair, SessionStore, SessionWitness,
};
pub use token_book::{InMemoryTokenBook, SecretString, SharedTokenBook, TokenBook};
