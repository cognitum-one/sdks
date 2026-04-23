//! Per-peer cert-fingerprint pinning for the seed rustls handshake.
//!
//! When a discovery provider observes a `fp=sha256:<hex>` TXT key on an
//! mDNS advert (see `seed/src/cognitum-agent/src/discovery.rs`), the SDK
//! pins the TLS handshake to that exact end-entity certificate instead
//! of falling back to the system trust store or a pinned CA. This is
//! the link-local self-signed story that ADR-0007 §TLS calls out — a
//! Pi Zero on `169.254.42.1` cannot present a cloud-signed cert, but
//! the advert provides the SHA-256 hash of the live cert so the SDK can
//! verify it anyway.
//!
//! # Design
//!
//! [`FingerprintPinVerifier`] implements
//! [`rustls::client::danger::ServerCertVerifier`] and holds a map from
//! `host` (lowercased `host:port` string) to a 32-byte SHA-256 digest.
//! `verify_server_cert`:
//!
//! 1. Looks up the map using the `ServerName` of the handshake.
//! 2. If found — computes SHA-256 of the presented end-entity DER and
//!    compares; mismatch → `rustls::Error::General("fingerprint pin
//!    mismatch")`, match → success. **No fallback on mismatch.**
//! 3. If not found — delegates to the underlying verifier (system trust
//!    store or a pinned-CA verifier supplied by the builder).
//!
//! The verifier deliberately computes the digest with the `sha2` crate
//! rather than pulling one through rustls' internal `hash` trait —
//! keeping the dep surface explicit and the code reviewable.
//!
//! # Why one shared verifier
//!
//! Reqwest builds a single HTTPS connector per `Client`. Installing a
//! fresh rustls `ClientConfig` per peer would mean building a client
//! per peer, which defeats the pooled-connection story on the seed
//! request loop. Instead we build one verifier keyed on hostname and
//! let rustls select the right pin at handshake time.

use std::collections::BTreeMap;
use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, Error as RustlsError, RootCertStore, SignatureScheme};
use sha2::{Digest, Sha256};

/// Canonical map key: lowercased hostname. We intentionally do NOT
/// include the port because the rustls `ServerName` does not carry one
/// — the hostname is our stable cross-reference.
pub type PinMap = BTreeMap<String, [u8; 32]>;

/// Custom `ServerCertVerifier` that pins known peers to a SHA-256
/// digest of their end-entity certificate DER.
///
/// Unknown peers (no entry for the ServerName in `pins`) fall through
/// to an inner `webpki` verifier — either the system trust store or a
/// caller-supplied pinned CA.
#[derive(Debug)]
pub struct FingerprintPinVerifier {
    pins: PinMap,
    inner: Arc<dyn ServerCertVerifier>,
}

impl FingerprintPinVerifier {
    /// Build a verifier with `pins` and a pre-built inner verifier.
    pub fn new(pins: PinMap, inner: Arc<dyn ServerCertVerifier>) -> Self {
        Self { pins, inner }
    }

    /// Fallback verifier that accepts ANY certificate. Used only when
    /// the caller requested `SeedTls::Insecure` but has also supplied
    /// per-peer pins — the pinned peers are verified, unknown peers are
    /// waved through as they would have been without pinning. Spelled
    /// out separately so the "insecure" regression surface is narrow.
    pub fn with_insecure_fallback(pins: PinMap) -> Self {
        Self {
            pins,
            inner: Arc::new(NoVerification),
        }
    }

    /// Convenience: build with the default webpki verifier backed by
    /// `webpki-roots` (same trust posture as reqwest's default rustls).
    pub fn with_webpki_roots(pins: PinMap) -> Result<Self, RustlsError> {
        let mut roots = RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let inner = WebPkiServerVerifier::builder(Arc::new(roots))
            .build()
            .map_err(|e| RustlsError::General(format!("webpki verifier: {e}")))?;
        Ok(Self::new(pins, inner))
    }

    /// Build with a pinned-CA trust root (maps to the existing
    /// `SeedTls::Pinned` behaviour). Accepts a pre-populated
    /// `RootCertStore`.
    #[allow(dead_code)]
    pub(crate) fn with_roots(pins: PinMap, roots: RootCertStore) -> Result<Self, RustlsError> {
        let inner = WebPkiServerVerifier::builder(Arc::new(roots))
            .build()
            .map_err(|e| RustlsError::General(format!("webpki verifier: {e}")))?;
        Ok(Self::new(pins, inner))
    }

    /// Hex-encoded SHA-256 of `der` — public for tests that want to
    /// synthesize known pins without duplicating the hash call.
    pub fn sha256_hex(der: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(der);
        hex_encode(&h.finalize())
    }

    /// Number of configured pins — handy for tests and logging.
    pub fn pin_count(&self) -> usize {
        self.pins.len()
    }
}

