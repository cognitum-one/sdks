use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use reqwest::header::HeaderMap;
use reqwest::StatusCode;
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::brain::BrainResource;
use crate::catalog::CatalogResource;
use crate::contact::ContactResource;
use crate::devices::DevicesResource;
use crate::error::Error;
use crate::leads::LeadsResource;
use crate::mcp::McpResource;
use crate::orders::OrdersResource;
use crate::retry_hint::{equal_jitter_backoff, parse_retry_after};
use crate::types::HealthResponse;

const DEFAULT_BASE_URL: &str = "https://api.cognitum.one";
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const DEFAULT_MAX_RETRIES: u32 = 3;

/// One-shot flag guarding the per-process `danger_accept_invalid_certs` warning.
static INSECURE_TLS_WARNED: AtomicBool = AtomicBool::new(false);

/// Configuration for the Cognitum [`Client`].
#[derive(Debug, Clone)]
pub struct ClientConfig {
    /// API key used by default in the `X-API-Key` header (per ADR-0003).
    ///
    /// If `use_bearer` is enabled via [`ClientBuilder::deprecated_bearer_auth`],
    /// the legacy `Authorization: Bearer <key>` header is sent alongside
    /// `X-API-Key` for the deprecation window.
    pub api_key: String,
    /// Override the API base URL (useful for testing).
    pub base_url: Option<String>,
    /// HTTP request timeout in seconds.
    pub timeout_secs: u64,
    /// Maximum number of automatic retries for transient errors (429/500/503).
    pub max_retries: u32,
    /// Emit the legacy `Authorization: Bearer <key>` header in addition to
    /// `X-API-Key`. Kept for 2 minor releases per ADR-0003.
    pub use_bearer: bool,
    /// Accept invalid/self-signed TLS certificates. Development only.
    pub insecure: bool,
    /// PEM-encoded root certificate to trust as the sole issuer for pinning
    /// self-signed seed certs. Mutually exclusive with `insecure`.
    pub trust_root_pem: Option<Vec<u8>>,
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            base_url: None,
            timeout_secs: DEFAULT_TIMEOUT_SECS,
            max_retries: DEFAULT_MAX_RETRIES,
            use_bearer: false,
            insecure: false,
            trust_root_pem: None,
        }
    }
}

/// Builder for [`Client`] giving fine-grained control over auth and TLS knobs.
///
/// Prefer [`Client::new`] for simple usage; reach for [`ClientBuilder`] when
/// you need to talk to a self-signed seed, pin a custom root, or opt into the
/// deprecated `Authorization: Bearer` header for compatibility with
/// pre-ADR-0003 servers.
#[derive(Debug, Clone, Default)]
pub struct ClientBuilder {
    config: ClientConfig,
}

impl ClientBuilder {
    /// Create an empty builder.
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the API key.
    pub fn api_key(mut self, api_key: impl Into<String>) -> Self {
        self.config.api_key = api_key.into();
        self
    }

    /// Override the API base URL (useful for testing).
    pub fn base_url(mut self, base_url: impl Into<String>) -> Self {
        self.config.base_url = Some(base_url.into());
        self
    }

    /// Override the request timeout in seconds.
    pub fn timeout_secs(mut self, timeout_secs: u64) -> Self {
        self.config.timeout_secs = timeout_secs;
        self
    }

    /// Maximum automatic retries for transient errors.
    pub fn max_retries(mut self, max_retries: u32) -> Self {
        self.config.max_retries = max_retries;
        self
    }

    /// Enable the legacy `Authorization: Bearer <key>` header **in addition**
    /// to `X-API-Key` for compatibility with pre-ADR-0003 servers.
    ///
    /// This is a deprecation-window flag that will be removed in 2 minor
    /// releases. On every `true` call the SDK logs a one-line deprecation
    /// warning via `eprintln!` unless `COGNITUM_SUPPRESS_BEARER_WARNING` is
    /// set in the environment.
    pub fn deprecated_bearer_auth(mut self, enabled: bool) -> Self {
        if enabled && std::env::var("COGNITUM_SUPPRESS_BEARER_WARNING").is_err() {
            eprintln!(
                "cognitum-rs: `deprecated_bearer_auth(true)` enables \
                 `Authorization: Bearer` alongside `X-API-Key` — this is a \
                 deprecation-window flag (ADR-0003) and will be removed in a \
                 future minor release. Set \
                 COGNITUM_SUPPRESS_BEARER_WARNING=1 to silence this warning."
            );
        }
        self.config.use_bearer = enabled;
        self
    }

    /// Accept invalid/self-signed TLS certs. **Use only for development
    /// against local seed hardware.** Production callers must supply a
    /// pinned root via [`ClientBuilder::trust_root_pem`] instead.
    pub fn danger_accept_invalid_certs(mut self, enabled: bool) -> Self {
        self.config.insecure = enabled;
        self
    }

    /// Trust a specific root CA (PEM-encoded). Used for pinning the
    /// self-signed cert of a known seed. When set, this cert is the ONLY
    /// root (system trust store is disabled).
    pub fn trust_root_pem(mut self, pem: impl Into<Vec<u8>>) -> Self {
        self.config.trust_root_pem = Some(pem.into());
        self
    }

