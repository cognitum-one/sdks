//! Authentication for the local Meta Proxy sidecar (ADR-0025a §D6).
//!
//! This pass ships ONE constructable credential path — the local bearer token
//! ([`LocalBearerTokenCredentialProvider`]) — plus the type-only shape of the
//! full §D6 union ([`ProxyCredential`], [`WorkloadCapabilityClaims`]). Minting
//! a `WorkloadCapability` requires an injected `MetaProxyLifecycleProvider`
//! that ADR-0025b defines; nothing here constructs one from raw material, and
//! there is deliberately no constructor that signs `mh1.<payload>.<hmac>`.
//!
//! Loopback + transport rules (§D6/§D10): "The bearer is sent only to literal
//! loopback through a direct transport. Ambient HTTP proxy variables are
//! ignored. Cross-origin redirects [...] are rejected." Origin loopback
//! validation lives in `super::config::resolve_config` (construction) and the
//! bearer is origin-bound here — this provider hands the token out only for the
//! exact `product`/`normalized_origin`/`audience` it was built for, so a
//! redirect or origin swap can never re-present the bearer elsewhere. The
//! proxy-ignoring + redirect-rejecting transport is built in
//! `super::config::build_default_transport`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use sha2::{Digest, Sha256};

use crate::agentic::{
    AgenticError, AgenticErrorKind, Credential, CredentialAuthority, CredentialProvider,
    CredentialRequest, RedactedSecret,
};

use super::status::WorkloadPolicy;
use super::PRODUCT;

/// Env var the local bearer token is read from when no explicit token is
/// passed. The proxy token is a local, per-machine secret (`mh1.<...>`), not
/// the Cognitum-cloud API key, so it uses its own variable rather than
/// `COGNITUM_API_KEY`.
pub const DEFAULT_META_PROXY_TOKEN_ENV_VAR: &str = "COGNITUM_META_PROXY_TOKEN";

/// The §D6 credential union: `ProxyCredential = LocalBearerToken | WorkloadCapability`.
///
/// `LocalBearerToken` is the constructable path this pass ships (via
/// [`LocalBearerTokenCredentialProvider`]). `WorkloadCapability` is TYPE-ONLY:
/// minting a signed capability requires ADR-0025b's `MetaProxyLifecycleProvider`
/// and is not implemented here — no code constructs a valid instance from raw
/// material in this pass.
#[derive(Debug, Clone)]
pub enum ProxyCredential {
    /// A local bearer token (`mh1.<...>`) sent to loopback only.
    LocalBearerToken(RedactedSecret),
    /// A scoped, HMAC-signed workload capability. Type-only in this pass; see
    /// the enum doc comment.
    WorkloadCapability(WorkloadCapabilityClaims),
}

/// Non-secret claims carried by a workload capability (`mh1.<payload>.<hmac>`,
/// ADR-0025a §D6). The SDK may validate these non-secret claims but never mints
/// a capability itself — that requires an injected `MetaProxyLifecycleProvider`
/// (ADR-0025b) advertising the exact scoped operation. The signing HMAC is
/// deliberately NOT modeled here: this struct holds only the inspectable,
/// non-secret payload.
#[derive(Debug, Clone)]
pub struct WorkloadCapabilityClaims {
    pub version: String,
    pub policy: WorkloadPolicy,
    pub worktree_id: String,
    /// Expiry timestamp; the current format is at most 12 hours ahead (§D6).
    pub expires_at: String,
}

