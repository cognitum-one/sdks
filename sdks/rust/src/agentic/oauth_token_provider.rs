//! Concrete [`CredentialProvider`] for a delegated Cognitum OAuth access
//! token (ADR-0022 §D1, §D2, §D3; ADR-0024a §D8). Closes the gap left by
//! PR #83's `StaticApiKeyCredentialProvider`: ADR-0022 §D2's
//! credential/header matrix names Meta LLM as accepting "Product-declared
//! `cog_` key OR a delegated OAuth token" ("Never send both; route scope
//! and auth method are negotiated"), but until this provider, only the
//! `cog_`-key half of that row had an implementation.
//!
//! This provider does NOT implement an OAuth authorization-code/PKCE
//! browser login flow — that is out of scope here, exactly as
//! `StaticApiKeyCredentialProvider` accepts an already-resolved API key
//! rather than minting one. It accepts either:
//!
//! - an explicit, already-acquired access token (optionally with its own
//!   expiry/granted-scopes), or
//! - an injectable [`OAuthTokenSource`] the caller implements against
//!   their own OAuth refresh-token flow, invoked lazily on first
//!   `acquire()` and again — at most once per `acquire()` call — when the
//!   current token is expired.
//!
//! Wire scheme is `"Bearer"` (not `"X-API-Key"`), per ADR-0022 §D2's
//! "delegated OAuth token" row and ADR-0024a §D8's OAuth-uses-bearer
//! convention; `apply_auth` in `meta_llm::http`/`meta_llm::nonstream`
//! already special-cases `scheme.eq_ignore_ascii_case("bearer")` to write
//! the standard `Authorization` header instead of a literal header named
//! after the scheme string, so this provider only has to supply that
//! scheme name.
//!
//! Origin/audience/product binding mirrors
//! `StaticApiKeyCredentialProvider` exactly (ADR-0022 §D1/§D3): exact
//! string equality only, no wildcard origin or suffix matching. The
//! returned secret is wrapped in the same `RedactedSecret` type — `Debug`,
//! `Display`, and serde-by-default MUST NOT reveal it.
//!
//! No HTTP request is made or shaped here — this type produces
//! credentials, it does not send them.

use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use sha2::{Digest, Sha256};

use crate::agentic::credentials::{
    Credential, CredentialAuthority, CredentialProvider, CredentialRequest, RedactedSecret,
};
use crate::agentic::errors::{AgenticError, AgenticErrorKind};

/// Result of an [`OAuthTokenSource::fetch`] call.
#[derive(Debug, Clone)]
pub struct OAuthTokenSourceResult {
    pub access_token: String,
    /// `None` means the token does not expire (or expiry is unknown to
    /// the caller).
    pub expires_at: Option<SystemTime>,
    /// Scopes the identity service actually granted, if the caller's
    /// refresh flow surfaces them. Left `None` (rather than guessed) when
    /// the caller's OAuth flow doesn't expose this — ADR-0022 §D5
    /// requires the SDK never assume a broader-looking string implies
    /// permission.
    pub granted_scopes: Option<Vec<String>>,
}

/// Caller-implemented callback wired to an already-implemented OAuth
/// refresh-token flow. This provider calls [`fetch`](Self::fetch) to
/// obtain an initial token (when no explicit access token is given) and
/// to refresh an expired one — it never performs the
/// authorization-code/PKCE exchange itself.
#[async_trait]
pub trait OAuthTokenSource: fmt::Debug + Send + Sync {
    async fn fetch(&self) -> Result<OAuthTokenSourceResult, AgenticError>;
}

/// Construction-time options for [`OAuthTokenCredentialProvider`].
#[derive(Default)]
pub struct OAuthTokenCredentialProviderOptions {
    /// An already-acquired OAuth access token. When `None`,
    /// `token_provider` MUST be given — the provider fetches the initial
    /// token lazily, on the first `acquire()` call, rather than at
    /// construction time.
    pub access_token: Option<String>,
    /// Expiry of `access_token`, if known.
    pub expires_at: Option<SystemTime>,
    /// Scopes granted to `access_token`, if known.
    pub granted_scopes: Option<Vec<String>>,
    /// Caller-implemented callback wired to their own OAuth
    /// refresh-token flow. Required when `access_token` is `None`;
    /// optional (but recommended) otherwise — supplying it lets an
    /// expired explicit token be refreshed instead of failing closed.
    pub token_provider: Option<Arc<dyn OAuthTokenSource>>,
    /// Wire scheme label surfaced on the acquired [`Credential`].
    /// Defaults to `"Bearer"` per ADR-0022 §D2 / ADR-0024a §D8 — OAuth
    /// access tokens are never sent as `X-API-Key`.
    pub scheme: Option<String>,
}

