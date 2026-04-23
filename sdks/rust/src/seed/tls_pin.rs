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
///
/// The value is a variable-length byte prefix of the expected SHA-256.
/// The seed firmware emits a 16-hex-char (8-byte) prefix in its mDNS
/// TXT record (see `seed/src/cognitum-agent/src/discovery.rs:162`), so
/// requiring a full 32-byte digest here would silently skip the pin
/// for every real seed. [`verify_server_cert`] prefix-matches against
/// the computed SHA-256 of the presented end-entity cert.
pub type PinMap = BTreeMap<String, Vec<u8>>;

/// Minimum pin length in bytes. 8 bytes = 16 hex chars, matching the
/// seed firmware's truncated TXT form (64 bits of entropy). Anything
/// shorter is an adversarial short prefix — see [`parse_hex_pin`].
pub const PIN_MIN_BYTES: usize = 8;

/// Maximum pin length in bytes. 32 bytes = 64 hex chars, matching the
/// full SHA-256 that callers can supply out-of-band (e.g. manually).
pub const PIN_MAX_BYTES: usize = 32;

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
            // Defense-in-depth: the [`PIN_MIN_BYTES`, `PIN_MAX_BYTES`]
            // bounds are enforced by `parse_hex_pin` at parse time,
            // but a caller who constructs a `PinMap` directly (bypass
            // of the parser) must not be able to slip in a 1-byte pin
            // and match 1/256 of every cert via prefix.
            let pin_len = expected.len();
            if pin_len < PIN_MIN_BYTES || pin_len > PIN_MAX_BYTES {
                return Err(RustlsError::General(format!(
                    "fingerprint pin for {host} has invalid length \
                     {pin_len} bytes (want {PIN_MIN_BYTES}..={PIN_MAX_BYTES})"
                )));
            }
            // Prefix match: seed firmware advertises a truncated
            // SHA-256 prefix, so the pin may be shorter than the full
            // digest. Compare only the first `pin_len` bytes.
            if actual.as_slice().get(..pin_len) == Some(expected.as_slice()) {
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

/// Parse a lowercased-hex fingerprint string into the 32-byte digest.
/// Returns `None` for anything other than exactly 64 hex chars.
///
/// Kept for callers that need the fixed-size byte array (e.g. tests
/// comparing against a known-good digest). For discovery paths that
/// install pins from the seed's mDNS TXT, use [`parse_hex_pin`] —
/// the seed emits a 16-char prefix and this function would reject it.
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

/// Parse a lowercased-hex fingerprint string into a variable-length
/// byte prefix suitable for [`PinMap`]. Accepts `[16, 64]` hex chars
/// (`[PIN_MIN_BYTES * 2, PIN_MAX_BYTES * 2]`) — covers both the seed
/// firmware's truncated 16-char emission and a full 64-char SHA-256.
///
/// Returns `None` for out-of-bounds length, odd length (not whole
/// bytes), or non-hex input.
///
/// The 16-char floor closes the same attack class as Node's C1 fix —
/// without it an attacker advertising `fp=ab` via mDNS could
/// brute-force a cert matching a 1-byte prefix in seconds. The 64-char
/// ceiling rejects padded/different-algo input.
pub fn parse_hex_pin(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    let byte_len = hex.len() / 2;
    if !(PIN_MIN_BYTES..=PIN_MAX_BYTES).contains(&byte_len) {
        return None;
    }
    let mut out = Vec::with_capacity(byte_len);
    for chunk in hex.as_bytes().chunks(2) {
        let hi = hex_nibble(chunk[0])?;
        let lo = hex_nibble(chunk[1])?;
        out.push((hi << 4) | lo);
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
        // Accept [16, 64]-hex pins. The seed firmware truncates to 16
        // hex chars in its TXT record; requiring exactly 64 (the prior
        // behaviour) silently skipped every real seed pin.
        let Some(digest) = parse_hex_pin(fp_hex) else {
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

    // ---- parse_hex_pin: [16, 64] hex bounds -------------------------------
    //
    // Security-review finding: the seed firmware emits `fp={first 16 hex
    // chars}` (see `seed/src/cognitum-agent/src/discovery.rs:162`). The
    // prior `parse_hex_sha256` required exactly 64 chars and silently
    // skipped the seed's 16-char pins via `build_pin_map`, so pinning
    // was effectively OFF for every real seed. `parse_hex_pin` accepts
    // [16, 64] hex and stores the byte prefix; `verify_server_cert`
    // prefix-matches against the actual SHA-256.

    #[test]
    fn parse_hex_pin_accepts_seed_16_char_form() {
        // 16 hex = 8 bytes = the seed firmware's advertised form.
        let pin = parse_hex_pin("e3b0c44298fc1c14").expect("parse");
        assert_eq!(pin.len(), 8);
        assert_eq!(
            pin,
            vec![0xe3, 0xb0, 0xc4, 0x42, 0x98, 0xfc, 0x1c, 0x14]
        );
    }

    #[test]
    fn parse_hex_pin_accepts_full_64_char_form() {
        // 64 hex = 32 bytes = full SHA-256, for callers who supply
        // fingerprints out-of-band (e.g. Tailscale + manual pin).
        let pin = parse_hex_pin(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        )
        .expect("parse");
        assert_eq!(pin.len(), 32);
    }

    #[test]
    fn parse_hex_pin_rejects_outside_bounds() {
        // < 16 hex chars: adversarial short prefix (cf. Node C1).
        assert!(parse_hex_pin("").is_none());
        assert!(parse_hex_pin("ab").is_none());
        assert!(parse_hex_pin("abcdef0123").is_none()); // 10 hex = 5 bytes
        assert!(parse_hex_pin(&"a".repeat(14)).is_none());
        // > 64 hex chars: padded / wrong hash algo.
        assert!(parse_hex_pin(&"a".repeat(66)).is_none());
        assert!(parse_hex_pin(&"a".repeat(128)).is_none());
        // Odd length (not whole bytes) always rejected.
        assert!(parse_hex_pin(&"a".repeat(17)).is_none());
        assert!(parse_hex_pin(&"a".repeat(63)).is_none());
        // Non-hex chars rejected.
        assert!(parse_hex_pin(&"Z".repeat(16)).is_none());
        assert!(parse_hex_pin("e3b0c44298fc1c1z").is_none());
    }

    #[test]
    fn build_pin_map_accepts_seed_16_char_pin() {
        // The bug this closes: seed emits fp=16-chars, prior
        // `build_pin_map` silently skipped because parse_hex_sha256
        // required 64. Now the 16-char form installs a pin.
        use super::super::discovery::DiscoveredPeer;

        let peers = vec![
            DiscoveredPeer::new("https://seed-a.local:8443")
                .with_tls_fingerprint("e3b0c44298fc1c14"), // 16 hex, seed form
        ];
        let pins = build_pin_map(&peers).unwrap();
        assert_eq!(
            pins.len(),
            1,
            "16-hex pin should install; previously skipped silently"
        );
        let pin = pins.get("seed-a.local").expect("installed");
        assert_eq!(pin.len(), 8, "8-byte prefix preserved");
    }

    #[test]
    fn verify_server_cert_matches_on_16_char_prefix() {
        // End-to-end: the pin is the 16-char prefix of the real cert's
        // SHA-256. verify_server_cert must do a prefix match against
        // the full digest. Previously compared full 32 bytes against a
        // [u8; 32] — an 8-byte pin could not possibly be stored in the
        // map, let alone match.
        let der = b"fake-der-for-test";
        let full_hex = FingerprintPinVerifier::sha256_hex(der);
        let prefix16 = &full_hex[..16];
        let pin = parse_hex_pin(prefix16).expect("parse");

        let mut pins = PinMap::new();
        pins.insert("seed-a.local".into(), pin);
        let verifier = FingerprintPinVerifier::with_insecure_fallback(pins);

        use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
        let cert = CertificateDer::from(der.to_vec());
        let name = ServerName::try_from("seed-a.local").unwrap();
        let now = UnixTime::since_unix_epoch(std::time::Duration::from_secs(
            1_700_000_000,
        ));

        let ok = verifier.verify_server_cert(&cert, &[], &name, &[], now);
        assert!(ok.is_ok(), "16-char prefix must match full digest: {ok:?}");
    }

    #[test]
    fn verify_server_cert_rejects_on_16_char_mismatch() {
        let der = b"fake-der-for-test";
        let full_hex = FingerprintPinVerifier::sha256_hex(der);
        // Flip the first nibble — now the prefix does NOT match.
        let mut wrong = full_hex[..16].to_string();
        let first = wrong.remove(0);
        let flipped = match first {
            '0' => 'f',
            _ => '0',
        };
        wrong.insert(0, flipped);
        let pin = parse_hex_pin(&wrong).expect("parse");

        let mut pins = PinMap::new();
        pins.insert("seed-a.local".into(), pin);
        let verifier = FingerprintPinVerifier::with_insecure_fallback(pins);

        use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
        let cert = CertificateDer::from(der.to_vec());
        let name = ServerName::try_from("seed-a.local").unwrap();
        let now = UnixTime::since_unix_epoch(std::time::Duration::from_secs(
            1_700_000_000,
        ));

        let err = verifier
            .verify_server_cert(&cert, &[], &name, &[], now)
            .expect_err("mismatched prefix must fail");
        let msg = format!("{err}");
        assert!(msg.contains("fingerprint pin mismatch"), "got: {msg}");
    }
}
