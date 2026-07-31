//! W3C Trace Context parse / generate / join logic and stable span-name
//! builders (ADR-0028 §D2).
//!
//! This module ADDS real logic on top of the [`TraceContext`] carrier type
//! frozen in `./telemetry.rs` during the §D1/§D3 pass (PR #115) -- it does
//! not redefine that type. Per §D2: "Remote HTTP clients propagate W3C
//! `traceparent` and `tracestate` when enabled and when allowed by the
//! product contract... Trace context is generated or joined by the SDK but
//! never used as an authorization, tenant, idempotency, or evidence
//! identity. Untrusted server or subprocess trace values are validated
//! before joining."
//!
//! Nothing in this module performs network I/O or wires into a product
//! client's HTTP request logic (`meta_llm`/`meta_proxy`/`metaharness`/
//! `harnessaas`) -- out of scope for this pass, mirroring how `sse::parser`
//! shipped as a protocol-agnostic core before any product wired it in.
//!
//! ## W3C Trace Context spec simplifications made in this pass
//!
//! - **Version**: only `traceparent` version `"00"` is accepted. The spec's
//!   own forward-compatibility rule (Trace Context, "Versioning of
//!   traceparent") allows a higher version to append trailing fields after
//!   `trace-flags`; this SDK has no use for any such field, so any
//!   non-`"00"` version (or a `traceparent` that does not split into
//!   exactly four `-`-separated fields) is simply treated as invalid input
//!   rather than parsed-and-ignored. Per §D2's "untrusted values must be
//!   validated before joining," [`join_or_generate_trace_context`] falls
//!   back to generating a fresh trace context in that case.
//! - **`tracestate`**: a "reasonably strict" validator, not the full spec.
//!   Enforced: non-empty, at most 32 members, each `key=value` pair with a
//!   key restricted to lowercase alphanumerics plus `-`/`*`/`_`/`/` (with at
//!   most one `@` tenant/vendor separator, each side non-empty) and a value
//!   restricted to printable ASCII (0x20-0x7E) excluding `,`/`=` and leading
//!   /trailing spaces. Not enforced: the spec's separate tenant-id
//!   (<=241 chars) / vendor-id (<=13 chars) length caps around `@` -- this
//!   pass uses one shared 256-char cap on each side instead.
//! - **Random source**: this module needs 128 bits (trace-id) and 64 bits
//!   (parent-id) of randomness per generated trace context. The existing
//!   `uuid` dependency (used elsewhere for request-ID correlation) is
//!   *optional*, gated behind the `meta-llm`/`harnessaas` Cargo features --
//!   but `agentic::trace_context` is unconditional base-module code like
//!   `agentic::telemetry`, so depending on it here would force those
//!   features on for every caller. Trace IDs are not security-sensitive
//!   (per the ADR-0028 §D2 text above, barred from ever serving as an
//!   authorization/tenant/idempotency/evidence identity), so a
//!   non-cryptographic source is an acceptable, spec-compliant choice.
//!   Rather than add a new dependency, [`random_hex_nonzero`] mixes
//!   `std::collections::hash_map::RandomState` (whose per-process seed is
//!   itself drawn from the OS by the standard library) with a monotonic
//!   atomic counter and the current time, through a fresh [`Hasher`] per
//!   call -- no new crate, and no risk of same-nanosecond collisions (the
//!   counter always advances).

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::agentic::telemetry::TraceContext;

/// The only `traceparent` version this implementation accepts. See the
/// module doc comment's "Version" simplification.
pub const TRACE_VERSION: &str = "00";

/// Default `trace-flags` value used when this SDK generates a new
/// trace-parent: bit 0 ("sampled") set. §D2 does not mandate a default;
/// "sampled" is the more useful default absent a sampler wired in.
pub const DEFAULT_TRACE_FLAGS: &str = "01";

/// Max `tracestate` list members this parser accepts (matches the W3C spec's
/// own cap).
pub const MAX_TRACESTATE_MEMBERS: usize = 32;