#[derive(Debug, Clone)]
struct ResolvedToken {
    access_token: String,
    expires_at: Option<SystemTime>,
    granted_scopes: Option<Vec<String>>,
}

fn is_expired(token: &ResolvedToken) -> bool {
    token
        .expires_at
        .map(|expires_at| expires_at <= SystemTime::now())
        .unwrap_or(false)
}

/// Format a [`SystemTime`] as a minimal RFC3339 UTC string
/// (`"YYYY-MM-DDTHH:MM:SSZ"`), matching Node's `Date#toISOString()` /
/// Python's `datetime.isoformat()` closely enough for the `Credential.
/// expires_at: Option<String>` field. Uses Howard Hinnant's
/// `civil_from_days` algorithm — the inverse of
/// `crate::retry_hint::civil_to_unix_seconds`, which documents the same
/// source — to avoid pulling in a `chrono`/`time` dependency for this one
/// formatting call.
fn system_time_to_rfc3339(t: SystemTime) -> String {
    let unix_seconds = t
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = unix_seconds.div_euclid(86_400);
    let secs_of_day = unix_seconds.rem_euclid(86_400);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if month <= 2 { y + 1 } else { y };

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Non-secret, non-reversible-in-practice fingerprint of a token value.
fn fingerprint_of_token(product: &str, token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(product.as_bytes());
    hasher.update(b":");
    hasher.update(token.as_bytes());
    let digest = hasher.finalize();
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

static PENDING_FINGERPRINT_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Non-secret per-instance fingerprint used when no token is known yet at
/// construction (`token_provider`-only construction). Cheap
/// subsecond-`SystemTime` + monotonic-counter entropy — matching
/// `meta_llm::nonstream::random_jitter_ms`'s existing convention in this
/// codebase — rather than pulling in a `rand` dependency for a value that
/// only needs to be stable and non-secret, not cryptographically
/// unpredictable (the actual security boundary is the product/origin/
/// audience match in [`OAuthTokenCredentialProvider::assert_match`]).
fn fingerprint_of_pending(product: &str) -> String {
    let counter = PENDING_FINGERPRINT_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(product.as_bytes());
    hasher.update(b":oauth-pending:");
    hasher.update(nanos.to_le_bytes());
    hasher.update(counter.to_le_bytes());
    let digest = hasher.finalize();
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Concrete [`CredentialProvider`] wrapping one delegated Cognitum OAuth
/// access token (ADR-0022 §D1/§D2/§D3, ADR-0024a §D8). Fails closed on
/// any product, origin, or audience mismatch (mirrors
/// `StaticApiKeyCredentialProvider::assert_match`), on an expired token
/// with no refresh callback, and on any use after `invalidate()`.
///
/// `Debug` is implemented manually (rather than derived) because
/// `token_provider` is `Arc<dyn OAuthTokenSource>` — its `Debug` is
/// whatever the caller's implementation provides, which may not be
/// secret-safe, so it is deliberately omitted from this type's own
/// `Debug` output (only a `has_token_provider: bool` flag is shown).
/// `current`/`fingerprint` are `Mutex`-wrapped because
/// [`CredentialProvider::acquire`]/`invalidate` take `&self`, not
/// `&mut self` — the frozen trait shape assumes providers manage their
/// own interior mutability (same reason `StaticApiKeyCredentialProvider`
/// uses `AtomicBool` for `invalidated`).
pub struct OAuthTokenCredentialProvider {
    product: String,
    normalized_origin: String,
    audience: String,
    scheme: String,
    token_provider: Option<Arc<dyn OAuthTokenSource>>,
    current: Mutex<Option<ResolvedToken>>,
    fingerprint: Mutex<String>,
    invalidated: AtomicBool,
}

impl fmt::Debug for OAuthTokenCredentialProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OAuthTokenCredentialProvider")
            .field("product", &self.product)
            .field("normalized_origin", &self.normalized_origin)
            .field("audience", &self.audience)
            .field("scheme", &self.scheme)
            .field("has_token_provider", &self.token_provider.is_some())
            .field("invalidated", &self.invalidated.load(Ordering::SeqCst))
            .finish()
    }
}

impl OAuthTokenCredentialProvider {
    /// Construct a provider bound to `product` / `normalized_origin` /
    /// `audience`. Fails closed at construction (mirroring
    /// `StaticApiKeyCredentialProvider::new`'s fail-closed-before-any-I/O
    /// pattern) when neither `options.access_token` nor
    /// `options.token_provider` is given.
    #[allow(clippy::result_large_err)]
    pub fn new(
        product: impl Into<String>,
        normalized_origin: impl Into<String>,
        audience: impl Into<String>,
        options: OAuthTokenCredentialProviderOptions,
    ) -> Result<Self, AgenticError> {
        let product = product.into();
        if options.access_token.as_deref().unwrap_or("").is_empty()
            && options.token_provider.is_none()
        {
            return Err(AgenticError {
                product: Some(product.clone()),
                ..AgenticError::new(
                    AgenticErrorKind::Configuration,
                    "OAuthTokenCredentialProvider requires either an explicit access_token or a token_provider",
                )
            });
        }

        let (current, fingerprint) = match options.access_token.filter(|t| !t.is_empty()) {
            Some(token) => {
                let fingerprint = fingerprint_of_token(&product, &token);
                (
                    Some(ResolvedToken {
                        access_token: token,
                        expires_at: options.expires_at,
                        granted_scopes: options.granted_scopes,
                    }),
                    fingerprint,
                )
            }
            None => (None, fingerprint_of_pending(&product)),
        };

        Ok(Self {
            product,
            normalized_origin: normalized_origin.into(),
            audience: audience.into(),
            scheme: options.scheme.unwrap_or_else(|| "Bearer".to_owned()),
            token_provider: options.token_provider,
            current: Mutex::new(current),
            fingerprint: Mutex::new(fingerprint),
            invalidated: AtomicBool::new(false),
        })
    }

    fn authority(&self) -> CredentialAuthority {
        let granted_scopes = self
            .current
            .lock()
            .expect("OAuthTokenCredentialProvider mutex poisoned")
            .as_ref()
            .and_then(|t| t.granted_scopes.clone());
        CredentialAuthority {
            provider_fingerprint: self
                .fingerprint
                .lock()
                .expect("OAuthTokenCredentialProvider mutex poisoned")
                .clone(),
            product: self.product.clone(),
            normalized_origin: self.normalized_origin.clone(),
            audience: self.audience.clone(),
            principal: None,
            tenant: None,
            delegated_subtenant: None,
            effective_scopes: granted_scopes,
            plan: None,
        }
    }

    /// Fail-closed match check (ADR-0022 §D1/§D3). Exact string equality
    /// only — no wildcard origin, suffix matching, or DNS-parent trust.
    #[allow(clippy::result_large_err)]
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
impl CredentialProvider for OAuthTokenCredentialProvider {
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
                operation: Some(request.operation.clone()),
                ..AgenticError::new(
                    AgenticErrorKind::Authentication,
                    format!(
                        "credential provider {} has been invalidated",
                        self.identity()
                    ),
                )
            });
        }

        let needs_refresh = {
            let current = self
                .current
                .lock()
                .expect("OAuthTokenCredentialProvider mutex poisoned");
            match current.as_ref() {
                Some(token) => is_expired(token),
                None => true,
            }
        };

        if needs_refresh {
            let Some(source) = self.token_provider.as_ref() else {
                return Err(AgenticError {
                    product: Some(self.product.clone()),
                    operation: Some(request.operation.clone()),
                    ..AgenticError::new(
                        AgenticErrorKind::Authentication,
                        format!(
                            "credential provider {} has no valid access token (expired and no token_provider was configured to refresh it)",
                            self.identity()
                        ),
                    )
                });
            };
            let refreshed = source.fetch().await?;
            let token = ResolvedToken {
                access_token: refreshed.access_token,
                expires_at: refreshed.expires_at,
                granted_scopes: refreshed.granted_scopes,
            };
            if is_expired(&token) {
                return Err(AgenticError {
                    product: Some(self.product.clone()),
                    operation: Some(request.operation.clone()),
                    ..AgenticError::new(
                        AgenticErrorKind::Authentication,
                        format!(
                            "credential provider {}'s token_provider returned an already-expired access token",
                            self.identity()
                        ),
                    )
                });
            }
            *self
                .fingerprint
                .lock()
                .expect("OAuthTokenCredentialProvider mutex poisoned") =
                fingerprint_of_token(&self.product, &token.access_token);
            *self
                .current
                .lock()
                .expect("OAuthTokenCredentialProvider mutex poisoned") = Some(token);
        }

        let current = self
            .current
            .lock()
            .expect("OAuthTokenCredentialProvider mutex poisoned")
            .clone()
            .expect("token must be present after the refresh branch above");

        Ok(Credential {
            scheme: self.scheme.clone(),
            secret: RedactedSecret::new(current.access_token),
            expires_at: current.expires_at.map(system_time_to_rfc3339),
            granted_scopes: current.granted_scopes,
            audience: self.audience.clone(),
            source: self.identity(),
            authority: self.authority(),
        })
    }

    fn identity(&self) -> String {
        format!(
            "oauth-token:{}:{}",
            self.product,
            self.fingerprint
                .lock()
                .expect("OAuthTokenCredentialProvider mutex poisoned")
        )
    }

    async fn invalidate(&self, _reason: &str) {
        self.invalidated.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const CANARY: &str = "oauth-canary-9f3aQzL0m1";
    const REFRESHED: &str = "oauth-refreshed-CT9f3aQ";

    fn request(product: &str, origin: &str, audience: &str) -> CredentialRequest {
        CredentialRequest {
            product: product.to_owned(),
            normalized_origin: origin.to_owned(),
            audience: audience.to_owned(),
            required_scopes: vec![],
            operation: "chat.completions".to_owned(),
            interactive_allowed: false,
        }
    }

    fn base_request() -> CredentialRequest {
        request(
            "meta-llm",
            "https://meta-llm.test.cognitum.one",
            "https://meta-llm.test.cognitum.one",
        )
    }

    fn provider_with_token() -> OAuthTokenCredentialProvider {
        OAuthTokenCredentialProvider::new(
            "meta-llm",
            "https://meta-llm.test.cognitum.one",
            "https://meta-llm.test.cognitum.one",
            OAuthTokenCredentialProviderOptions {
                access_token: Some(CANARY.to_owned()),
                ..Default::default()
            },
        )
        .expect("provider construction should succeed with an explicit token")
    }

    #[derive(Debug)]
    struct FixedTokenSource {
        access_token: String,
        expires_at: Option<SystemTime>,
        calls: std::sync::atomic::AtomicU64,
    }

    impl FixedTokenSource {
        fn new(access_token: &str) -> Arc<Self> {
            Arc::new(Self {
                access_token: access_token.to_owned(),
                expires_at: None,
                calls: AtomicU64::new(0),
            })
        }

        fn with_expiry(access_token: &str, expires_at: SystemTime) -> Arc<Self> {
            Arc::new(Self {
                access_token: access_token.to_owned(),
                expires_at: Some(expires_at),
                calls: AtomicU64::new(0),
            })
        }

        fn call_count(&self) -> u64 {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl OAuthTokenSource for FixedTokenSource {
        async fn fetch(&self) -> Result<OAuthTokenSourceResult, AgenticError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(OAuthTokenSourceResult {
                access_token: self.access_token.clone(),
                expires_at: self.expires_at,
                granted_scopes: None,
            })
        }
    }

    #[tokio::test]
    async fn acquires_credential_for_matching_origin_and_audience() {
        let p = provider_with_token();
        let credential = p.acquire(&base_request()).await.expect("should succeed");

        assert_eq!(credential.scheme, "Bearer");
        assert_eq!(credential.audience, "https://meta-llm.test.cognitum.one");
        assert_eq!(credential.authority.product, "meta-llm");
        assert_eq!(credential.secret.reveal(), CANARY);
    }

    #[tokio::test]
    async fn uses_bearer_scheme_not_api_key() {
        let p = provider_with_token();
        let credential = p.acquire(&base_request()).await.expect("should succeed");
        assert_eq!(credential.scheme, "Bearer");
        assert_ne!(credential.scheme, "X-API-Key");
    }

    #[tokio::test]
    async fn describe_authority_succeeds_for_matching_request() {
        let p = provider_with_token();
        let authority = p
            .describe_authority(&base_request())
            .await
            .expect("should succeed");
        assert_eq!(authority.audience, "https://meta-llm.test.cognitum.one");
    }

    #[tokio::test]
    async fn acquires_initial_token_lazily_from_token_provider() {
        let source = FixedTokenSource::new(CANARY);
        let p = OAuthTokenCredentialProvider::new(
            "meta-llm",
            "https://meta-llm.test.cognitum.one",
            "https://meta-llm.test.cognitum.one",
            OAuthTokenCredentialProviderOptions {
                token_provider: Some(source.clone()),
                ..Default::default()
            },
        )
        .expect("should construct with only a token_provider");

        let credential = p.acquire(&base_request()).await.expect("should succeed");
        assert_eq!(credential.secret.reveal(), CANARY);
        assert_eq!(source.call_count(), 1);

        // Second acquire reuses the cached (non-expired) token -- no refresh.
        p.acquire(&base_request()).await.expect("should succeed");
        assert_eq!(source.call_count(), 1);
    }

    #[tokio::test]
    async fn refreshes_expired_explicit_token_exactly_once_via_callback() {
        let past = SystemTime::now() - Duration::from_secs(60);
        let source = FixedTokenSource::new(REFRESHED);
        let p = OAuthTokenCredentialProvider::new(
            "meta-llm",
            "https://meta-llm.test.cognitum.one",
            "https://meta-llm.test.cognitum.one",
            OAuthTokenCredentialProviderOptions {
                access_token: Some(CANARY.to_owned()),
                expires_at: Some(past),
                token_provider: Some(source.clone()),
                ..Default::default()
            },
        )
        .expect("should construct");

        let credential = p.acquire(&base_request()).await.expect("should succeed");
        assert_eq!(credential.secret.reveal(), REFRESHED);
        assert_eq!(source.call_count(), 1);
    }

    #[tokio::test]
    async fn fails_closed_when_expired_and_no_token_provider() {
        let past = SystemTime::now() - Duration::from_secs(60);
        let p = OAuthTokenCredentialProvider::new(
            "meta-llm",
            "https://meta-llm.test.cognitum.one",
            "https://meta-llm.test.cognitum.one",
            OAuthTokenCredentialProviderOptions {
                access_token: Some(CANARY.to_owned()),
                expires_at: Some(past),
                ..Default::default()
            },
        )
        .expect("should construct");

        let err = p
            .acquire(&base_request())
            .await
            .expect_err("should fail closed");
        assert_eq!(err.kind, AgenticErrorKind::Authentication);
    }

    #[tokio::test]
    async fn fails_closed_when_token_provider_returns_expired_token() {
        let past = SystemTime::now() - Duration::from_secs(60);
        let source = FixedTokenSource::with_expiry(REFRESHED, past);
        let p = OAuthTokenCredentialProvider::new(
            "meta-llm",
            "https://meta-llm.test.cognitum.one",
            "https://meta-llm.test.cognitum.one",
            OAuthTokenCredentialProviderOptions {
                token_provider: Some(source.clone()),
                ..Default::default()
            },
        )
        .expect("should construct");

        let err = p
            .acquire(&base_request())
            .await
            .expect_err("should fail closed");
        assert_eq!(err.kind, AgenticErrorKind::Authentication);
        assert_eq!(source.call_count(), 1);
    }

    #[test]
    fn fails_at_construction_without_token_or_provider() {
        let result = OAuthTokenCredentialProvider::new(
            "meta-llm",
            "https://meta-llm.test.cognitum.one",
            "https://meta-llm.test.cognitum.one",
            OAuthTokenCredentialProviderOptions::default(),
        );
        let err = result.expect_err("should fail closed with neither option");
        assert_eq!(err.kind, AgenticErrorKind::Configuration);
    }

    #[tokio::test]
    async fn refuses_acquire_for_different_origin() {
        let p = provider_with_token();
        let req = request(
            "meta-llm",
            "https://evil.example.com",
            "https://meta-llm.test.cognitum.one",
        );
        let err = p.acquire(&req).await.expect_err("should be refused");
        assert_eq!(err.kind, AgenticErrorKind::Authentication);
    }

    #[tokio::test]
    async fn refuses_audience_mismatch() {
        let p = provider_with_token();
        let req = request(
            "meta-llm",
            "https://meta-llm.test.cognitum.one",
            "meta-proxy-api",
        );
        let err = p.acquire(&req).await.expect_err("should be refused");
        assert_eq!(err.kind, AgenticErrorKind::Authentication);
    }

    #[tokio::test]
    async fn refuses_product_mismatch() {
        let p = provider_with_token();
        let req = request(
            "meta-proxy",
            "https://meta-llm.test.cognitum.one",
            "https://meta-llm.test.cognitum.one",
        );
        let err = p.acquire(&req).await.expect_err("should be refused");
        assert_eq!(err.kind, AgenticErrorKind::Authentication);
    }

    #[tokio::test]
    async fn secret_does_not_leak_via_debug_display_or_serde() {
        let p = provider_with_token();
        let credential = p.acquire(&base_request()).await.expect("should succeed");

        let debug_str = format!("{:?}", credential.secret);
        assert!(!debug_str.contains(CANARY));
        assert!(debug_str.contains("[REDACTED]"));

        let display_str = format!("{}", credential.secret);
        assert_eq!(display_str, "[REDACTED]");

        let json = serde_json::to_string(&credential).expect("serializes");
        assert!(!json.contains(CANARY));
        assert!(json.contains("[REDACTED]"));

        // The provider's own (manual) Debug must not leak the token either.
        let provider_debug = format!("{p:?}");
        assert!(!provider_debug.contains(CANARY));
    }

    #[tokio::test]
    async fn secret_does_not_leak_via_error_display_or_debug() {
        let p = provider_with_token();
        let req = request(
            "meta-llm",
            "https://evil.example.com",
            "https://meta-llm.test.cognitum.one",
        );
        let err = p.acquire(&req).await.expect_err("should be refused");
        assert!(!format!("{err}").contains(CANARY));
        assert!(!format!("{err:?}").contains(CANARY));
    }

    #[test]
    fn identity_is_stable_and_non_secret() {
        let p = provider_with_token();
        let id = p.identity();
        assert!(!id.contains(CANARY));
        assert_eq!(id, p.identity());
    }

    #[tokio::test]
    async fn refuses_acquire_after_invalidate() {
        let p = provider_with_token();
        p.invalidate("rotated").await;
        let err = p
            .acquire(&base_request())
            .await
            .expect_err("should be refused after invalidate");
        assert_eq!(err.kind, AgenticErrorKind::Authentication);
    }

    #[tokio::test]
    async fn carries_granted_scopes_through_when_known() {
        let p = OAuthTokenCredentialProvider::new(
            "meta-llm",
            "https://meta-llm.test.cognitum.one",
            "https://meta-llm.test.cognitum.one",
            OAuthTokenCredentialProviderOptions {
                access_token: Some(CANARY.to_owned()),
                granted_scopes: Some(vec!["meta-llm.inference".to_owned()]),
                ..Default::default()
            },
        )
        .expect("should construct");
        let credential = p.acquire(&base_request()).await.expect("should succeed");
        assert_eq!(
            credential.granted_scopes,
            Some(vec!["meta-llm.inference".to_owned()])
        );
    }

    #[tokio::test]
    async fn leaves_granted_scopes_none_when_unknown() {
        let p = provider_with_token();
        let credential = p.acquire(&base_request()).await.expect("should succeed");
        assert_eq!(credential.granted_scopes, None);
    }
}
