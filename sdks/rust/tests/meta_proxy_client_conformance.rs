#![cfg(feature = "meta-proxy")]

//! ADR-0025a's "Executable acceptance test" names
//! `cargo test --features meta-proxy meta_proxy_client_conformance` as the
//! Rust command that gates §D11 stable promotion (compliance items 1-12:
//! zero-I/O construction, ambient-proxy poisoning resistance, capability
//! isolation, unsupported-method rejection, the full plane/policy/consent
//! matrix, `critical` fail-closed routing, header allow/reject-before-send,
//! stream fragmentation, sponsor-streaming rejection, distinct error
//! classes, canary redaction, and version/capability evidence).
//!
//! None of that suite exists yet -- it is a real, not-yet-started D11
//! stable-gate deliverable, not something this pass's smaller feature
//! slices (§D1-D10, see the ADR's "Updated" line) attempt to satisfy.
//! Until now, though, the documented command matched ZERO tests (issue
//! #94): `cargo test <filter>` exits 0 on an empty match, so the
//! "acceptance test" silently passed without ever exercising anything --
//! a false-green trap for anyone who ran it expecting a real gate.
//!
//! This is an intentionally minimal placeholder, not the real conformance
//! suite: one real (not `assert!(true)`) check that a `MetaProxyClient`
//! constructs over the documented loopback origin with zero I/O (ADR-0025a
//! §D3 / compliance item 1) -- exercising the ONE thing already fully
//! implemented and covered elsewhere (`meta_proxy_client.rs`), so the
//! acceptance command has at least one real, passing, non-vacuous test
//! under this exact name until the full suite lands with the rest of the
//! D11 stable-gate work.

use cognitum_one::meta_proxy::{MetaProxyClient, MetaProxyClientConfig};

#[test]
fn meta_proxy_client_conformance() {
    // Compliance item 1 ("construction performs zero I/O"): building a
    // client over the default documented loopback origin must succeed
    // synchronously (no network call in `new`) and echo that origin back.
    let client = MetaProxyClient::new(MetaProxyClientConfig::new())
        .expect("construction over the default loopback origin performs zero I/O and never fails");
    assert!(
        client.config().origin.contains("127.0.0.1") || client.config().origin.contains("localhost"),
        "expected the documented default loopback origin, got {:?}",
        client.config().origin
    );
}
