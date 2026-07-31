//! `Retry-After` parsing (RFC 9110 §10.2.3).
//!
//! The header has TWO legal forms and a server may send either:
//!
//! ```text
//! Retry-After: 120                              (delta-seconds)
//! Retry-After: Wed, 21 Oct 2015 07:28:00 GMT    (HTTP-date)
//! ```
//!
//! All three SDKs previously handled only the first, each wrongly and each
//! differently: Node produced `NaN` (which makes a backoff fire immediately),
//! Python raised `ValueError` from `float()` and crashed *while mapping an
//! error*, and this SDK ignored the header entirely -- `map_http_error` never
//! saw it, so `retry_after_ms` was always `None` and the retry loop's
//! `unwrap_or(0)` meant the server's backoff request was silently discarded.
//! A rate-limited gateway therefore got hammered hardest by whichever SDK you
//! happened to be using. Found by the cross-language conformance corpus
//! (issue #75).
//!
//! Returns `None` for anything it cannot parse. An unusable hint means "fall
//! back to the local retry policy", never "retry now".

/// Upper bound on an honoured hint: 24h. Beyond this a caller is better served
/// by failing than by sleeping.
pub const MAX_RETRY_AFTER_MS: u64 = 24 * 60 * 60 * 1000;

/// Parse a `Retry-After` header into milliseconds, or `None`.
///
/// `now_ms` is injectable so the HTTP-date branch is testable without a wall
/// clock (ADR-0030a §D5 requires deterministic conformance runs).
pub fn parse_retry_after_ms(value: Option<&str>, now_ms: i64) -> Option<u64> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }

    // RFC 9110 defines delta-seconds as 1*DIGIT, so a signed, fractional or
    // exponent form is not a delta-seconds and must not be coerced into one.
    if trimmed.bytes().all(|b| b.is_ascii_digit()) {
        let seconds: u64 = trimmed.parse().ok()?;
        return Some(clamp(seconds.saturating_mul(1000)));
    }

    let target_ms = parse_imf_fixdate_ms(trimmed)?;
    // A date in the past means "you may retry now", which is 0, not negative.
    // Saturating: an absurd year must not overflow into a bogus delay.
    Some(clamp(target_ms.saturating_sub(now_ms).max(0) as u64))
}

fn clamp(ms: u64) -> u64 {
    ms.min(MAX_RETRY_AFTER_MS)
}

/// Strict IMF-fixdate (`Wed, 21 Oct 2015 07:28:00 GMT`) to epoch ms.
///
/// Hand-rolled rather than pulling in `chrono`/`httpdate`: this crate ships to
/// users, and one header format is not worth a dependency (and its supply
/// chain) on their build.
///
/// The grammar is spelled out identically in all three SDKs rather than
/// delegated to each platform's date parser, because those accept different
/// supersets: JavaScript's `Date.parse` takes `UTC` for `GMT`, lowercase month
/// names, and silently rolls `31 Feb` into March; Python's
/// `parsedate_to_datetime` rejects those but accepts trailing junk; and this
/// parser previously accepted a leap second and turned it into an extra
/// minute. Three parsers meant three answers to the same header -- the exact
/// failure the conformance corpus exists to prevent.
///
/// RFC 9110 §5.6.7 requires senders to use IMF-fixdate. The two obsolete
/// formats it permits recipients to accept are not implemented: a narrower
/// grammar the three agree on beats a wider one they disagree about.
fn parse_imf_fixdate_ms(value: &str) -> Option<i64> {
    // "Wed, 21 Oct 2015 07:28:00 GMT" -- fixed width, so length is a cheap
    // first gate and the day-name must be one of the seven.
    if value.len() != 29 {
        return None;
    }
    let (day_name, rest) = value.split_once(", ")?;
    if !matches!(day_name, "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun") {
        return None;
    }
    let mut parts = rest.split(' ');
    let day_str = parts.next()?;
    if day_str.len() != 2 || !day_str.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let day: i64 = day_str.parse().ok()?;
    let month = match parts.next()? {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let year_str = parts.next()?;
    if year_str.len() != 4 || !year_str.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let year: i64 = year_str.parse().ok()?;
    let time = parts.next()?;
    if parts.next()? != "GMT" || parts.next().is_some() {
        return None;
    }
    let mut hms = time.split(':');
    let hour: i64 = two_digits(hms.next()?)?;
    let minute: i64 = two_digits(hms.next()?)?;
    let second: i64 = two_digits(hms.next()?)?;
    // Reject rather than normalise. `31 Feb` is not a date, and a leap second
    // is not a value any gateway sends; letting either through means one SDK
    // silently rolls it forward while another refuses it.
    if hms.next().is_some() || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    if day < 1 || day > days_in_month(year, month) {
        return None;
    }

    Some((days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second) * 1000)
}

fn two_digits(value: &str) -> Option<i64> {
    if value.len() != 2 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since the Unix epoch, via Howard Hinnant's civil-date algorithm.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