impl ServerCertVerifier for FingerprintPinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, RustlsError> {
        // Find the pin for this ServerName. `ServerName::to_str` (from
        // the Display impl) gives a lowercased form for DnsName, which
        // is what we stored.
        let host = match server_name {
            ServerName::DnsName(d) => d.as_ref().to_ascii_lowercase(),
            ServerName::IpAddress(ip) => std::net::IpAddr::from(*ip).to_string(),
            _ => {
                return self.inner.verify_server_cert(
                    end_entity,
                    intermediates,
                    server_name,
                    ocsp_response,
                    now,
                )
            }
        };

        if let Some(expected) = self.pins.get(&host) {
            let mut hasher = Sha256::new();
            hasher.update(end_entity.as_ref());
            let actual = hasher.finalize();
            if actual.as_slice() == expected.as_slice() {
                return Ok(ServerCertVerified::assertion());
            }
            // Do NOT fall back to the inner verifier — a fingerprint
            // mismatch is a hard failure per ADR-0007.
            return Err(RustlsError::General(format!(
                "fingerprint pin mismatch for {host}"
            )));
        }

        // No pin for this host — defer to the inner verifier.
        self.inner
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// "Accept anything" verifier — used as the inner fallback when the
/// caller combined fingerprint pinning with `SeedTls::Insecure`. Never
/// used on its own.
#[derive(Debug)]
struct NoVerification;

impl ServerCertVerifier for NoVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, RustlsError> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::ED25519,
        ]
    }
}

/// Parse a lowercased-hex fingerprint string into the 32-byte digest
/// stored in the verifier map. Returns `None` for non-hex / non-32-byte
/// input.
pub fn parse_hex_sha256(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        let hi = hex_nibble(chunk[0])?;
        let lo = hex_nibble(chunk[1])?;
        out[i] = (hi << 4) | lo;
    }
    Some(out)
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[allow(dead_code)]
fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

/// Collect per-peer pins from a list of discovered peers. Keyed on the
/// lowercased hostname extracted from each peer URL. Peers without a
/// `tls_fingerprint` or with malformed hex are silently skipped — the
/// builder has already logged the advert, and a missing pin falls
/// through to whichever base verifier the caller configured.
pub fn build_pin_map(
    discovered: &[super::discovery::DiscoveredPeer],
) -> Result<PinMap, url::ParseError> {
    let mut pins = PinMap::new();
    for peer in discovered {
        let Some(ref fp_hex) = peer.tls_fingerprint else {
            continue;
        };
        let Some(digest) = parse_hex_sha256(fp_hex) else {
            continue;
        };
        let parsed = url::Url::parse(&peer.url)?;
        if let Some(host) = parsed.host_str() {
            pins.insert(host.to_ascii_lowercase(), digest);
        }
    }
    Ok(pins)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_matches_openssl_golden() {
        // openssl dgst -sha256 < /dev/null
        let empty = FingerprintPinVerifier::sha256_hex(b"");
        assert_eq!(
            empty,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn parse_hex_sha256_round_trip() {
        let hex = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let bytes = parse_hex_sha256(hex).unwrap();
        assert_eq!(hex_encode(&bytes), hex);
    }

    #[test]
    fn parse_hex_sha256_rejects_wrong_length() {
        assert!(parse_hex_sha256("abc").is_none());
        assert!(parse_hex_sha256(&"a".repeat(63)).is_none());
        assert!(parse_hex_sha256(&"a".repeat(65)).is_none());
    }

    #[test]
    fn parse_hex_sha256_accepts_uppercase() {
        let upper = "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855";
        let lower = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert_eq!(
            parse_hex_sha256(upper).unwrap(),
            parse_hex_sha256(lower).unwrap()
        );
    }

    #[test]
    fn build_pin_map_skips_peers_without_fingerprint() {
        use super::super::discovery::DiscoveredPeer;

        let digest_hex = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let peers = vec![
            DiscoveredPeer::new("https://a.local:8443").with_tls_fingerprint(digest_hex),
            // No fp — ignored.
            DiscoveredPeer::new("https://b.local:8443"),
            // Malformed fp — ignored.
            DiscoveredPeer::new("https://c.local:8443").with_tls_fingerprint("not-hex"),
        ];
        let pins = build_pin_map(&peers).unwrap();
        assert_eq!(pins.len(), 1);
        assert!(pins.contains_key("a.local"));
    }

    #[test]
    fn empty_pin_map_passthrough_to_inner_verifier() {
        // A verifier with no pins MUST delegate every handshake to the
        // inner verifier without consulting the map. We prove the map
        // is empty here; the reqwest-level behaviour is covered in
        // `tests/seed_fp_pin.rs`.
        let verifier = FingerprintPinVerifier::with_insecure_fallback(PinMap::new());
        assert_eq!(verifier.pin_count(), 0);
    }

    #[test]
    fn case_insensitive_hex_match() {
        // Two hex strings that only differ in case parse to the same
        // digest — mirrors the TXT-record expectation that the seed
        // may advertise uppercase while SDKs normalise to lowercase.
        let a = parse_hex_sha256("AABBCCDD".repeat(8).as_str()).unwrap();
        let b = parse_hex_sha256("aabbccdd".repeat(8).as_str()).unwrap();
        assert_eq!(a, b);
    }
}
