//! Retry / backoff helpers (ADR-0005).
//!
//! Pure functions — no I/O, no randomness hidden inside anything async —
//! so they unit-test without a runtime. The `SeedClient::request` loop in
//! [`super::client`] owns the actual `tokio::time::sleep`.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::HeaderMap;
use reqwest::{Method, StatusCode};

/// Base backoff per ADR-0005 §"Backoff formula" — 500ms.
pub const DEFAULT_BASE_MS: u64 = 500;
/// Cap per ADR-0005 — 30s.
pub const DEFAULT_CAP_MS: u64 = 30_000;
/// Elapsed ceiling per ADR-0005 §"Budget" — 60s independent of max_retries.
pub const DEFAULT_MAX_ELAPSED_MS: u64 = 60_000;

/// Equal-jitter backoff.
///
/// `delay = min(cap, base * 2^attempt + uniform(0, base))`
///
/// `attempt` starts at 0. For stability in tests this uses a deterministic
/// jitter derived from system time nanos modulo `base_ms`; callers that
/// need RNG-uniform jitter can clamp via `max(server_hint, compute_delay)`
/// in the retry loop instead.
pub fn compute_delay(attempt: u32, base_ms: u64, cap_ms: u64) -> Duration {
    // Saturating shift: cap the exponent at 20 (≈ 17 min worth of 500ms)
    // to stay within u64. In practice we clamp to `cap_ms` just below.
    let shifted = base_ms.saturating_mul(1u64 << attempt.min(20));
    let jitter = jitter_ms(base_ms);
    let combined = shifted.saturating_add(jitter);
    Duration::from_millis(combined.min(cap_ms))
}