/// The validated components of a `traceparent` header, once parsed. Not
/// part of the public §D1 [`TraceContext`] shape (which only carries the
/// two opaque wire strings) -- this exists so [`join_or_generate_trace_context`]
/// can recover the incoming trace-id without re-parsing the formatted
/// string.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TraceParentComponents {
    trace_id: String,
    parent_id: String,
    #[allow(dead_code)] // Captured for completeness; nothing consumes flag bits this pass.
    trace_flags: String,
}

fn is_lowercase_hex(s: &str, expected_len: usize) -> bool {
    s.len() == expected_len && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_all_zero(s: &str) -> bool {
    s.bytes().all(|b| b == b'0')
}

/// Splits and validates a raw `traceparent` header into its components.
/// Returns `None` on ANY malformed input -- never panics.
fn parse_trace_parent_components(header: &str) -> Option<TraceParentComponents> {
    let mut parts = header.split('-');
    let version = parts.next()?;
    let trace_id = parts.next()?;
    let parent_id = parts.next()?;
    let trace_flags = parts.next()?;
    if parts.next().is_some() {
        return None; // wrong separator count: more than 4 fields
    }
    if version != TRACE_VERSION
        || !is_lowercase_hex(trace_id, 32)
        || is_all_zero(trace_id)
        || !is_lowercase_hex(parent_id, 16)
        || is_all_zero(parent_id)
        || !is_lowercase_hex(trace_flags, 2)
    {
        return None;
    }
    Some(TraceParentComponents {
        trace_id: trace_id.to_string(),
        parent_id: parent_id.to_string(),
        trace_flags: trace_flags.to_string(),
    })
}

/// Parses and validates a raw `traceparent` header value (W3C Trace Context:
/// `{version}-{trace-id}-{parent-id}-{trace-flags}`, e.g.
/// `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`). Returns `None`
/// on ANY malformed input (wrong version, wrong hex-char-count, all-zero
/// trace-id or parent-id, wrong separator count, non-hex characters) --
/// never panics, matching §D2's "untrusted server or subprocess trace
/// values are validated before joining."
pub fn parse_trace_parent(header: &str) -> Option<TraceContext> {
    parse_trace_parent_components(header).map(|_| TraceContext {
        trace_parent: Some(header.to_string()),
        trace_state: None,
    })
}

/// Draws `byte_len` bytes from the process-local, non-cryptographic random
/// source described in the module doc comment, retrying (astronomically
/// unlikely) all-zero draws so the caller always gets a nonzero result.
fn random_hex_nonzero(byte_len: usize) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    loop {
        let mut bytes = Vec::with_capacity(byte_len);
        while bytes.len() < byte_len {
            let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0);
            let mut hasher = RandomState::new().build_hasher();
            hasher.write_u64(counter);
            hasher.write_u64(nanos);
            bytes.extend_from_slice(&hasher.finish().to_be_bytes());
        }
        bytes.truncate(byte_len);
        if bytes.iter().any(|&b| b != 0) {
            return bytes.iter().map(|b| format!("{b:02x}")).collect();
        }
    }
}

/// Generates a fresh, valid `traceparent`: a random 32-hex-char trace-id and
/// 16-hex-char parent-id (both guaranteed nonzero), `trace-flags = "01"`
/// (sampled).
pub fn generate_trace_parent() -> TraceContext {
    let trace_id = random_hex_nonzero(16); // 16 bytes -> 32 hex chars
    let parent_id = random_hex_nonzero(8); // 8 bytes -> 16 hex chars
    TraceContext {
        trace_parent: Some(format!("{TRACE_VERSION}-{trace_id}-{parent_id}-{DEFAULT_TRACE_FLAGS}")),
        trace_state: None,
    }
}

/// One validated `tracestate` list member.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceStateMember {
    pub key: String,
    pub value: String,
}

fn is_valid_tracestate_key_charset(s: &str) -> bool {
    let first_ok = s
        .as_bytes()
        .first()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    !s.is_empty()
        && s.len() <= 256
        && first_ok
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'*' | b'_' | b'/'))
}

fn is_valid_tracestate_key(key: &str) -> bool {
    match key.split_once('@') {
        Some((tenant, vendor)) => {
            !tenant.is_empty()
                && !vendor.is_empty()
                && !vendor.contains('@')
                && is_valid_tracestate_key_charset(tenant)
                && is_valid_tracestate_key_charset(vendor)
        }
        None => is_valid_tracestate_key_charset(key),
    }
}

