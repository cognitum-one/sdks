//! Consent gating for `MetaProxyClient` data-plane calls (ADR-0025a §D9).
//!
//! §D9: "Separate ADR-0022 grants cover Cognitum cloud routing, sponsor,
//! power saver, direct Anthropic, and training contribution. Credential
//! presence is not consent. Headless clients return `ConsentRequiredError`
//! rather than prompt."
//!
//! This module is intentionally narrow. Stable sponsor support is BLOCKED
//! on ADR-0025b's lifecycle/state fixes (§D9: "interprocess locking, atomic
//! replace, fail-closed corruption, schema and pricing version, server
//! reconciliation, and crash/concurrency/date/clock tests") and is NOT
//! implemented here. The one gate this pass DOES implement is the
//! tractable slice: routing to the `cognitum_cloud` plane requires a
//! matching, unexpired `CloudFallback` consent grant (ADR-0022 §D7's kind
//! for "routing from local to Cognitum cloud") — checked BEFORE any HTTP
//! I/O, never inferred from credential presence.
//!
//! [`RoutingIntent::consent_grants`](super::routing::RoutingIntent) is a
//! distinct, unrelated concept: it is the opaque set of ADR-0022 grant IDs
//! the SDK *forwards as intent* to the Proxy (PR #93) — the SDK does not
//! interpret its structure. This module instead checks the caller's
//! *locally held* [`ConsentGrant`] values
//! ([`MetaProxyClientConfig::consent_grants`](super::config::MetaProxyClientConfig))
//! against the plane the call's [`RoutingIntent`](super::routing::RoutingIntent)
//! would allow/require.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::agentic::{ConsentGrant, ConsentGrantKind, ConsentRequiredError};
use crate::retry_hint::civil_to_unix_seconds;

use super::routing::RoutingIntent;
use super::status::RoutingPlane;
use super::PRODUCT;

/// Parse a UTC `Z`-suffixed RFC3339 timestamp into Unix seconds. Deliberately
/// scoped to the same minimal subset `crate::agentic::receipt_verification`
/// uses ("no numeric zone offsets") to avoid pulling in a `chrono`
/// dependency for this pass — see that module's doc comment for the
/// precedent. An unparsable or non-`Z` timestamp returns `None`, which
/// callers here treat as "already expired" (fail closed on a malformed
/// grant rather than silently accepting it).
fn parse_rfc3339_unix_seconds(s: &str) -> Option<i64> {
    if s.len() < 20 || !(s.ends_with('Z') || s.ends_with('z')) {
        return None;
    }
    let year: i32 = s.get(0..4)?.parse().ok()?;
    if s.as_bytes().get(4).copied() != Some(b'-') {
        return None;
    }
    let month: u32 = s.get(5..7)?.parse().ok()?;
    if s.as_bytes().get(7).copied() != Some(b'-') {
        return None;
    }
    let day: u32 = s.get(8..10)?.parse().ok()?;
    match s.as_bytes().get(10).copied() {
        Some(b'T') | Some(b't') | Some(b' ') => {}
        _ => return None,
    }
    let hour: u32 = s.get(11..13)?.parse().ok()?;
    if s.as_bytes().get(13).copied() != Some(b':') {
        return None;
    }
    let minute: u32 = s.get(14..16)?.parse().ok()?;
    if s.as_bytes().get(16).copied() != Some(b':') {
        return None;
    }
    let second: u32 = s.get(17..19)?.parse().ok()?;
    civil_to_unix_seconds(year, month, day, hour, minute, second)
}

fn now_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// ADR-0022 §D7's consent-grant kind that covers Cognitum-cloud routing.
/// The ADR's kind list has no `cognitum_cloud_routing` entry;
/// `CloudFallback` ("routing from local to Cognitum cloud") is the matching
/// kind — it is a low-stakes kind (an unsigned local record is sufficient
/// per §D7), unlike `SponsoredInference`.
pub const CLOUD_ROUTING_CONSENT_KIND: ConsentGrantKind = ConsentGrantKind::CloudFallback;

/// `true` when `intent` would allow or require routing through `plane`.
pub fn intent_touches_plane(intent: &RoutingIntent, plane: RoutingPlane) -> bool {
    intent.required_plane == Some(plane) || intent.allowed_planes.contains(&plane)
}

/// `true` when `grant` is unexpired at `now_unix_secs` and matches
/// `kind`/`product`/`origin`. Pure, no I/O — does not verify signatures or
/// re-attest server-persisted grants (§D7's consequential-kind re-check
/// remains a follow-up).
pub fn is_consent_grant_valid(
    grant: &ConsentGrant,
    kind: ConsentGrantKind,
    product: &str,
    origin: &str,
    now_unix_secs: i64,
) -> bool {
    if grant.kind != kind {
        return false;
    }
    if grant.product != product {
        return false;
    }
    if grant.origin != origin {
        return false;
    }
    if let Some(expires_at) = grant.expires_at.as_deref() {
        match parse_rfc3339_unix_seconds(expires_at) {
            Some(expires) => {
                if expires <= now_unix_secs {
                    return false;
                }
            }
            // An unparsable expiry is treated as already-expired — fail
            // closed rather than silently accepting a malformed grant.
            None => return false,
        }
    }
    true
}

