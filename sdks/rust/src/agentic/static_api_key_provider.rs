//! Concrete [`CredentialProvider`] for a static Cognitum-cloud API key
//! (ADR-0022 §D1, §D2, §D3). Issue #53 / M1 follow-up — the frozen
//! `CredentialProvider` trait from issue #52 (`./credentials.rs`) gets its
//! first real implementation here.
//!
//! This wraps a caller-supplied API key (or `COGNITUM_API_KEY`, per
//! ADR-0003 §"Credential provisioning", mirroring the resolution order
//! already used by `HttpClient::resolveApiKey` in the Node SDK's
//! `../client.ts`) and hands it out only for the exact `product` /
//! `normalized_origin` / `audience` the provider was constructed for
//! (ADR-0022 §D1/§D3: "The provider MUST refuse an audience or origin
//! mismatch" / "Credential providers are bound to the normalized origin
//! selected during client construction. A redirect to another origin is
//! not followed with credentials."). There is no wildcard origin or
//! suffix matching — every check below is exact string equality.
//!
//! No HTTP request is made or shaped here — this type produces
//! credentials, it does not send them.

use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use sha2::{Digest, Sha256};

use crate::agentic::credentials::{
    Credential, CredentialAuthority, CredentialProvider, CredentialRequest, RedactedSecret,
};
use crate::agentic::errors::{AgenticError, AgenticErrorKind};

/// Canonical env var per ADR-0003 §"Credential provisioning" / `../client.rs`.
pub const DEFAULT_API_KEY_ENV_VAR: &str = "COGNITUM_API_KEY";

// `AgenticError` (ADR-0023 §D1) is a wide, frozen shape shared verbatim by
// every agentic product client's fallible trait methods (see
// `CredentialProvider::describe_authority`/`acquire` in `./credentials.rs`,
// which return it unboxed and are clippy-exempt only because they're trait
// methods). These free/inherent functions return the same error type for
// the same reason and are intentionally not boxed — that would make this
// one file inconsistent with the rest of the frozen contract for no
// behavioral benefit at this call volume (construction-time and
// per-request checks, not a hot loop).
#[allow(clippy::result_large_err)]
fn resolve_key(
    api_key: Option<String>,
    env_var: &str,
    env: Option<&std::collections::HashMap<String, String>>,
    product: &str,
) -> Result<String, AgenticError> {
    if let Some(key) = api_key {
        if !key.is_empty() {
            return Ok(key);
        }
    }
    let from_env = match env {
        Some(map) => map.get(env_var).cloned(),
        None => std::env::var(env_var).ok(),
    };
    if let Some(value) = from_env {
        if !value.is_empty() {
            return Ok(value);
        }
    }
    Err(AgenticError {
        product: Some(product.to_owned()),
        ..AgenticError::new(
            AgenticErrorKind::Configuration,
            format!("api_key is required — pass api_key or set {env_var}"),
        )
    })
}

