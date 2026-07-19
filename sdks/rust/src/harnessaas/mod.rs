//! HarnessaaS client (ADR-0027a). Product module + feature per ADR-0019
//! §D2: `cognitum_one::harnessaas`, Cargo feature `harnessaas`.
//!
//! Issue #67/#68 / M5 start: `HarnessaaSClient` construction, wire types,
//! and real `health()` / `solve()` / `lineage()` implementations against
//! the REAL, deployed, synchronous upstream surface — see `client`'s
//! module doc comment for the full scope note (ADR-0027a's proposed async
//! job/poll/SSE/approval/cancel/artifact contract is explicitly NOT
//! implemented here; neither is the webhook admin surface, the MicroLoRA
//! flywheel API, or the `/api/v1/*` IBO-console relay).
//!
//! Per ADR-0019 §D4, this module's CLIENT is product-private and MUST NOT
//! be imported for its behavior by any other product module (`meta_llm`,
//! `meta_proxy`, `metaharness`).

pub mod client;
pub mod config;
pub mod discovery;
pub mod envelope;
mod http;
pub mod types;

pub use client::HarnessaaSClient;
pub use config::{HarnessaaSClientConfig, HarnessaaSTelemetryEvent, HarnessaaSTelemetryHooks};
pub use discovery::{parse_harnessaas_health, HarnessaaSHealth};
pub use envelope::{HarnessaaSResponseMeta, HarnessaaSResult};
pub use types::{
    parse_conformance_attestation, parse_cost_receipt, parse_lineage_result, parse_solve_response,
    HarnessaaSConformanceAttestation, HarnessaaSCostReceipt, HarnessaaSLineageRecord,
    HarnessaaSLineageResult, HarnessaaSSolveRequest, HarnessaaSSolveResponse, HarnessaaSVertical,
};