fn is_valid_tracestate_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.starts_with(' ')
        && !value.ends_with(' ')
        && value.bytes().all(|b| (0x20..=0x7e).contains(&b) && b != b',' && b != b'=')
}

/// Parses a raw `tracestate` header value into an ordered list of validated
/// `key=value` members (comma-separated, up to [`MAX_TRACESTATE_MEMBERS`]).
/// Returns `None` on ANY malformed input (empty, too many members, malformed
/// key/value characters) -- never panics. See the module doc comment for
/// exactly which spec details this validator simplifies.
pub fn parse_trace_state(header: &str) -> Option<Vec<TraceStateMember>> {
    if header.trim().is_empty() {
        return None;
    }
    let mut members = Vec::new();
    for raw_member in header.split(',') {
        let member = raw_member.trim_matches(|c| c == ' ' || c == '\t');
        if member.is_empty() {
            return None;
        }
        let (key, value) = member.split_once('=')?;
        if !is_valid_tracestate_key(key) || !is_valid_tracestate_value(value) {
            return None;
        }
        members.push(TraceStateMember {
            key: key.to_string(),
            value: value.to_string(),
        });
    }
    if members.is_empty() || members.len() > MAX_TRACESTATE_MEMBERS {
        return None;
    }
    Some(members)
}

/// Formats a list of `tracestate` members back into the wire string.
pub fn format_trace_state(members: &[TraceStateMember]) -> String {
    members
        .iter()
        .map(|m| format!("{}={}", m.key, m.value))
        .collect::<Vec<_>>()
        .join(",")
}

/// Joins an incoming, untrusted `traceparent`/`tracestate` pair if valid, or
/// generates a fresh trace context otherwise. Per §D2: a receiving service
/// keeps the incoming trace-id but generates its own new parent-id/span-id
/// (this SDK is a new span in the same trace); `trace-flags` is reset to
/// [`DEFAULT_TRACE_FLAGS`] since this pass does not interpret or propagate
/// the incoming sampling bit. An invalid incoming `traceparent` NEVER
/// panics and NEVER gets joined -- it falls back to generation, matching
/// "untrusted server or subprocess trace values are validated before
/// joining." An invalid incoming `tracestate` is silently dropped (treated
/// as absent) rather than invalidating the whole join.
pub fn join_or_generate_trace_context(
    incoming_traceparent: Option<&str>,
    incoming_tracestate: Option<&str>,
) -> TraceContext {
    let trace_state = incoming_tracestate
        .and_then(parse_trace_state)
        .map(|members| format_trace_state(&members));

    let mut context = match incoming_traceparent.and_then(parse_trace_parent_components) {
        Some(components) => {
            let new_parent_id = random_hex_nonzero(8);
            TraceContext {
                trace_parent: Some(format!(
                    "{TRACE_VERSION}-{}-{new_parent_id}-{DEFAULT_TRACE_FLAGS}",
                    components.trace_id
                )),
                trace_state: None,
            }
        }
        None => generate_trace_parent(),
    };
    context.trace_state = trace_state;
    context
}

// ---------------------------------------------------------------------
// §D2: Stable span names, `cognitum.<product>.<operation>` format.
// ---------------------------------------------------------------------

/// Builds the stable span name `cognitum.meta_llm.<operation>`.
pub fn meta_llm_span_name(operation: &str) -> String {
    format!("cognitum.meta_llm.{operation}")
}

/// Builds the stable span name `cognitum.meta_proxy.<operation>`.
pub fn meta_proxy_span_name(operation: &str) -> String {
    format!("cognitum.meta_proxy.{operation}")
}

/// Builds the stable span name `cognitum.metaharness.<operation>`.
pub fn metaharness_span_name(operation: &str) -> String {
    format!("cognitum.metaharness.{operation}")
}