    /// Trust a specific root CA loaded from a file path. PEM-encoded.
    pub fn trust_root_pem_file(mut self, path: impl AsRef<Path>) -> std::io::Result<Self> {
        let pem = std::fs::read(path)?;
        self.config.trust_root_pem = Some(pem);
        Ok(self)
    }

    /// Build the configured [`Client`].
    pub fn build(self) -> Result<Client, Error> {
        Client::try_with_config(self.config)
    }
}

/// The main entry point for the Cognitum API.
///
/// Create a [`Client`] with [`Client::new`] (minimal), [`Client::with_config`]
/// (full control, panics on build failure), or [`Client::builder`] (fallible,
/// supports TLS knobs).
#[derive(Debug)]
pub struct Client {
    pub(crate) http: reqwest::Client,
    pub(crate) config: ClientConfig,
    pub(crate) base_url: String,
}

impl Client {
    /// Create a client with the given API key and default settings.
    pub fn new(api_key: &str) -> Self {
        let config = ClientConfig {
            api_key: api_key.to_owned(),
            ..Default::default()
        };
        Self::with_config(config)
    }

    /// Start configuring a new [`Client`] via the fluent builder.
    pub fn builder() -> ClientBuilder {
        ClientBuilder::new()
    }

    /// Create a client with full configuration control.
    ///
    /// Panics if the underlying `reqwest::Client` fails to build. Use
    /// [`Client::try_with_config`] or [`Client::builder`] for a fallible path.
    pub fn with_config(config: ClientConfig) -> Self {
        Self::try_with_config(config).expect("failed to build reqwest client")
    }

    /// Fallible variant of [`Client::with_config`].
    pub fn try_with_config(config: ClientConfig) -> Result<Self, Error> {
        let base_url = config
            .base_url
            .clone()
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());

        let http = Self::build_http_client(&config)?;

