//! Seed-specific error plumbing.
//!
//! The base [`Error`](crate::Error) enum lives in `src/error.rs` and is
//! owned by the Rust pre-fix track. This module:
//!
//! * wraps the subset of variants the seed module needs;
//! * re-exports helper builders that construct the correct base variant
//!   without poking private fields on `Error`.
//!
//! When the pre-fix lands the 12-variant ADR-0004 error, the helpers below
//! collapse to a single mapping function; for now the base `Error` only
//! has `Auth(String)` / `NotFound(String)` / `Validation(String)` etc, so
//! seed-specific metadata (`AuthReason`, `retry-after`, endpoint path)
//! gets encoded into the existing `message: String` payloads.

use reqwest::StatusCode;

use crate::error::Error as BaseError;

/// Reason slot for an `Auth` failure. Matches ADR-0004 §"AuthReason"
/// spelling (wire form `snake_case`).
///
/// Tracked as a plain `&'static str` rather than a dedicated `enum`
/// because the base `Error::Auth` variant is a `String` today; the
/// reason is prefixed into the message as `not_paired: …` so callers can
/// pattern-match with `.starts_with(...)` until the pre-fix lands.
pub mod auth_reason {
    /// `401` or `403` with no more specific hint.
    pub const INVALID_CREDENTIALS: &str = "invalid_credentials";
    /// 403 body contains `not paired` (seed pairing check).
    pub const NOT_PAIRED: &str = "not_paired";
    /// 403 body contains `pairing window` (`/pair/window` gate).
    pub const PAIRING_WINDOW_CLOSED: &str = "pairing_window_closed";
    /// 403 body contains `lockdown` or `mTLS` (ADR-0007 §Lockdown).
    pub const LOCKDOWN_MTLS_REQUIRED: &str = "lockdown_mtls_required";
    /// Client-side guard after 3 auth failures on one credential.
    pub const TRUST_SCORE_BLOCKED: &str = "trust_score_blocked";
    /// No API key / token at construction time.
    pub const NO_CREDENTIALS: &str = "no_credentials";
}

/// Best-effort parser: seed error envelope is `{"error": "..."}` per
/// `seed/src/cognitum-agent/src/http.rs:136-137`. Returns the `error`
/// field when present, else the raw body, else the HTTP status phrase.
pub fn seed_error_message(status: StatusCode, body: &str) -> String {
    #[derive(serde::Deserialize)]
    struct Envelope {
        #[serde(default)]
        error: String,
    }
    if let Ok(env) = serde_json::from_str::<Envelope>(body) {
        if !env.error.is_empty() {
            return env.error;
        }
    }
    if !body.is_empty() {
        return body.to_owned();
    }
    status.canonical_reason().unwrap_or("unknown").to_owned()
}

/// Map the non-success response to a base [`Error`].
///
/// `endpoint_path` is surfaced in `NotFound` / "not implemented" messages.
pub fn from_response(status: StatusCode, body: &str, endpoint_path: &str) -> BaseError {
    let msg = seed_error_message(status, body);
    let lower = msg.to_ascii_lowercase();

    match status.as_u16() {
        401 => BaseError::Auth(format!("{}: {msg}", auth_reason::INVALID_CREDENTIALS)),
        403 => {
            let reason = if lower.contains("not paired") {
                auth_reason::NOT_PAIRED
            } else if lower.contains("pairing window") {
                auth_reason::PAIRING_WINDOW_CLOSED
            } else if lower.contains("lockdown") || lower.contains("mtls") {
                auth_reason::LOCKDOWN_MTLS_REQUIRED
            } else if lower.contains("trust") || lower.contains("blocked") {
                auth_reason::TRUST_SCORE_BLOCKED
            } else {
                auth_reason::INVALID_CREDENTIALS
            };
            BaseError::Auth(format!("{reason}: {msg}"))
        }
        400 | 405 | 422 => BaseError::Validation(msg),
        404 => BaseError::NotFound(format!("{endpoint_path} (seed): {msg}")),
        429 => BaseError::RateLimit {
            retry_after_ms: 1000,
        },
        501 => BaseError::Validation(format!("not_implemented: {endpoint_path}: {msg}")),
        503 => BaseError::Api {
            code: 503,
            message: format!("unavailable: {msg}"),
        },
        code => BaseError::Api { code, message: msg },
    }
}

/// Build the "mesh routing not implemented yet" error. Phase 1.5 blocker.
pub fn not_implemented(feature: &str) -> BaseError {
    BaseError::Validation(format!(
        "not_implemented: feature `{feature}` is reserved for Phase 1.5"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_error_message_reads_envelope() {
        let got = seed_error_message(StatusCode::FORBIDDEN, r#"{"error": "not paired"}"#);
        assert_eq!(got, "not paired");
    }

    #[test]
    fn seed_error_message_falls_back_to_body() {
        let got = seed_error_message(StatusCode::BAD_REQUEST, "raw-bytes");
        assert_eq!(got, "raw-bytes");
    }

    #[test]
    fn seed_error_message_falls_back_to_status() {
        let got = seed_error_message(StatusCode::BAD_REQUEST, "");
        assert_eq!(got, "Bad Request");
    }

    #[test]
    fn from_response_401_is_invalid_credentials() {
        let err = from_response(
            StatusCode::UNAUTHORIZED,
            r#"{"error":"bad key"}"#,
            "/api/v1/status",
        );
        match err {
            BaseError::Auth(m) => assert!(m.starts_with(auth_reason::INVALID_CREDENTIALS)),
            other => panic!("expected Auth, got {other:?}"),
        }
    }

    #[test]
    fn from_response_403_not_paired() {
        let err = from_response(
            StatusCode::FORBIDDEN,
            r#"{"error":"not paired"}"#,
            "/api/v1/store/ingest",
        );
        match err {
            BaseError::Auth(m) => assert!(m.starts_with(auth_reason::NOT_PAIRED)),
            other => panic!("expected Auth, got {other:?}"),
        }
    }

    #[test]
    fn from_response_404_includes_path() {
        let err = from_response(StatusCode::NOT_FOUND, "", "/api/v1/unknown");
        match err {
            BaseError::NotFound(m) => assert!(m.contains("/api/v1/unknown")),
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn from_response_501_marked_not_implemented() {
        let err = from_response(StatusCode::NOT_IMPLEMENTED, "", "/api/v1/delta/stream");
        match err {
            BaseError::Validation(m) => {
                assert!(m.contains("not_implemented"));
                assert!(m.contains("/api/v1/delta/stream"));
            }
            other => panic!("expected Validation (not_implemented), got {other:?}"),
        }
    }
}