/// Builds the stable span name `cognitum.harnessaas.<operation>`.
pub fn harnessaas_span_name(operation: &str) -> String {
    format!("cognitum.harnessaas.{operation}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_TRACEPARENT: &str = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    #[test]
    fn parses_the_spec_example_traceparent() {
        let ctx = parse_trace_parent(VALID_TRACEPARENT).expect("valid traceparent");
        assert_eq!(ctx.trace_parent.as_deref(), Some(VALID_TRACEPARENT));
        assert_eq!(ctx.trace_state, None);
    }

    #[test]
    fn rejects_wrong_version() {
        assert!(parse_trace_parent("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01").is_none());
        assert!(parse_trace_parent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01").is_none());
    }

    #[test]
    fn rejects_wrong_trace_id_length() {
        assert!(parse_trace_parent("00-4bf92f3577b34da6a3ce929d0e0e47-00f067aa0ba902b7-01").is_none());
        assert!(parse_trace_parent("00-4bf92f3577b34da6a3ce929d0e0e473600-00f067aa0ba902b7-01").is_none());
    }

    #[test]
    fn rejects_all_zero_trace_id() {
        assert!(
            parse_trace_parent("00-00000000000000000000000000000000-00f067aa0ba902b7-01").is_none()
        );
    }

    #[test]
    fn rejects_all_zero_parent_id() {
        assert!(
            parse_trace_parent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01").is_none()
        );
    }

    #[test]
    fn rejects_wrong_parent_id_length() {
        assert!(parse_trace_parent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902-01").is_none());
        assert!(
            parse_trace_parent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7ff-01").is_none()
        );
    }

    #[test]
    fn rejects_wrong_separator_count() {
        assert!(parse_trace_parent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7").is_none());
        assert!(
            parse_trace_parent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra").is_none()
        );
        assert!(parse_trace_parent("not-a-traceparent-at-all-really").is_none());
    }

    #[test]
    fn rejects_non_hex_characters() {
        assert!(
            parse_trace_parent("00-ZZf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01").is_none()
        );
        assert!(
            parse_trace_parent("00-4Bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01").is_none() // uppercase hex rejected
        );
        assert!(
            parse_trace_parent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-ZZ").is_none()
        );
    }

    #[test]
    fn rejects_wrong_length_trace_flags() {
        assert!(
            parse_trace_parent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-0").is_none()
        );
        assert!(
            parse_trace_parent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-011").is_none()
        );
    }

    #[test]
    fn join_fallback_never_throws_on_a_variety_of_malformed_inputs() {
        for bad in [
            "garbage-not-a-traceparent",
            "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
            "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            "",
        ] {
            let joined = join_or_generate_trace_context(Some(bad), None);
            let raw = joined.trace_parent.expect("always generates a trace_parent");
            assert!(parse_trace_parent(&raw).is_some(), "fallback for {bad:?} must be valid");
        }
    }

    #[test]
    fn parse_never_panics_on_empty_or_garbage_input() {
        assert!(parse_trace_parent("").is_none());
        assert!(parse_trace_parent("-").is_none());
        assert!(parse_trace_parent("----").is_none());
        assert!(parse_trace_parent("\u{0}\u{0}\u{0}").is_none());
    }

    #[test]
    fn generate_produces_a_valid_reparseable_traceparent() {
        let ctx = generate_trace_parent();
        let raw = ctx.trace_parent.expect("generated trace_parent");
        let reparsed = parse_trace_parent(&raw).expect("round-trips through parse");
        assert_eq!(reparsed.trace_parent.as_deref(), Some(raw.as_str()));
        assert!(raw.ends_with(&format!("-{DEFAULT_TRACE_FLAGS}")));
    }

    #[test]
    fn generate_produces_distinct_values_across_calls() {
        let a = generate_trace_parent().trace_parent.unwrap();
        let b = generate_trace_parent().trace_parent.unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn tracestate_round_trips() {
        let members = parse_trace_state("congo=t61rcWkgMzE,rojo=00f067aa0ba902b7").expect("valid");
        assert_eq!(members.len(), 2);
        assert_eq!(members[0].key, "congo");
        assert_eq!(members[0].value, "t61rcWkgMzE");
        let formatted = format_trace_state(&members);
        assert_eq!(formatted, "congo=t61rcWkgMzE,rojo=00f067aa0ba902b7");
        let reparsed = parse_trace_state(&formatted).expect("re-parses");
        assert_eq!(reparsed, members);
    }

    #[test]
    fn tracestate_accepts_vendor_tenant_key() {
        let members = parse_trace_state("tenant-1@vendor=value1").expect("valid vendor-tenant key");
        assert_eq!(members[0].key, "tenant-1@vendor");
    }

    #[test]
    fn tracestate_rejects_empty_header() {
        assert!(parse_trace_state("").is_none());
        assert!(parse_trace_state("   ").is_none());
    }

    #[test]
    fn tracestate_rejects_too_many_members() {
        let header = (0..33)
            .map(|i| format!("k{i}=v"))
            .collect::<Vec<_>>()
            .join(",");
        assert!(parse_trace_state(&header).is_none());
    }

    #[test]
    fn tracestate_accepts_exactly_32_members() {
        let header = (0..32)
            .map(|i| format!("k{i}=v"))
            .collect::<Vec<_>>()
            .join(",");
        assert!(parse_trace_state(&header).is_some());
    }

    #[test]
    fn tracestate_rejects_malformed_key_and_value() {
        assert!(parse_trace_state("Congo=value").is_none()); // uppercase key
        assert!(parse_trace_state("congo=").is_none()); // empty value
        assert!(parse_trace_state("=value").is_none()); // empty key
        assert!(parse_trace_state("congo=va,lue").is_none()); // comma inside value handled as two malformed members
        assert!(parse_trace_state("congo=va=lue").is_none()); // extra '=' -> value contains '='
        assert!(parse_trace_state("con go=value").is_none()); // space in key
        assert!(parse_trace_state("congo= value").is_none()); // leading space in value
        assert!(parse_trace_state("a@b@c=value").is_none()); // more than one '@'
        // W3C tracestate OWS is space/HTAB only (RFC 7230 OWS) -- a
        // form-feed is not OWS and must not be silently trimmed away, so
        // it fails the key's charset check. Cross-language parity: Node/
        // Python must reject this identically (both previously used
        // `.trim()`/`.strip()`, which strip arbitrary Unicode whitespace).
        assert!(parse_trace_state("\u{c}congo=value").is_none());
    }

    #[test]
    fn join_with_valid_incoming_header_reuses_trace_id_new_parent_id() {
        let joined = join_or_generate_trace_context(Some(VALID_TRACEPARENT), None);
        let raw = joined.trace_parent.expect("joined trace_parent");
        assert!(raw.starts_with("00-4bf92f3577b34da6a3ce929d0e0e4736-"));
        assert!(!raw.contains("00f067aa0ba902b7")); // parent-id must NOT be reused
        let components = parse_trace_parent_components(&raw).expect("joined value is itself valid");
        assert_eq!(components.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
        assert_ne!(components.parent_id, "00f067aa0ba902b7");
    }

    #[test]
    fn join_with_invalid_incoming_header_falls_back_to_generation_without_panicking() {
        let joined = join_or_generate_trace_context(Some("garbage-not-a-traceparent"), None);
        let raw = joined.trace_parent.expect("falls back to a generated value");
        assert!(parse_trace_parent(&raw).is_some());
    }

    #[test]
    fn join_with_no_incoming_header_generates() {
        let joined = join_or_generate_trace_context(None, None);
        assert!(joined.trace_parent.is_some());
    }

    #[test]
    fn join_carries_valid_incoming_tracestate_and_drops_invalid_one() {
        let joined = join_or_generate_trace_context(Some(VALID_TRACEPARENT), Some("congo=t61rcWkgMzE"));
        assert_eq!(joined.trace_state.as_deref(), Some("congo=t61rcWkgMzE"));

        let joined_invalid =
            join_or_generate_trace_context(Some(VALID_TRACEPARENT), Some("Not Valid"));
        assert_eq!(joined_invalid.trace_state, None);
    }

    #[test]
    fn span_name_builders_match_adr_0028_format_exactly() {
        assert_eq!(meta_llm_span_name("chat.completions.create"), "cognitum.meta_llm.chat.completions.create");
        assert_eq!(meta_proxy_span_name("route"), "cognitum.meta_proxy.route");
        assert_eq!(metaharness_span_name("score"), "cognitum.metaharness.score");
        assert_eq!(harnessaas_span_name("solve"), "cognitum.harnessaas.solve");
    }
}
