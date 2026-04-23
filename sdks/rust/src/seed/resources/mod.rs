//! Resource accessors for [`SeedClient`](super::SeedClient).
//!
//! Each resource is a thin borrow (`&'c SeedClient`) that exposes typed
//! methods for a related group of endpoints. Resources do not hold state
//! beyond the borrow.

mod custody;
mod mesh;
mod ota;
mod pair;
mod store;
mod witness;

pub use custody::CustodyResource;
pub use mesh::MeshResource;
pub use ota::OtaResource;
pub use pair::PairResource;
pub use store::StoreResource;
pub use witness::WitnessResource;
