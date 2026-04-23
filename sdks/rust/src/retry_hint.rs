//! Retry-After parsing + equal-jitter backoff for the cloud `Client` path
//! (issue cognitum-one/sdks#11, ADR-0005 §"429 handling").
//!
//! Mirror of the seed-feature `src/seed/retry.rs` helper surface, minus
//! the peer/budget/consensus concerns. Kept in its own module so
//! `src/client.rs` stays under the 500-line project limit and so the two
//! implementations can drift independently if the seed convention ever
//! diverges from the cloud one (e.g. if cloud stops serving
//! `retry_after_us`).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::HeaderMap;

/// ADR-0005 equal-jitter backoff.
///
/// `delay = min(30s, 500ms * 2^(attempt-1) + uniform[0, 500ms))`.
/// `attempt` is 1-based (the request loop bumps it before calling).
pub(crate) fn equal_jitter_backoff(attempt: u32) -> Duration {
    const BASE_MS: u64 = 500;
    const CAP_MS: u64 = 30_000;
    let exp = attempt.saturating_sub(1).min(20);
    let shifted = BASE_MS.saturating_mul(1u64 << exp);
    let jitter = pseudo_jitter_ms(BASE_MS);
    Duration::from_millis(shifted.saturating_add(jitter).min(CAP_MS))
}

/// Cheap non-cryptographic jitter in `[0, bound)`. Uses
/// `SystemTime::now().subsec_nanos()` as entropy — the seed path has a
/// proper xorshift64 RNG; this cloud helper only needs to avoid lockstep
/// retries across callers. Returns 0 when `bound == 0`.
fn pseudo_jitter_ms(bound: u64) -> u64 {
    if bound == 0 {
        return 0;
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    nanos % bound
}

/// ADR-0005 §"429 handling" resolution order:
/// 1. `Retry-After` header (seconds integer),
/// 2. `Retry-After` header (HTTP-date — delta from now),
/// 3. JSON body `retry_after_us` (microseconds — seed convention),
/// 4. JSON body `error` text matching `"retry after Ns"`.
///
/// Body wins over header when both are present (seed convention — proxies
/// strip headers but preserve bodies).
pub(crate) fn parse_retry_after(headers: &HeaderMap, body: &str) -> Option<Duration> {
    let header_hint = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| {
            let trimmed = s.trim();
            if let Ok(secs) = trimmed.parse::<u64>() {
                return Some(Duration::from_secs(secs));
            }
            parse_http_date_delta(trimmed)
        });

    let body_hint = parse_body_retry_after(body);

    // Body takes precedence when present; otherwise fall back to header.
    body_hint.or(header_hint)
}

fn parse_body_retry_after(body: &str) -> Option<Duration> {
    if body.is_empty() {
        return None;
    }

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

    // Raw (non-JSON) body — still honour english "retry after Ns".
    parse_retry_after_english(body).map(Duration::from_secs)
}

/// Accepts `"retry after 2s"` / `"retry after 2 seconds"` — integer secs.
fn parse_retry_after_english(msg: &str) -> Option<u64> {
    let lower = msg.to_ascii_lowercase();
    let after = lower.split("retry after").nth(1)?.trim();
    let num: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    num.parse().ok()
}

/// Parse RFC 7231 IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`) and return
/// `date - now`. Returns `None` if the date is past, malformed, or in any
/// other format (asctime / rfc850). Minimal parser — no `chrono` dep.
fn parse_http_date_delta(s: &str) -> Option<Duration> {
    if s.len() < 29 || !s.ends_with(" GMT") {
        return None;
    }
    // parts[0] = weekday ("Sun,"), [1] = day, [2] = mon, [3] = year,
    // [4] = "HH:MM:SS", [5] = "GMT".
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() != 6 {
        return None;
    }
    let day: u32 = parts[1].parse().ok()?;
    let month = month_from_abbrev(parts[2])?;
    let year: i32 = parts[3].parse().ok()?;
    let time_parts: Vec<&str> = parts[4].split(':').collect();
    if time_parts.len() != 3 {
        return None;
    }
    let hour: u32 = time_parts[0].parse().ok()?;
    let minute: u32 = time_parts[1].parse().ok()?;
    let second: u32 = time_parts[2].parse().ok()?;

    let target_unix = civil_to_unix_seconds(year, month, day, hour, minute, second)?;
    let now_unix = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;

    let delta = target_unix - now_unix;
    if delta <= 0 {
        None
    } else {
        Some(Duration::from_secs(delta as u64))
    }
}

fn month_from_abbrev(m: &str) -> Option<u32> {
    match m {
        "Jan" => Some(1),
        "Feb" => Some(2),
        "Mar" => Some(3),
        "Apr" => Some(4),
        "May" => Some(5),
        "Jun" => Some(6),
        "Jul" => Some(7),
        "Aug" => Some(8),
        "Sep" => Some(9),
        "Oct" => Some(10),
        "Nov" => Some(11),
        "Dec" => Some(12),
        _ => None,
    }
}

/// Convert civil (Gregorian) date to Unix seconds. Howard Hinnant's
/// `days_from_civil` algorithm — validated for year range [1970, 2400].
/// Returns `None` on out-of-range inputs.
fn civil_to_unix_seconds(
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
) -> Option<i64> {
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour >= 24
        || minute >= 60
        || second >= 60
    {
        return None;
    }
    // Shift so year starts in March (treats Jan/Feb as months 13/14 of
    // the previous year).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32; // [0, 399]
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    let days_since_epoch = era as i64 * 146097 + doe as i64 - 719_468;

    Some(days_since_epoch * 86_400 + hour as i64 * 3600 + minute as i64 * 60 + second as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    #[test]
    fn header_seconds_parses() {
        let mut h = HeaderMap::new();
        h.insert("retry-after", HeaderValue::from_static("7"));
        assert_eq!(parse_retry_after(&h, ""), Some(Duration::from_secs(7)));
    }

    #[test]
    fn body_retry_after_us_wins_over_header() {
        let mut h = HeaderMap::new();
        h.insert("retry-after", HeaderValue::from_static("10"));
        let body = r#"{"retry_after_us":2500000}"#;
        assert_eq!(
            parse_retry_after(&h, body),
            Some(Duration::from_micros(2_500_000))
        );
    }

    #[test]
    fn body_english_fallback() {
        let h = HeaderMap::new();
        let body = r#"{"error":"rate limited — retry after 3s"}"#;
        assert_eq!(parse_retry_after(&h, body), Some(Duration::from_secs(3)));
    }

    #[test]
    fn no_hint_returns_none() {
        let h = HeaderMap::new();
        assert_eq!(parse_retry_after(&h, ""), None);
    }

    #[test]
    fn equal_jitter_attempt_1_is_in_band() {
        let d = equal_jitter_backoff(1);
        assert!(d >= Duration::from_millis(500));
        assert!(d < Duration::from_millis(1_000));
    }

    #[test]
    fn equal_jitter_caps_at_30s() {
        assert!(equal_jitter_backoff(30) <= Duration::from_secs(30));
    }

    #[test]
    fn http_date_malformed_returns_none() {
        assert_eq!(parse_http_date_delta("not a date"), None);
        assert_eq!(parse_http_date_delta(""), None);
    }
}
