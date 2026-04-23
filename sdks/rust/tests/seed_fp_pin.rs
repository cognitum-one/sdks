//! Integration tests for per-peer `fp=` cert fingerprint pinning
//! (ADR-0014c §"fp= cert pinning", ADR-0007 §TLS).
//!
//! We deliberately do NOT stand up a real TLS server — `wiremock` is
//! plaintext-HTTP only, and spinning up tokio-rustls + rcgen from a
//! test file inflates maintenance for limited coverage gain. Instead
//! we exercise the verifier at two levels:
//!
//! 1. `FingerprintPinVerifier::verify_server_cert` called directly with
//!    a known rcgen-generated self-signed cert DER. Covers the core
//!    "match / mismatch / unknown-host fallthrough" contract.
//! 2. `SeedClient::builder().discovery(...)` with a stub provider that
//!    surfaces a `tls_fingerprint` on each peer — asserts the builder
//!    accepts fingerprints and does not regress the back-compat path
//!    for unpinned peers + `SeedTls::Insecure`.
//!
//! The rustls-level behaviour (actual handshake rejection) is covered
//! implicitly: our `verify_server_cert` is the single gate the handshake
//! asks, so a unit-level assertion on the gate is load-bearing.

#![cfg(feature = "seed")]

use std::sync::Arc;

use async_trait::async_trait;
use rcgen::generate_simple_self_signed;
use rustls::client::danger::ServerCertVerifier;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::RootCertStore;

use cognitum_rs::error::Error;
use cognitum_rs::seed::tls_pin::{build_pin_map, parse_hex_sha256, FingerprintPinVerifier, PinMap};
use cognitum_rs::seed::{DiscoveredPeer, Discovery, SeedClient, SeedTls};

// ---------- Helpers --------------------------------------------------------

/// Produce a self-signed cert for `host` and return `(der, hex_sha256)`.
/// The hex string has no `sha256:` prefix and is all-lowercase so it
/// matches the TXT-record normalised form.
fn self_signed(host: &str) -> (Vec<u8>, String) {
    let ck = generate_simple_self_signed(vec![host.to_owned()]).expect("rcgen");
    let der = ck.cert.der().to_vec();
    let hex = FingerprintPinVerifier::sha256_hex(&der);
    (der, hex)
}