        Ok(Self {
            http,
            config,
            base_url,
        })
    }

    /// Read-only view of the effective configuration. Useful for tests and
    /// for callers that want to log the resolved settings.
    pub fn config(&self) -> &ClientConfig {
        &self.config
    }

    fn build_http_client(config: &ClientConfig) -> Result<reqwest::Client, Error> {
        if config.insecure && config.trust_root_pem.is_some() {
            return Err(Error::Validation(
                "`danger_accept_invalid_certs` and `trust_root_pem` are \
                 mutually exclusive; pick one TLS mode"
                    .to_owned(),
            ));
        }

        let mut builder =
            reqwest::Client::builder().timeout(Duration::from_secs(config.timeout_secs));

        if config.insecure {
            if !INSECURE_TLS_WARNED.swap(true, Ordering::Relaxed) {
                eprintln!(
                    "cognitum-rs: TLS certificate validation is DISABLED via \
                     `danger_accept_invalid_certs(true)`. Never use this in \
                     production — prefer `trust_root_pem` for self-signed \
                     seeds (ADR-0007)."
                );
            }
            builder = builder.danger_accept_invalid_certs(true);
        } else if let Some(pem) = config.trust_root_pem.as_ref() {
            let cert = reqwest::Certificate::from_pem(pem)
                .map_err(|e| Error::Validation(format!("invalid trust_root_pem: {e}")))?;
            builder = builder
                .tls_built_in_root_certs(false)
                .add_root_certificate(cert);
        }

        builder.build().map_err(Error::from)
    }

    // -- resource accessors --------------------------------------------------

    /// Access the catalog API.
    pub fn catalog(&self) -> CatalogResource<'_> {
        CatalogResource { client: self }
    }

    /// Access the orders API.
    pub fn orders(&self) -> OrdersResource<'_> {
        OrdersResource { client: self }
    }

    /// Access the leads API.
    pub fn leads(&self) -> LeadsResource<'_> {
        LeadsResource { client: self }
    }

    /// Access the contact API.
    pub fn contact(&self) -> ContactResource<'_> {
        ContactResource { client: self }
    }

    /// Access the devices API.
    pub fn devices(&self) -> DevicesResource<'_> {
        DevicesResource { client: self }
    }

    /// Access the MCP tools API.
    pub fn mcp(&self) -> McpResource<'_> {
        McpResource { client: self }
    }

    /// Access the brain / knowledge API.
    pub fn brain(&self) -> BrainResource<'_> {
        BrainResource { client: self }
    }

    /// Perform a health check against the API.
    pub async fn health(&self) -> Result<HealthResponse, Error> {
        self.get("/health").await
    }

    // -- internal HTTP helpers -----------------------------------------------

    pub(crate) async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, Error> {
        self.request(reqwest::Method::GET, path, Option::<&()>::None)
            .await
    }

    pub(crate) async fn post<T: DeserializeOwned, B: Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T, Error> {
        self.request(reqwest::Method::POST, path, Some(body)).await
    }

    async fn request<T: DeserializeOwned, B: Serialize>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&B>,
    ) -> Result<T, Error> {
        let url = format!("{}{}", self.base_url, path);
        let mut attempts = 0u32;

        loop {
            attempts += 1;

            let mut req = self
                .http
                .request(method.clone(), &url)
                .header("X-API-Key", &self.config.api_key);

            if self.config.use_bearer {
                // Deprecation window: keep Bearer alongside X-API-Key so
                // servers mid-migration continue to authenticate us.
                req = req.header("Authorization", format!("Bearer {}", self.config.api_key));
            }

            if let Some(b) = body {
                req = req.json(b);
            }

            let response = req.send().await?;
            let status = response.status();

            // Fast path: success responses stream the body for parsing
            // without any Retry-After work.
            if status.is_success() {
                let text = response.text().await?;
                let parsed: T = serde_json::from_str(&text)?;
                return Ok(parsed);
            }

            // Drain headers and body once so we can both (a) compute a
            // Retry-After hint and (b) surface the body verbatim if we
            // stop retrying.
            let headers = response.headers().clone();
            let body_text = response.text().await.unwrap_or_default();

            if Self::is_retryable(status) && attempts <= self.config.max_retries {
                let delay = self.backoff_duration(status, attempts, &headers, &body_text);
                tokio::time::sleep(delay).await;
                continue;
            }

            return Err(Self::map_error(status, &headers, body_text));
        }
    }

    fn is_retryable(status: StatusCode) -> bool {
        matches!(
            status,
            StatusCode::TOO_MANY_REQUESTS
                | StatusCode::INTERNAL_SERVER_ERROR
                | StatusCode::SERVICE_UNAVAILABLE
        )
    }

    /// Per-attempt backoff (ADR-0005 §"Backoff formula").
    ///
    /// For 429 we first consult the parsed server hint. For 500/503 (or
    /// 429 without a hint) we fall back to equal-jitter exponential
    /// backoff: `min(cap, base * 2^attempt + uniform[0, base))`.
    fn backoff_duration(
        &self,
        status: StatusCode,
        attempt: u32,
        headers: &HeaderMap,
        body_text: &str,
    ) -> Duration {
        if status == StatusCode::TOO_MANY_REQUESTS {
            if let Some(d) = parse_retry_after(headers, body_text) {
                return d;
            }
        }
        equal_jitter_backoff(attempt)
    }

    fn map_error(status: StatusCode, headers: &HeaderMap, body: String) -> Error {
        match status {
            StatusCode::UNAUTHORIZED => Error::Auth(body),
            StatusCode::TOO_MANY_REQUESTS => {
                // Populate the retry hint with whatever we parsed. If
                // nothing was advertised, fall back to ADR-0005 equal
                // jitter on attempt 1 so callers that sleep on
                // `err.retry_after()` still get a sane, non-zero delay.
                let retry_after_ms = parse_retry_after(headers, &body)
                    .unwrap_or_else(|| equal_jitter_backoff(1))
                    .as_millis() as u64;
                Error::RateLimit { retry_after_ms }
            }
            StatusCode::UNPROCESSABLE_ENTITY | StatusCode::BAD_REQUEST => Error::Validation(body),
            StatusCode::NOT_FOUND => Error::NotFound(body),
            _ => Error::Api {
                code: status.as_u16(),
                message: body,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_defaults_to_x_api_key_only() {
        let builder = ClientBuilder::new().api_key("k");
        assert!(!builder.config.use_bearer);
        assert!(!builder.config.insecure);
        assert!(builder.config.trust_root_pem.is_none());
    }

    #[test]
    fn deprecated_bearer_auth_flag_sets_use_bearer() {
        std::env::set_var("COGNITUM_SUPPRESS_BEARER_WARNING", "1");
        let builder = ClientBuilder::new()
            .api_key("k")
            .deprecated_bearer_auth(true);
        assert!(builder.config.use_bearer);
        std::env::remove_var("COGNITUM_SUPPRESS_BEARER_WARNING");
    }

    #[test]
    fn mutually_exclusive_tls_modes_fail_to_build() {
        let config = ClientConfig {
            api_key: "k".into(),
            insecure: true,
            trust_root_pem: Some(b"not a real pem".to_vec()),
            ..Default::default()
        };
        let err = Client::try_with_config(config).unwrap_err();
        match err {
            Error::Validation(msg) => {
                assert!(msg.contains("mutually exclusive"), "msg = {msg}");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[test]
    fn invalid_pem_is_surfaced_as_validation_error() {
        let config = ClientConfig {
            api_key: "k".into(),
            trust_root_pem: Some(b"not a pem".to_vec()),
            ..Default::default()
        };
        let err = Client::try_with_config(config).unwrap_err();
        assert!(matches!(err, Error::Validation(_)), "got {err:?}");
    }

    #[test]
    fn danger_accept_invalid_certs_builds_successfully() {
        let client = ClientBuilder::new()
            .api_key("k")
            .danger_accept_invalid_certs(true)
            .build()
            .expect("client should build with insecure TLS");
        assert!(client.config.insecure);
    }
}
