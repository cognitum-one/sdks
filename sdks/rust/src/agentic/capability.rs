//! Capability negotiation (ADR-0019 §D6). Type-only scaffolding — issue #52 / M1.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Where a [`CapabilitySet`] came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilitySource {
    Server,
    StaticCompatibilityTable,
}

/// Runtime-advertised, versioned support for a named behavior.
///
/// Unknown product versions MUST receive the intersection of proven-safe
/// capabilities, never the union (ADR-0019 §D6).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySet {
    pub product: String,
    pub product_version: String,
    pub protocol: String,
    pub protocol_version: String,
    #[serde(default)]
    pub features: HashMap<String, bool>,
    #[serde(default)]
    pub limitations: Vec<String>,
    #[serde(default)]
    pub auth_methods: Vec<String>,
    pub source: CapabilitySource,
}
