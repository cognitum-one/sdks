use std::time::Duration;

use thiserror::Error;

/// Errors returned by the Cognitum SDK.
#[derive(Error, Debug)]
pub enum Error {
    /// Authentication failed (401).
    #[error("authentication failed: {0}")]
    Auth(String),

    /// Rate limited (429). The caller should retry after the given duration.
    ///
    /// `retry_after_ms` is populated from the server's hint, resolved in
    /// ADR-0005 §"429 handling" order:
    /// 1. `Retry-After` header (seconds integer),
    /// 2. `Retry-After` header (HTTP-date — delta from now),
    /// 3. JSON body `retry_after_us` (microseconds, seed convention),
    /// 4. JSON body `error` text matching `"retry after Ns"`,
    /// 5. ADR-0005 equal-jitter fallback.
    ///
    /// Body signal wins over header when both are present (proxies strip
    /// headers but preserve the body).
    #[error("rate limited, retry after {retry_after_ms}ms")]
    RateLimit {
        /// Milliseconds to wait before retrying.
        retry_after_ms: u64,
    },

    /// The request failed server-side validation.
    #[error("validation error: {0}")]
    Validation(String),

    /// The requested resource was not found (404).
    #[error("not found: {0}")]
    NotFound(String),

    /// A non-specific API error with an HTTP status code.
    #[error("API error {code}: {message}")]
    Api {
        /// HTTP status code.
        code: u16,
        /// Human-readable error message from the server.
        message: String,
    },

    /// An underlying HTTP transport error from reqwest.
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    /// JSON serialization / deserialization error.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

impl Error {
    /// If this is a `RateLimit` error, return the retry delay as a
    /// [`Duration`]. Ergonomic accessor so callers don't need to convert
    /// `retry_after_ms` manually.
    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            Error::RateLimit { retry_after_ms } => Some(Duration::from_millis(*retry_after_ms)),
            _ => None,
        }
    }
}