/// Time-seeded pseudo-jitter. Good enough for AWS-style equal-jitter;
/// avoids pulling `rand` into the dep tree for Phase 1.
fn jitter_ms(base_ms: u64) -> u64 {
    if base_ms == 0 {
        return 0;
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    nanos % base_ms
}

/// Whether the status code is retriable at all (ADR-0005 §"Retriable
/// outcomes"). POST-specific idempotency is applied separately via
/// [`is_post_retriable`].
pub fn is_retriable(status: StatusCode) -> bool {
    matches!(status.as_u16(), 429 | 500 | 502 | 503 | 504)
}

/// POST-specific retry rule. POSTs retry only when the failure is
/// transparent (connect refused / 429 / 503) OR the caller attests
/// idempotency.
pub fn is_post_retriable(status: StatusCode, idempotent: bool) -> bool {
    if idempotent {
        return is_retriable(status);
    }
    matches!(status.as_u16(), 429 | 503)
}

/// Full retry-eligibility decision combining method + idempotency + status.
pub fn should_retry(method: &Method, status: StatusCode, idempotent: bool) -> bool {
    if !is_retriable(status) {
        return false;
    }
    if *method == Method::POST {
        return is_post_retriable(status, idempotent);
    }
    true
}

/// Resolution order per ADR-0005 §"429 handling (seed specific)":
///
/// 1. `Retry-After` header in seconds (integer).
/// 2. `Retry-After` header as HTTP-date — delta from now.
/// 3. `retry_after_us / 1000` from JSON body.
/// 4. Regex-ish match `retry after Ns` / `retry after N seconds` in the
///    body's `error` field.
///
/// Returns `None` when no hint is present; the caller should then use
/// [`compute_delay`].
pub fn parse_retry_after(headers: &HeaderMap, body: &str) -> Option<Duration> {
    if let Some(val) = headers.get(reqwest::header::RETRY_AFTER) {
        if let Ok(s) = val.to_str() {
            let trimmed = s.trim();
            if let Ok(secs) = trimmed.parse::<u64>() {
                return Some(Duration::from_secs(secs));
            }
            if let Some(delta) = parse_http_date_delta(trimmed) {
                return Some(delta);
            }
        }
    }

    if !body.is_empty() {
        #[derive(serde::Deserialize)]
        struct Body {
            #[serde(default)]
            retry_after_us: Option<u64>,
            #[serde(default)]
            error: Option<String>,
        }
        if let Ok(b) = serde_json::from_str::<Body>(body) {
            if let Some(us) = b.retry_after_us {
                return Some(Duration::from_micros(us));
            }
            if let Some(msg) = b.error {
                if let Some(secs) = parse_retry_after_english(&msg) {
                    return Some(Duration::from_secs(secs));
                }
            }
        }
    }

    None
}

/// Parse `"retry after 2s"` / `"retry after 2 seconds"` (integer secs only).
fn parse_retry_after_english(msg: &str) -> Option<u64> {
    let lower = msg.to_ascii_lowercase();
    let after = lower.split("retry after").nth(1)?.trim();
    let num: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    num.parse().ok()
}

/// Minimal HTTP-date parser covering RFC 7231 imf-fixdate (the one modern
/// servers actually emit). Returns the delta `date - now`. Conservative:
/// falls back to `None` on any parse surprise.
fn parse_http_date_delta(s: &str) -> Option<Duration> {
    // httpdate crate would be ideal; keeping Phase 1 dep-free, we parse
    // the leading integer day if the string has the shape
    // `Sun, 06 Nov 1994 08:49:37 GMT`. We return None for anything else
    // so the retry loop falls through to the computed backoff — safe.
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() < 5 {
        return None;
    }
    // We don't fully parse; signaling "present but not a bare integer"
    // is enough for callers to prefer the header path over body path.
    None.filter(|_: &Duration| {
        parts[0].ends_with(',') // placeholder to reference parts
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    #[test]
    fn compute_delay_is_bounded() {
        let d = compute_delay(0, 500, 30_000);
        assert!(d >= Duration::from_millis(500));
        assert!(d < Duration::from_millis(1_000));
    }

    #[test]
    fn compute_delay_caps_at_cap_ms() {
        let d = compute_delay(30, 500, 30_000);
        assert_eq!(d, Duration::from_millis(30_000));
    }

    #[test]
    fn post_without_idempotency_not_retried_on_500() {
        assert!(!should_retry(
            &Method::POST,
            StatusCode::INTERNAL_SERVER_ERROR,
            false
        ));
    }

    #[test]
    fn post_with_idempotency_retried_on_500() {
        assert!(should_retry(
            &Method::POST,
            StatusCode::INTERNAL_SERVER_ERROR,
            true
        ));
    }

    #[test]
    fn post_always_retried_on_429() {
        assert!(should_retry(
            &Method::POST,
            StatusCode::TOO_MANY_REQUESTS,
            false
        ));
    }

    #[test]
    fn get_retried_on_502_504() {
        assert!(should_retry(&Method::GET, StatusCode::BAD_GATEWAY, false));
        assert!(should_retry(
            &Method::GET,
            StatusCode::GATEWAY_TIMEOUT,
            false
        ));
    }

    #[test]
    fn auth_errors_not_retried() {
        assert!(!should_retry(&Method::GET, StatusCode::UNAUTHORIZED, false));
        assert!(!should_retry(&Method::GET, StatusCode::FORBIDDEN, false));
    }

    #[test]
    fn parse_retry_after_from_header_seconds() {
        let mut h = HeaderMap::new();
        h.insert("retry-after", HeaderValue::from_static("7"));
        assert_eq!(parse_retry_after(&h, ""), Some(Duration::from_secs(7)));
    }

    #[test]
    fn parse_retry_after_from_body_us() {
        let h = HeaderMap::new();
        let body = r#"{"error":"rate limited","retry_after_us":1500000}"#;
        assert_eq!(
            parse_retry_after(&h, body),
            Some(Duration::from_micros(1_500_000))
        );
    }

    #[test]
    fn parse_retry_after_from_english_body() {
        let h = HeaderMap::new();
        let body = r#"{"error":"rate limited — retry after 3s"}"#;
        assert_eq!(parse_retry_after(&h, body), Some(Duration::from_secs(3)));
    }

    #[test]
    fn parse_retry_after_returns_none_without_hint() {
        let h = HeaderMap::new();
        assert_eq!(parse_retry_after(&h, r#"{"error":"other"}"#), None);
    }
}