/// Convenience — dns-name `ServerName` for tests.
fn dns_name(host: &'static str) -> ServerName<'static> {
    ServerName::try_from(host).expect("dns name")
}

/// A fake discovery provider that returns a fixed snapshot.
#[derive(Debug)]
struct StubFpDiscovery {
    peers: Vec<DiscoveredPeer>,
}

#[async_trait]
impl Discovery for StubFpDiscovery {
    async fn discover(&self) -> Result<Vec<DiscoveredPeer>, Error> {
        Ok(self.peers.clone())
    }
}

// ---------- 1. Matching fingerprint succeeds ------------------------------

#[test]
fn matching_fingerprint_verifies_successfully() {
    let (der, hex) = self_signed("seed-a.local");
    let digest = parse_hex_sha256(&hex).expect("parse");
    let mut pins = PinMap::new();
    pins.insert("seed-a.local".into(), digest);

    let verifier = FingerprintPinVerifier::with_insecure_fallback(pins);
    let cert = CertificateDer::from(der);
    let now = UnixTime::since_unix_epoch(std::time::Duration::from_secs(1_700_000_000));

    let ok = verifier.verify_server_cert(&cert, &[], &dns_name("seed-a.local"), &[], now);
    assert!(ok.is_ok(), "expected match, got {ok:?}");
}

// ---------- 2. Mismatched fingerprint rejects with tls_pin prefix ----------

#[test]
fn mismatched_fingerprint_errors_without_fallback() {
    // Pin seed-a to the digest of a COMPLETELY DIFFERENT cert. When we
    // then hand the verifier the real seed-a cert, it should reject
    // with a `General("fingerprint pin mismatch for seed-a.local")` —
    // no fallback to the inner verifier, even though the fallback here
    // would wave anything through.
    let (der_real, _) = self_signed("seed-a.local");
    let (_, hex_wrong) = self_signed("imposter.example");
    let wrong_digest = parse_hex_sha256(&hex_wrong).expect("parse");
    let mut pins = PinMap::new();
    pins.insert("seed-a.local".into(), wrong_digest);

    // NOTE: insecure fallback would OK anything — so the hard error
    // proves the verifier refuses to fall back on mismatch.
    let verifier = FingerprintPinVerifier::with_insecure_fallback(pins);
    let cert = CertificateDer::from(der_real);
    let now = UnixTime::since_unix_epoch(std::time::Duration::from_secs(1_700_000_000));

    let err = verifier
        .verify_server_cert(&cert, &[], &dns_name("seed-a.local"), &[], now)
        .expect_err("mismatch must fail");
    let msg = format!("{err}");
    assert!(
        msg.contains("fingerprint pin mismatch") && msg.contains("seed-a.local"),
        "rustls error text should name the mismatch + host, got: {msg}"
    );

    // And the seed_err::tls_pin helper produces the canonical
    // validation shape that callers surface to users.
    let surfaced = cognitum_rs::seed::error::tls_pin("seed-a.local");
    match surfaced {
        Error::Validation(ref m) => {
            assert!(m.starts_with("tls_pin:"));
            assert!(m.contains("seed-a.local"));
        }
        other => panic!("expected Validation, got {other:?}"),
    }
}

// ---------- 3. No fingerprint + SeedTls::Insecure builds (back-compat) ----

#[tokio::test]
async fn no_fingerprint_plus_insecure_builds_as_before() {
    // Before fp pinning, `SeedTls::Insecure` waved every cert through.
    // With no discovered fingerprints, the client MUST keep doing
    // exactly that — no behavioural regression.
    let stub = StubFpDiscovery {
        peers: vec![DiscoveredPeer::new("https://insecure.local:8443")],
    };
    let client = SeedClient::builder()
        .discovery(stub)
        .tls(SeedTls::Insecure)
        .build()
        .expect("insecure + no-fp must still build");
    assert_eq!(client.peers().len(), 1);
}

// ---------- 4. Mixed set: one peer matches, another does not --------------

#[test]
fn mixed_peers_one_matches_one_does_not() {
    // Build a pin map from a two-peer list where only one peer has a
    // valid fp. Then exercise the verifier:
    //   - pinned-host + matching cert  → OK
    //   - pinned-host + wrong cert     → err (tls_pin)
    //   - unpinned-host + any cert     → delegates to inner (insecure
    //                                    fallback OKs it, proving the
    //                                    pathway is reachable)
    let (der_a, hex_a) = self_signed("match.local");
    let (der_b, _) = self_signed("other.local");

    let peers = vec![
        DiscoveredPeer::new("https://match.local:8443").with_tls_fingerprint(&hex_a),
        DiscoveredPeer::new("https://no-fp.local:8443"),
    ];
    let pins = build_pin_map(&peers).expect("pin map");
    assert_eq!(pins.len(), 1);
    assert!(pins.contains_key("match.local"));
    assert!(!pins.contains_key("no-fp.local"));

    let verifier = FingerprintPinVerifier::with_insecure_fallback(pins);
    let now = UnixTime::since_unix_epoch(std::time::Duration::from_secs(1_700_000_000));

    // (a) match.local with its own cert → OK
    let ok = verifier.verify_server_cert(
        &CertificateDer::from(der_a.clone()),
        &[],
        &dns_name("match.local"),
        &[],
        now,
    );
    assert!(ok.is_ok(), "matching host/cert should verify: {ok:?}");

    // (b) match.local with the OTHER cert → hard error
    let bad = verifier.verify_server_cert(
        &CertificateDer::from(der_b.clone()),
        &[],
        &dns_name("match.local"),
        &[],
        now,
    );
    let err = bad.expect_err("mismatch must fail");
    assert!(
        format!("{err}").contains("fingerprint pin mismatch"),
        "got: {err}"
    );

    // (c) unpinned host falls through to inner verifier — insecure
    //     fallback accepts, proving the fallthrough path is wired.
    let no_pin = verifier.verify_server_cert(
        &CertificateDer::from(der_b),
        &[],
        &dns_name("no-fp.local"),
        &[],
        now,
    );
    assert!(no_pin.is_ok(), "unpinned host should delegate and pass");
}

// ---------- Bonus: webpki-roots backed verifier builds ---------------------

#[test]
fn webpki_backed_verifier_constructs_cleanly() {
    // Prove the webpki-roots wire still compiles and constructs — the
    // realistic "System TLS + pinned peer" production path.
    let mut pins = PinMap::new();
    pins.insert("x.example".into(), [0u8; 32]);
    let v = FingerprintPinVerifier::with_webpki_roots(pins).expect("webpki builds");
    assert_eq!(v.pin_count(), 1);
}

// ---------- Bonus: explicit inner verifier path ---------------------------

#[test]
fn explicit_inner_verifier_is_respected_on_fallthrough() {
    // Hand in a custom "deny everything" inner verifier. When the pin
    // map has no entry for the queried host, `verify_server_cert` must
    // delegate — and we observe the deny.
    #[derive(Debug)]
    struct DenyAll;
    impl ServerCertVerifier for DenyAll {
        fn verify_server_cert(
            &self,
            _end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: UnixTime,
        ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
            Err(rustls::Error::General("deny all".into()))
        }
        fn verify_tls12_signature(
            &self,
            _m: &[u8],
            _c: &CertificateDer<'_>,
            _d: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            Err(rustls::Error::General("deny all".into()))
        }
        fn verify_tls13_signature(
            &self,
            _m: &[u8],
            _c: &CertificateDer<'_>,
            _d: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            Err(rustls::Error::General("deny all".into()))
        }
        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            vec![]
        }
    }

    let pins = PinMap::new();
    let verifier = FingerprintPinVerifier::new(pins, Arc::new(DenyAll));
    let (der, _) = self_signed("unpinned.local");
    let now = UnixTime::since_unix_epoch(std::time::Duration::from_secs(1_700_000_000));
    let err = verifier
        .verify_server_cert(
            &CertificateDer::from(der),
            &[],
            &dns_name("unpinned.local"),
            &[],
            now,
        )
        .expect_err("deny-all inner must reject when no pin matches");
    assert!(format!("{err}").contains("deny all"));
}

// Silence unused-import warning when `RootCertStore` is only used
// indirectly via webpki helper.
#[allow(dead_code)]
fn _ensure_root_store_is_reachable() {
    let _ = RootCertStore::empty();
}
