use thiserror::Error;

/// Errors returned by the Cognitum SDK.
#[derive(Error, Debug)]
pub enum Error {
    /// Authentication failed (401).
    #[error("authentication failed: {0}")]
    Auth(String),

    /// Rate limited (429). The caller should retry after the given duration.
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