/// `true` when `grants` contains at least one grant satisfying
/// [`is_consent_grant_valid`].
pub fn has_valid_consent_grant(
    grants: &[ConsentGrant],
    kind: ConsentGrantKind,
    product: &str,
    origin: &str,
    now_unix_secs: i64,
) -> bool {
    grants
        .iter()
        .any(|grant| is_consent_grant_valid(grant, kind, product, origin, now_unix_secs))
}

/// Fail-closed gate applied BEFORE any HTTP I/O (ADR-0025a §D9). When
/// `intent` allows or requires the `cognitum_cloud` plane and `grants`
/// contains no matching, unexpired [`CLOUD_ROUTING_CONSENT_KIND`] grant for
/// `product`/`origin`, returns `Err(ConsentRequiredError)` — a valid local
/// bearer credential does NOT satisfy this check ("Credential presence is
/// not consent").
///
/// A no-op (`Ok(())`) when `intent` is `None` or does not touch
/// `cognitum_cloud`.
#[allow(clippy::result_large_err)]
pub fn assert_consent_for_routing_intent(
    intent: Option<&RoutingIntent>,
    grants: &[ConsentGrant],
    origin: &str,
    operation: &str,
) -> Result<(), ConsentRequiredError> {
    let Some(intent) = intent else {
        return Ok(());
    };
    if !intent_touches_plane(intent, RoutingPlane::CognitumCloud) {
        return Ok(());
    }
    if has_valid_consent_grant(
        grants,
        CLOUD_ROUTING_CONSENT_KIND,
        PRODUCT,
        origin,
        now_unix_seconds(),
    ) {
        return Ok(());
    }

    Err(ConsentRequiredError::new(
        PRODUCT,
        operation,
        CLOUD_ROUTING_CONSENT_KIND,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meta_proxy::status::WorkloadPolicy;

    const ORIGIN: &str = "http://127.0.0.1:11435";

    /// A fixed "now" used across expiry tests (2026-01-01T00:00:00Z), so
    /// tests don't depend on wall-clock time.
    fn fixed_now() -> i64 {
        parse_rfc3339_unix_seconds("2026-01-01T00:00:00Z").expect("valid fixture timestamp")
    }

    fn iso_offset(base: i64, delta_secs: i64) -> String {
        // Minimal ISO rendering sufficient for round-tripping through
        // `parse_rfc3339_unix_seconds` in these tests — not a general
        // formatter (mirrors the module's "no chrono" scope limit).
        let total = base + delta_secs;
        let days = total.div_euclid(86_400);
        let secs_of_day = total.rem_euclid(86_400);
        let (y, m, d) = days_to_civil(days);
        let hour = secs_of_day / 3600;
        let minute = (secs_of_day % 3600) / 60;
        let second = secs_of_day % 60;
        format!("{y:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}Z")
    }

    /// Inverse of the civil-to-days calculation `civil_to_unix_seconds` uses
    /// internally (Howard Hinnant's `civil_from_days`), needed only so this
    /// test module can render a synthetic ISO timestamp without chrono.
    fn days_to_civil(days_since_epoch: i64) -> (i32, u32, u32) {
        let z = days_since_epoch + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = doy - (153 * mp + 2) / 5 + 1;
        let month = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = if month <= 2 { y + 1 } else { y };
        (year as i32, month as u32, day as u32)
    }

    fn cloud_intent() -> RoutingIntent {
        RoutingIntent {
            required_plane: None,
            allowed_planes: vec![RoutingPlane::CognitumCloud],
            workload_policy: WorkloadPolicy::Standard,
            max_utilization: None,
            consent_grants: Vec::new(),
            training_share: false,
            fail_if_unavailable: false,
        }
    }

    fn grant() -> ConsentGrant {
        ConsentGrant {
            kind: ConsentGrantKind::CloudFallback,
            product: PRODUCT.to_owned(),
            origin: ORIGIN.to_owned(),
            subject: "test-subject".to_owned(),
            scope: "chat_completions".to_owned(),
            issued_at: iso_offset(fixed_now(), -60),
            expires_at: None,
            evidence_id: None,
        }
    }

    #[test]
    fn no_op_when_intent_is_none() {
        assert!(assert_consent_for_routing_intent(None, &[], ORIGIN, "chat_completions").is_ok());
    }

    #[test]
    fn no_op_when_intent_never_touches_cognitum_cloud() {
        let mut intent = cloud_intent();
        intent.allowed_planes = vec![RoutingPlane::Local];
        intent.required_plane = Some(RoutingPlane::Local);
        assert!(
            assert_consent_for_routing_intent(Some(&intent), &[], ORIGIN, "chat_completions")
                .is_ok()
        );
    }

    #[test]
    fn errs_when_allowed_planes_includes_cognitum_cloud_and_no_grant() {
        let intent = cloud_intent();
        let err =
            assert_consent_for_routing_intent(Some(&intent), &[], ORIGIN, "chat_completions")
                .unwrap_err();
        assert_eq!(err.required_kind, CLOUD_ROUTING_CONSENT_KIND);
    }

    #[test]
    fn errs_when_required_plane_is_cognitum_cloud_and_no_grant() {
        let mut intent = cloud_intent();
        intent.required_plane = Some(RoutingPlane::CognitumCloud);
        intent.allowed_planes = Vec::new();
        assert!(
            assert_consent_for_routing_intent(Some(&intent), &[], ORIGIN, "chat_completions")
                .is_err()
        );
    }

    #[test]
    fn succeeds_with_a_matching_unexpired_grant() {
        let intent = cloud_intent();
        let grants = vec![grant()];
        assert!(assert_consent_for_routing_intent(
            Some(&intent),
            &grants,
            ORIGIN,
            "chat_completions"
        )
        .is_ok());
    }

    #[test]
    fn still_errs_for_a_different_origin_grant() {
        let intent = cloud_intent();
        let mut g = grant();
        g.origin = "http://127.0.0.1:9999".to_owned();
        assert!(
            assert_consent_for_routing_intent(Some(&intent), &[g], ORIGIN, "chat_completions")
                .is_err()
        );
    }

    #[test]
    fn still_errs_for_a_different_kind_grant() {
        let intent = cloud_intent();
        let mut g = grant();
        g.kind = ConsentGrantKind::SponsoredInference;
        assert!(
            assert_consent_for_routing_intent(Some(&intent), &[g], ORIGIN, "chat_completions")
                .is_err()
        );
    }

    #[test]
    fn still_errs_for_an_expired_grant() {
        // `assert_consent_for_routing_intent` checks against REAL wall-clock
        // time internally, so the expiry fixture is anchored to
        // `now_unix_seconds()` rather than the fixed `fixed_now()` used by
        // the pure `is_consent_grant_valid` tests below.
        let intent = cloud_intent();
        let mut g = grant();
        g.expires_at = Some(iso_offset(now_unix_seconds(), -60));
        assert!(
            assert_consent_for_routing_intent(Some(&intent), &[g], ORIGIN, "chat_completions")
                .is_err()
        );
    }

    #[test]
    fn succeeds_for_a_grant_with_a_future_expiry() {
        let intent = cloud_intent();
        let mut g = grant();
        g.expires_at = Some(iso_offset(now_unix_seconds(), 3600));
        assert!(assert_consent_for_routing_intent(
            Some(&intent),
            &[g],
            ORIGIN,
            "chat_completions"
        )
        .is_ok());
    }

    #[test]
    fn is_consent_grant_valid_rejects_mismatches_and_expiry() {
        let now = fixed_now();
        let mut g = grant();
        g.expires_at = Some(iso_offset(now, 86_400)); // expires one day after `now`
        assert!(is_consent_grant_valid(&g, ConsentGrantKind::CloudFallback, PRODUCT, ORIGIN, now));
        assert!(!is_consent_grant_valid(
            &g,
            ConsentGrantKind::SponsoredInference,
            PRODUCT,
            ORIGIN,
            now
        ));
        assert!(!is_consent_grant_valid(
            &g,
            ConsentGrantKind::CloudFallback,
            "other-product",
            ORIGIN,
            now
        ));
        assert!(!is_consent_grant_valid(
            &g,
            ConsentGrantKind::CloudFallback,
            PRODUCT,
            "http://127.0.0.1:1",
            now
        ));
        let later = now + 2 * 86_400;
        assert!(!is_consent_grant_valid(
            &g,
            ConsentGrantKind::CloudFallback,
            PRODUCT,
            ORIGIN,
            later
        ));
    }

    #[test]
    fn has_valid_consent_grant_finds_a_match_among_several() {
        let now = fixed_now();
        let mut sponsored = grant();
        sponsored.kind = ConsentGrantKind::SponsoredInference;
        let mut wrong_origin = grant();
        wrong_origin.origin = "http://127.0.0.1:1".to_owned();
        let grants = vec![sponsored, wrong_origin, grant()];
        assert!(has_valid_consent_grant(
            &grants,
            ConsentGrantKind::CloudFallback,
            PRODUCT,
            ORIGIN,
            now
        ));
        assert!(!has_valid_consent_grant(
            &grants[..2],
            ConsentGrantKind::CloudFallback,
            PRODUCT,
            ORIGIN,
            now
        ));
    }
}
