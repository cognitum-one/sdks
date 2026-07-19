//! MetaHarness client (ADR-0019 §D2, ADR-0026a). Issue #64 / M4 start —
//! `MetaHarnessClient` construction (§D1, zero I/O) and the §D2 public
//! method surface as fail-closed stubs (every upstream capability is
//! blocked — see `client`'s module doc comment for the full ADR-0026a §D7
//! blocker list). Domain types (§D3) are pure data shapes with no bridge
//! dependency.
//!
//! Per ADR-0019 §D4, this module's client is product-private and MUST NOT
//! be imported by any other product module (`meta_llm`, `meta_proxy`,
//! `harnessaas`). It never composes those clients either (ADR-0026a §D1).
//! Gated behind the `metaharness` Cargo feature, per ADR-0026a §D1's
//! namespace map: `cognitum_one::metaharness` behind feature `metaharness`.

pub mod client;
pub mod config;
pub mod types;

pub use client::MetaHarnessClient;
pub use config::{
    MetaHarnessConfig, MetaHarnessTelemetryEvent, MetaHarnessTelemetryHooks,
    DEFAULT_HANDSHAKE_TIMEOUT_MS,
};
pub use types::{
    parse_harness_manifest, parse_witness_verification, ApplyApproval, FileAction, GeneratedFile,
    GeneratorIdentity, GitRepository, HarnessComparisonResult, HarnessManifest,
    HarnessValidationResult, HostDescriptor, LocalRepository, ProcessCommitOutcome, ProcessRun,
    ProcessRunState, RepositoryAnalysis, RepositoryScore, RepositorySource, ScaffoldPlan,
    ScaffoldRequestV1, ScaffoldResult, TemplateDescriptor, TemplateIdentity, WitnessVerification,
    SCAFFOLD_PLAN_SCHEMA_V1, SCAFFOLD_REQUEST_SCHEMA_V1, SCAFFOLD_RESULT_SCHEMA_V1,
};
