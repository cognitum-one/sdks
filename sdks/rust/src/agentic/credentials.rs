//! Credential-provider contract and secret redaction (ADR-0022 §D1, §D10).
//! Type-only scaffolding — issue #52 / M1. No HTTP implementation ships in
//! this pass. Concrete providers land in issue #53; redaction logic in #54.

use std::fmt;

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize, Serializer};

use crate::agentic::errors::AgenticError;

/// Parameters describing the credential a caller is about to request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRequest {
    pub product: String,
    pub normalized_origin: String,
    pub audience: String,
    #[serde(default)]
    pub required_scopes: Vec<String>,
    pub operation: String,
    pub interactive_allowed: bool,
}

/// Non-secret authority descriptor used to partition capability/cache state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialAuthority {
    pub provider_fingerprint: String,
    pub product: String,
    pub normalized_origin: String,
    pub audience: String,
    pub principal: Option<String>,
    pub tenant: Option<String>,
    pub delegated_subtenant: Option<String>,
    pub effective_scopes: Option<Vec<String>>,
    pub plan: Option<String>,
}

/// Redacting wrapper around a secret value (ADR-0022 §D1/§D10).
///
/// `Debug`, `Display`, and serde-by-default MUST NOT reveal the wrapped
/// value — only [`RedactedSecret::reveal`] does. "Rust MUST remove or
/// replace derived Debug on current cloud configuration before any new
/// client reuses the pattern" (ADR-0022 §D1) — this type is the replacement
/// pattern for the new agentic clients.
#[derive(Clone)]
pub struct RedactedSecret(String);

impl RedactedSecret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Explicit, auditable access to the underlying secret.
    pub fn reveal(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for RedactedSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RedactedSecret(\"[REDACTED]\")")
    }
}

impl fmt::Display for RedactedSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}

impl Serialize for RedactedSecret {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str("[REDACTED]")
    }
}

impl<'de> Deserialize<'de> for RedactedSecret {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Ok(RedactedSecret::new(s))
    }
}

/// A credential acquired from a [`CredentialProvider`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub scheme: String,
    pub secret: RedactedSecret,
    pub expires_at: Option<String>,
    pub granted_scopes: Option<Vec<String>>,
    pub audience: String,
    pub source: String,
    pub authority: CredentialAuthority,
}

/// Product clients accept a credential provider, not an untyped reusable
/// header map (ADR-0022 §D1). No HTTP implementation ships in this pass —
/// concrete providers land in issue #53.
#[async_trait]
pub trait CredentialProvider: fmt::Debug + Send + Sync {
    async fn describe_authority(
        &self,
        request: &CredentialRequest,
    ) -> Result<CredentialAuthority, AgenticError>;

    async fn acquire(&self, request: &CredentialRequest) -> Result<Credential, AgenticError>;

    /// Non-secret stable provider identity, safe to log.
    fn identity(&self) -> String;

    async fn invalidate(&self, reason: &str);
}

/// Coarse secret-classification tiers used to drive redaction
/// (ADR-0022 §D10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretClassification {
    Secret,
    Sensitive,
    Public,
}

/// Applies recursive, schema- and key-name-based redaction to a value
/// before it is formatted or handed to a caller telemetry hook
/// (ADR-0022 §D10). No concrete implementation ships in this pass — lands
/// in issue #54.
///
/// FIX 3 of the M1 cross-language consistency review: Node declares
/// `redact<T>(value: T): T` and Python declares
/// `redact(self, value: Any) -> Any`, both preserving the caller's
/// original type. [`redact`](Self::redact) below matches that generic
/// shape. [`redact_value`](Self::redact_value) is the dyn-safe method
/// implementors actually provide — generic methods cannot be part of a
/// trait's vtable, and `SecretRedactor` is intended to be usable as a
/// trait object (`Arc<dyn SecretRedactor>`), mirroring the
/// `Arc<dyn CredentialProvider>` / `Arc<dyn CancellationToken>` precedent
/// already established for sibling traits in this module (see
/// `RequestContext` in `./context.rs`). `redact`'s default implementation
/// bridges the two via a JSON round-trip.
pub trait SecretRedactor: Send + Sync {
    fn classify(&self, field_name: &str, value: &serde_json::Value) -> SecretClassification;

    /// Dyn-safe redaction entry point that implementors provide, operating
    /// on `serde_json::Value`. Call this directly when only
    /// `dyn SecretRedactor` (not a concrete type) is available.
    fn redact_value(&self, value: serde_json::Value) -> serde_json::Value;

    /// Generic, type-preserving redaction matching Node's
    /// `redact<T>(value: T): T` / Python's `redact(self, value: Any) ->
    /// Any`. Implemented via a JSON round-trip over
    /// [`redact_value`](Self::redact_value). Requires `Self: Sized` —
    /// generic methods are excluded from a trait's vtable, so this method
    /// is only callable on a concrete type, never through
    /// `dyn SecretRedactor`.
    fn redact<T>(&self, value: T) -> T
    where
        Self: Sized,
        T: Serialize + DeserializeOwned,
    {
        let json = serde_json::to_value(value)
            .expect("SecretRedactor::redact: value must serialize to JSON");
        let redacted = self.redact_value(json);
        serde_json::from_value(redacted)
            .expect("SecretRedactor::redact: redacted value must deserialize back to T")
    }
}
