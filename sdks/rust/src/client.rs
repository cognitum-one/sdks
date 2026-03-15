use std::time::Duration;

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
use crate::types::HealthResponse;

const DEFAULT_BASE_URL: &str =
    "https://api.cognitum.one";
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const DEFAULT_MAX_RETRIES: u32 = 3;

/// Configuration for the Cognitum [`Client`].
#[derive(Debug, Clone)]
pub struct ClientConfig {
    /// API key used in the `Authorization: Bearer <key>` header.
    pub api_key: String,
    /// Override the API base URL (useful for testing).
    pub base_url: Option<String>,
    /// HTTP request timeout in seconds.
    pub timeout_secs: u64,
    /// Maximum number of automatic retries for transient errors (429/500/503).
    pub max_retries: u32,
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            base_url: None,
            timeout_secs: DEFAULT_TIMEOUT_SECS,
            max_retries: DEFAULT_MAX_RETRIES,
        }
    }
}

/// The main entry point for the Cognitum API.
///
/// Create a [`Client`] with [`Client::new`] (minimal) or
/// [`Client::with_config`] (full control) and then access API resources via
/// the helper methods (`.catalog()`, `.orders()`, etc.).
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

    /// Create a client with full configuration control.
    pub fn with_config(config: ClientConfig) -> Self {
        let base_url = config
            .base_url
            .clone()
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());

        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.timeout_secs))
            .build()
            .expect("failed to build reqwest client");

        Self {
            http,
            config,
            base_url,
        }
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

    pub(crate) async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
    ) -> Result<T, Error> {
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
                .header("Authorization", format!("Bearer {}", self.config.api_key));

            if let Some(b) = body {
                req = req.json(b);
            }

            let response = req.send().await?;
            let status = response.status();

            // Retryable status codes
            if Self::is_retryable(status) && attempts <= self.config.max_retries
            {
                let backoff = self.backoff_duration(status, attempts, &response).await;
                tokio::time::sleep(backoff).await;
                continue;
            }

            if status.is_success() {
                let text = response.text().await?;
                let parsed: T = serde_json::from_str(&text)?;
                return Ok(parsed);
            }

            return Err(Self::map_error(status, response).await);
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

    async fn backoff_duration(
        &self,
        status: StatusCode,
        attempt: u32,
        response: &reqwest::Response,
    ) -> Duration {
        if status == StatusCode::TOO_MANY_REQUESTS {
            // Respect Retry-After header if present (in seconds).
            if let Some(val) = response.headers().get("retry-after") {
                if let Ok(s) = val.to_str() {
                    if let Ok(secs) = s.parse::<u64>() {
                        return Duration::from_secs(secs);
                    }
                }
            }
        }
        // Exponential backoff: 500ms, 1s, 2s, ...
        Duration::from_millis(500 * 2u64.pow(attempt.saturating_sub(1)))
    }

    async fn map_error(
        status: StatusCode,
        response: reqwest::Response,
    ) -> Error {
        let body = response.text().await.unwrap_or_default();

        match status {
            StatusCode::UNAUTHORIZED => Error::Auth(body),
            StatusCode::TOO_MANY_REQUESTS => {
                // If we exhausted retries we still surface the rate limit.
                Error::RateLimit {
                    retry_after_ms: 1000,
                }
            }
            StatusCode::UNPROCESSABLE_ENTITY | StatusCode::BAD_REQUEST => {
                Error::Validation(body)
            }
            StatusCode::NOT_FOUND => Error::NotFound(body),
            _ => Error::Api {
                code: status.as_u16(),
                message: body,
            },
        }
    }
}