/// Non-secret, non-reversible-in-practice fingerprint of a key value.
fn fingerprint_of(product: &str, key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(product.as_bytes());
    hasher.update(b":");
    hasher.update(key.as_bytes());
    let digest = hasher.finalize();
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Construction-time options for [`StaticApiKeyCredentialProvider`].
#[derive(Debug, Clone, Default)]
pub struct StaticApiKeyCredentialProviderOptions {
    /// Explicit API key. When `None`, resolved from `env_var` (default
    /// [`DEFAULT_API_KEY_ENV_VAR`]) per ADR-0003's resolution order.
    pub api_key: Option<String>,
    /// Override the environment variable name checked when `api_key` is `None`.
    pub env_var: Option<String>,
    /// Wire scheme label surfaced on the acquired [`Credential`]. Defaults
    /// to `"X-API-Key"`, the canonical cloud header per ADR-0003.
    pub scheme: Option<String>,
    /// Injectable environment map, for testing. Defaults to the real process
    /// environment via [`std::env::var`].
    pub env: Option<std::collections::HashMap<String, String>>,
}

/// Concrete [`CredentialProvider`] wrapping one static Cognitum-cloud API
/// key (ADR-0022 §D1/§D2/§D3). Fails closed on any product, origin, or
/// audience mismatch — see [`StaticApiKeyCredentialProvider::assert_match`].
///
/// `Debug` is derived: `RedactedSecret`'s own `Debug` impl redacts the
/// wrapped value, so deriving here does not leak the key (ADR-0022 §D1).
/// `invalidated` is an `AtomicBool` (not a plain `bool`) because
/// [`CredentialProvider::invalidate`] takes `&self`, not `&mut self` — the
/// frozen trait shape from issue #52 assumes providers manage their own
/// interior mutability, matching Node's private class field and Python's
/// instance attribute (both mutable through a shared reference in their
/// respective languages).
#[derive(Debug)]
pub struct StaticApiKeyCredentialProvider {
    secret: RedactedSecret,
    product: String,
    normalized_origin: String,
    audience: String,
    scheme: String,
    fingerprint: String,
    invalidated: AtomicBool,
}

impl StaticApiKeyCredentialProvider {
    /// Construct a provider bound to `product` / `normalized_origin` /
    /// `audience`, resolving the API key per ADR-0003's order (explicit
    /// arg, then environment variable, then a `Configuration` error at
    /// construction time — never at first request).
    #[allow(clippy::result_large_err)] // see `resolve_key` above
    pub fn new(
        product: impl Into<String>,
        normalized_origin: impl Into<String>,
        audience: impl Into<String>,
        options: StaticApiKeyCredentialProviderOptions,
    ) -> Result<Self, AgenticError> {
        let product = product.into();
        let env_var = options
            .env_var
            .unwrap_or_else(|| DEFAULT_API_KEY_ENV_VAR.to_owned());
        let key = resolve_key(options.api_key, &env_var, options.env.as_ref(), &product)?;
        let fingerprint = fingerprint_of(&product, &key);
        Ok(Self {
            secret: RedactedSecret::new(key),
            product,
            normalized_origin: normalized_origin.into(),
            audience: audience.into(),
            scheme: options.scheme.unwrap_or_else(|| "X-API-Key".to_owned()),
            fingerprint,
            invalidated: AtomicBool::new(false),
        })
    }

    fn authority(&self) -> CredentialAuthority {
        CredentialAuthority {
            provider_fingerprint: self.fingerprint.clone(),
            product: self.product.clone(),
            normalized_origin: self.normalized_origin.clone(),
            audience: self.audience.clone(),
            principal: None,
            tenant: None,
            delegated_subtenant: None,
            effective_scopes: None,
            plan: None,
        }
    }

    /// Fail-closed match check (ADR-0022 §D1/§D3). Exact string equality
    /// only — no wildcard origin, suffix matching, or DNS-parent trust.
    #[allow(clippy::result_large_err)] // see `resolve_key` above
    fn assert_match(&self, request: &CredentialRequest) -> Result<(), AgenticError> {
        if request.product != self.product {
            return Err(AgenticError {
                product: Some(self.product.clone()),
                operation: Some(request.operation.clone()),
                ..AgenticError::new(
                    AgenticErrorKind::Authentication,
                    format!(
                        "credential provider {} is bound to product \"{}\", refusing request for product \"{}\"",
                        self.identity(),
                        self.product,
                        request.product,
                    ),
                )
            });
        }
        if request.normalized_origin != self.normalized_origin {
            return Err(AgenticError {
                product: Some(self.product.clone()),
                operation: Some(request.operation.clone()),
                ..AgenticError::new(
                    AgenticErrorKind::Authentication,
                    format!(
                        "credential provider {} is bound to origin \"{}\", refusing request for origin \"{}\" (ADR-0022 §D3: a redirect to another origin is not followed with credentials)",
                        self.identity(),
                        self.normalized_origin,
                        request.normalized_origin,
                    ),
                )
            });
        }
        if request.audience != self.audience {
            return Err(AgenticError {
                product: Some(self.product.clone()),
                operation: Some(request.operation.clone()),
                ..AgenticError::new(
                    AgenticErrorKind::Authentication,
                    format!(
                        "credential provider {} is bound to audience \"{}\", refusing request for audience \"{}\"",
                        self.identity(),
                        self.audience,
                        request.audience,
                    ),
                )
            });
        }
        Ok(())
    }
}

#[async_trait]
impl CredentialProvider for StaticApiKeyCredentialProvider {
    async fn describe_authority(
        &self,
        request: &CredentialRequest,
    ) -> Result<CredentialAuthority, AgenticError> {
        self.assert_match(request)?;
        Ok(self.authority())
    }

    async fn acquire(&self, request: &CredentialRequest) -> Result<Credential, AgenticError> {
        self.assert_match(request)?;
        if self.invalidated.load(Ordering::SeqCst) {
            return Err(AgenticError {
                product: Some(self.product.clone()),
                ..AgenticError::new(
                    AgenticErrorKind::Authentication,
                    format!(
                        "credential provider {} has been invalidated",
                        self.identity()
                    ),
                )
            });
        }
        Ok(Credential {
            scheme: self.scheme.clone(),
            secret: self.secret.clone(),
            expires_at: None,
            granted_scopes: None,
            audience: self.audience.clone(),
            source: self.identity(),
            authority: self.authority(),
        })
    }

    fn identity(&self) -> String {
        format!("static-api-key:{}:{}", self.product, self.fingerprint)
    }

    async fn invalidate(&self, _reason: &str) {
        // `&self`, not `&mut self`, per the frozen `CredentialProvider`
        // trait — hence the `AtomicBool` rather than a plain `bool` field.
        // After this call, `acquire` fails closed until a new provider is
        // constructed; `describe_authority` still succeeds (it hands out
        // no secret, only the non-secret authority descriptor).
        self.invalidated.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const CANARY: &str = "sk-canary-CT9f3aQzL0m1";

    fn request(product: &str, origin: &str, audience: &str) -> CredentialRequest {
        CredentialRequest {
            product: product.to_owned(),
            normalized_origin: origin.to_owned(),
            audience: audience.to_owned(),
            required_scopes: vec![],
            operation: "catalog.browse".to_owned(),
            interactive_allowed: false,
        }
    }

    fn base_request() -> CredentialRequest {
        request(
            "cognitum-cloud",
            "https://api.cognitum.one",
            "cognitum-cloud-api",
        )
    }

    fn provider() -> StaticApiKeyCredentialProvider {
        StaticApiKeyCredentialProvider::new(
            "cognitum-cloud",
            "https://api.cognitum.one",
            "cognitum-cloud-api",
            StaticApiKeyCredentialProviderOptions {
                api_key: Some(CANARY.to_owned()),
                ..Default::default()
            },
        )
        .expect("provider construction should succeed with an explicit key")
    }

    #[tokio::test]
    async fn acquires_credential_for_matching_origin_and_audience() {
        let p = provider();
        let credential = p.acquire(&base_request()).await.expect("should succeed");

        assert_eq!(credential.scheme, "X-API-Key");
        assert_eq!(credential.audience, "cognitum-cloud-api");
        assert_eq!(
            credential.authority.normalized_origin,
            "https://api.cognitum.one"
        );
        assert_eq!(credential.authority.product, "cognitum-cloud");
        assert_eq!(credential.secret.reveal(), CANARY);
    }

    #[tokio::test]
    async fn describe_authority_succeeds_for_matching_request() {
        let p = provider();
        let authority = p
            .describe_authority(&base_request())
            .await
            .expect("should succeed");
        assert_eq!(authority.audience, "cognitum-cloud-api");
        assert_eq!(authority.normalized_origin, "https://api.cognitum.one");
    }

    #[tokio::test]
    async fn refuses_acquire_for_different_origin() {
        // ADR-0022 §D3: "a redirect to another origin is not followed with
        // credentials" — exercised as a direct provider-level refusal.
        let p = provider();
        let req = request(
            "cognitum-cloud",
            "https://evil.example.com",
            "cognitum-cloud-api",
        );
        let err = p.acquire(&req).await.expect_err("should be refused");
        assert_eq!(err.kind, AgenticErrorKind::Authentication);
    }

    #[tokio::test]
    async fn refuses_describe_authority_for_different_origin() {
        let p = provider();
        let req = request(
            "cognitum-cloud",
            "https://evil.example.com",
            "cognitum-cloud-api",
        );
        let err = p
            .describe_authority(&req)
            .await
            .expect_err("should be refused");
        assert_eq!(err.kind, AgenticErrorKind::Authentication);
    }

    #[tokio::test]
    async fn refuses_subdomain_suffix_match_origin() {
        // No wildcard origin, suffix matching, or DNS-parent trust.
        let p = provider();
        let req = request(
            "cognitum-cloud",
            "https://sub.api.cognitum.one",
            "cognitum-cloud-api",
        );
        let err = p.acquire(&req).await.expect_err("should be refused");
        assert_eq!(err.kind, AgenticErrorKind::Authentication);
    }

    #[tokio::test]
    async fn refuses_audience_mismatch() {
        let p = provider();
        let req = request("cognitum-cloud", "https://api.cognitum.one", "meta-llm-api");
        let err = p.acquire(&req).await.expect_err("should be refused");
        assert_eq!(err.kind, AgenticErrorKind::Authentication);
    }

    #[tokio::test]
    async fn refuses_product_mismatch() {
        let p = provider();
        let req = request(
            "meta-proxy",
            "https://api.cognitum.one",
            "cognitum-cloud-api",
        );
        let err = p.acquire(&req).await.expect_err("should be refused");
        assert_eq!(err.kind, AgenticErrorKind::Authentication);
    }

    #[tokio::test]
    async fn secret_does_not_leak_via_debug_display_or_serde() {
        let p = provider();
        let credential = p.acquire(&base_request()).await.expect("should succeed");

        let debug_str = format!("{:?}", credential.secret);
        assert!(!debug_str.contains(CANARY));
        assert!(debug_str.contains("[REDACTED]"));

        let display_str = format!("{}", credential.secret);
        assert_eq!(display_str, "[REDACTED]");

        let json = serde_json::to_string(&credential).expect("serializes");
        assert!(!json.contains(CANARY));
        assert!(json.contains("[REDACTED]"));

        // The provider's own Debug (derived) must not leak either, since
        // `RedactedSecret::fmt` redacts the field.
        let provider_debug = format!("{p:?}");
        assert!(!provider_debug.contains(CANARY));
    }

    #[tokio::test]
    async fn secret_does_not_leak_via_error_display_or_debug() {
        let p = provider();
        let req = request(
            "cognitum-cloud",
            "https://evil.example.com",
            "cognitum-cloud-api",
        );
        let err = p.acquire(&req).await.expect_err("should be refused");
        assert!(!format!("{err}").contains(CANARY));
        assert!(!format!("{err:?}").contains(CANARY));
    }

    #[test]
    fn identity_is_stable_and_non_secret() {
        let p = provider();
        let id = p.identity();
        assert!(!id.contains(CANARY));
        assert_eq!(id, p.identity());
    }

    #[tokio::test]
    async fn resolves_key_from_env_var_when_no_explicit_key() {
        let mut env = HashMap::new();
        env.insert(DEFAULT_API_KEY_ENV_VAR.to_owned(), CANARY.to_owned());
        let p = StaticApiKeyCredentialProvider::new(
            "cognitum-cloud",
            "https://api.cognitum.one",
            "cognitum-cloud-api",
            StaticApiKeyCredentialProviderOptions {
                env: Some(env),
                ..Default::default()
            },
        )
        .expect("should resolve from env");
        let credential = p.acquire(&base_request()).await.expect("should succeed");
        assert_eq!(credential.secret.reveal(), CANARY);
    }

    #[tokio::test]
    async fn refuses_acquire_after_invalidate() {
        let p = provider();
        p.invalidate("rotated").await;
        let err = p
            .acquire(&base_request())
            .await
            .expect_err("should be refused after invalidate");
        assert_eq!(err.kind, AgenticErrorKind::Authentication);
    }

    #[test]
    fn fails_at_construction_without_key_or_env_var() {
        let result = StaticApiKeyCredentialProvider::new(
            "cognitum-cloud",
            "https://api.cognitum.one",
            "cognitum-cloud-api",
            StaticApiKeyCredentialProviderOptions {
                env: Some(HashMap::new()),
                ..Default::default()
            },
        );
        let err = result.expect_err("should fail closed with no key available");
        assert_eq!(err.kind, AgenticErrorKind::Configuration);
    }
}