fn fingerprint_of(product: &str, token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(product.as_bytes());
    hasher.update(b":");
    hasher.update(token.as_bytes());
    let digest = hasher.finalize();
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

#[allow(clippy::result_large_err)]
fn resolve_token(
    token: Option<String>,
    env_var: &str,
    env: Option<&HashMap<String, String>>,
) -> Result<String, AgenticError> {
    if let Some(token) = token {
        if !token.is_empty() {
            return Ok(token);
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
        product: Some(PRODUCT.to_owned()),
        ..AgenticError::new(
            AgenticErrorKind::Configuration,
            format!("local proxy token is required — pass token or set {env_var}"),
        )
    })
}

/// Construction-time options for [`LocalBearerTokenCredentialProvider`].
#[derive(Debug, Clone, Default)]
pub struct LocalBearerTokenCredentialProviderOptions {
    /// Explicit local bearer token. When `None`, resolved from `env_var`
    /// (default [`DEFAULT_META_PROXY_TOKEN_ENV_VAR`]).
    pub token: Option<String>,
    /// Override the environment variable checked when `token` is `None`.
    pub env_var: Option<String>,
    /// Injectable environment map, for testing. Defaults to the real process
    /// environment via [`std::env::var`].
    pub env: Option<HashMap<String, String>>,
}

/// Concrete [`CredentialProvider`] for the local Meta Proxy bearer token
/// (ADR-0025a §D6). Mirrors
/// [`crate::agentic::static_api_key_provider::StaticApiKeyCredentialProvider`]:
/// construction-time fail-closed key resolution, exact
/// product/origin/audience matching, and `bearer` scheme. Bound to `product =
/// "meta-proxy"` — it refuses any other product, so a Meta LLM or cloud
/// request can never draw the local bearer.
#[derive(Debug)]
pub struct LocalBearerTokenCredentialProvider {
    secret: RedactedSecret,
    normalized_origin: String,
    audience: String,
    fingerprint: String,
    invalidated: AtomicBool,
}

impl LocalBearerTokenCredentialProvider {
    /// Construct a provider bound to `normalized_origin` / `audience`,
    /// resolving the token from the explicit arg, then the env var, then a
    /// `Configuration` error at construction time (never at first request).
    #[allow(clippy::result_large_err)]
    pub fn new(
        normalized_origin: impl Into<String>,
        audience: impl Into<String>,
        options: LocalBearerTokenCredentialProviderOptions,
    ) -> Result<Self, AgenticError> {
        let env_var = options
            .env_var
            .unwrap_or_else(|| DEFAULT_META_PROXY_TOKEN_ENV_VAR.to_owned());
        let token = resolve_token(options.token, &env_var, options.env.as_ref())?;
        let fingerprint = fingerprint_of(PRODUCT, &token);
        Ok(Self {
            secret: RedactedSecret::new(token),
            normalized_origin: normalized_origin.into(),
            audience: audience.into(),
            fingerprint,
            invalidated: AtomicBool::new(false),
        })
    }

    fn authority(&self) -> CredentialAuthority {
        CredentialAuthority {
            provider_fingerprint: self.fingerprint.clone(),
            product: PRODUCT.to_owned(),
            normalized_origin: self.normalized_origin.clone(),
            audience: self.audience.clone(),
            principal: None,
            tenant: None,
            delegated_subtenant: None,
            effective_scopes: None,
            plan: None,
        }
    }

    /// Fail-closed match check (ADR-0025a §D6, ADR-0022 §D3). Exact string
    /// equality only — no wildcard origin, suffix matching, or DNS-parent
    /// trust — so a cross-origin redirect can never re-present the bearer.
    #[allow(clippy::result_large_err)]
    fn assert_match(&self, request: &CredentialRequest) -> Result<(), AgenticError> {
        if request.product != PRODUCT {
            return Err(AgenticError {
                product: Some(PRODUCT.to_owned()),
                operation: Some(request.operation.clone()),
                ..AgenticError::new(
                    AgenticErrorKind::Authentication,
                    format!(
                        "local proxy bearer provider {} is bound to product \"{PRODUCT}\", \
                         refusing request for product \"{}\"",
                        self.identity(),
                        request.product,
                    ),
                )
            });
        }
        if request.normalized_origin != self.normalized_origin {
            return Err(AgenticError {
                product: Some(PRODUCT.to_owned()),
                operation: Some(request.operation.clone()),
                ..AgenticError::new(
                    AgenticErrorKind::Authentication,
                    format!(
                        "local proxy bearer provider {} is bound to origin \"{}\", refusing \
                         request for origin \"{}\" (ADR-0025a §D6: cross-origin redirects are \
                         rejected; the bearer is not re-presented to another origin)",
                        self.identity(),
                        self.normalized_origin,
                        request.normalized_origin,
                    ),
                )
            });
        }
        if request.audience != self.audience {
            return Err(AgenticError {
                product: Some(PRODUCT.to_owned()),
                operation: Some(request.operation.clone()),
                ..AgenticError::new(
                    AgenticErrorKind::Authentication,
                    format!(
                        "local proxy bearer provider {} is bound to audience \"{}\", refusing \
                         request for audience \"{}\"",
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
impl CredentialProvider for LocalBearerTokenCredentialProvider {
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
                product: Some(PRODUCT.to_owned()),
                ..AgenticError::new(
                    AgenticErrorKind::Authentication,
                    format!(
                        "local proxy bearer provider {} has been invalidated",
                        self.identity()
                    ),
                )
            });
        }
        Ok(Credential {
            scheme: "bearer".to_owned(),
            secret: self.secret.clone(),
            expires_at: None,
            granted_scopes: None,
            audience: self.audience.clone(),
            source: self.identity(),
            authority: self.authority(),
        })
    }

    fn identity(&self) -> String {
        format!("local-proxy-bearer:{}:{}", PRODUCT, self.fingerprint)
    }

    async fn invalidate(&self, _reason: &str) {
        self.invalidated.store(true, Ordering::SeqCst);
    }
}
