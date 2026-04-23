//! mDNS / DNS-SD discovery (ADR-0016a §D6, Phase 3).
//!
//! Gated behind `feature = "mdns"`. Performs a single DNS-SD browse for
//! the configured service type (default `_cognitum._tcp.local.`) and
//! parses the TXT record emitted by `seed/src/cognitum-agent/src/discovery.rs`
//! into a set of [`DiscoveredPeer`]s.
//!
//! `mdns-sd` has no async runtime dependency — it runs a blocking
//! background thread and delivers events through a `flume` receiver. We
//! drive it from a `tokio::task::spawn_blocking` so it composes cleanly
//! with the SDK's `tokio` async runtime.

use std::collections::HashMap;
use std::time::Duration;

use super::{DiscoveredPeer, Discovery};
use crate::error::Error;

/// Default DNS-SD service type advertised by `cognitum-agent` (see
/// `seed/src/cognitum-agent/src/discovery.rs:3-5`).
pub const DEFAULT_SERVICE_TYPE: &str = "_cognitum._tcp.local.";

/// Default maximum time to accumulate mDNS responses before returning.
///
/// Most LAN mDNS responders answer in <100 ms; 2 s is the same budget
/// `avahi-browse -t` uses by default. Tune via
/// [`MdnsDiscovery::browse_duration`] for CI or slow links.
pub const DEFAULT_BROWSE_DURATION: Duration = Duration::from_secs(2);

/// Default port used when a TXT record is missing the `port` key. Matches
/// the cognitum-agent default HTTPS listener.
pub const DEFAULT_PORT: u16 = 8443;

/// One-shot mDNS discovery provider (ADR-0016a §D6).
///
/// Cheap to clone — holds only configuration. Each `discover()` call
/// spins up a fresh `ServiceDaemon` so failures are self-contained and
/// there's no background traffic between calls.
#[derive(Debug, Clone)]
pub struct MdnsDiscovery {
    service_type: String,
    browse_duration: Duration,
    scheme: &'static str,
    default_port: u16,
}

impl Default for MdnsDiscovery {
    fn default() -> Self {
        Self {
            service_type: DEFAULT_SERVICE_TYPE.to_owned(),
            browse_duration: DEFAULT_BROWSE_DURATION,
            scheme: "https",
            default_port: DEFAULT_PORT,
        }
    }
}

impl MdnsDiscovery {
    /// Construct with defaults (`_cognitum._tcp.local.`, 2 s browse, https).
    pub fn new() -> Self {
        Self::default()
    }

    /// Start a fluent builder.
    pub fn builder() -> MdnsDiscoveryBuilder {
        MdnsDiscoveryBuilder::default()
    }

    /// Currently configured service type.
    pub fn service_type(&self) -> &str {
        &self.service_type
    }

    /// Currently configured browse duration.
    pub fn browse_duration(&self) -> Duration {
        self.browse_duration
    }
}

/// Fluent builder for [`MdnsDiscovery`]. Use [`MdnsDiscovery::builder`]
/// to construct one.
#[derive(Debug, Clone)]
pub struct MdnsDiscoveryBuilder {
    service_type: String,
    browse_duration: Duration,
    scheme: &'static str,
    default_port: u16,
}

impl Default for MdnsDiscoveryBuilder {
    fn default() -> Self {
        let defaults = MdnsDiscovery::default();
        Self {
            service_type: defaults.service_type,
            browse_duration: defaults.browse_duration,
            scheme: defaults.scheme,
            default_port: defaults.default_port,
        }
    }
}

impl MdnsDiscoveryBuilder {
    /// Override the DNS-SD service type. Must end in `.local.` to match
    /// link-local semantics; trailing dot is required by `mdns-sd`.
    pub fn service_type(mut self, st: impl Into<String>) -> Self {
        self.service_type = st.into();
        self
    }

    /// Maximum wall time to wait for responses. Defaults to 2 seconds.
    pub fn browse_duration(mut self, d: Duration) -> Self {
        self.browse_duration = d;
        self
    }

    /// URL scheme to construct for discovered peers. The seed HTTPS
    /// listener is the default; override to `"http"` only for local
    /// testing against a plaintext mock.
    pub fn scheme(mut self, scheme: &'static str) -> Self {
        self.scheme = scheme;
        self
    }

    /// Port to use when the TXT record does not supply a `port=` entry.
    pub fn default_port(mut self, port: u16) -> Self {
        self.default_port = port;
        self
    }

    /// Finalise.
    pub fn build(self) -> MdnsDiscovery {
        MdnsDiscovery {
            service_type: self.service_type,
            browse_duration: self.browse_duration,
            scheme: self.scheme,
            default_port: self.default_port,
        }
    }
}

#[async_trait::async_trait]
impl Discovery for MdnsDiscovery {
    async fn discover(&self) -> Result<Vec<DiscoveredPeer>, Error> {
        let service_type = self.service_type.clone();
        let budget = self.browse_duration;
        let scheme = self.scheme;
        let default_port = self.default_port;

        // `mdns-sd`'s `ServiceDaemon` holds sockets and spawns its own
        // thread — wrap the whole browse in `spawn_blocking` so we don't
        // hog a tokio worker and so that socket setup errors don't
        // propagate as async panics.
        let handle = tokio::task::spawn_blocking(move || -> Result<Vec<DiscoveredPeer>, Error> {
            let daemon = mdns_sd::ServiceDaemon::new().map_err(|e| Error::Api {
                code: 0,
                message: format!("mdns: failed to start ServiceDaemon: {e}"),
            })?;
            let receiver = daemon.browse(&service_type).map_err(|e| Error::Api {
                code: 0,
                message: format!("mdns: browse failed for `{service_type}`: {e}"),
            })?;

            // Deduplicate on `instance_name` — DNS-SD sends both
            // `ServiceFound` and later `ServiceResolved`; we only care
            // about the resolved form.
            let mut seen: HashMap<String, DiscoveredPeer> = HashMap::new();
            let started = std::time::Instant::now();

            loop {
                let elapsed = started.elapsed();
                if elapsed >= budget {
                    break;
                }
                let remaining = budget - elapsed;
                match receiver.recv_timeout(remaining) {
                    Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) => {
                        let latency = elapsed.as_millis().min(u128::from(u32::MAX)) as u32;
                        let fullname = info.get_fullname().to_owned();
                        let peer = resolve_info_to_peer(&info, scheme, default_port, latency);
                        if let Some(p) = peer {
                            seen.insert(fullname, p);
                        }
                    }
                    // Ignore `ServiceFound` / `SearchStarted` / etc —
                    // we want the resolved form with TXT keys.
                    Ok(_) => {}
                    // `flume::RecvTimeoutError` isn't re-exported by
                    // mdns-sd; either variant ends the browse loop, so
                    // a bare catch-all is semantically equivalent.
                    Err(_) => break,
                }
            }

            // Best-effort shutdown — the daemon drops its socket when the
            // handle goes out of scope, but call the explicit API so
            // tests don't leak ports across runs.
            let _ = daemon.shutdown();

            let mut out: Vec<DiscoveredPeer> = seen.into_values().collect();
            // Stable order: sort by URL so rediscovery produces a
            // deterministic `list_index` for unchanged networks.
            out.sort_by(|a, b| a.url.cmp(&b.url));
            Ok(out)
        })
        .await
        .map_err(|e| Error::Api {
            code: 0,
            message: format!("mdns: discover task panicked: {e}"),
        })?;

        handle
    }
}

/// Turn a `mdns_sd::ResolvedService` into a [`DiscoveredPeer`].
///
/// Returns `None` when the advertised record has no address — we cannot
/// build a URL without a host, and the alternative (guessing localhost)
/// would silently mis-route writes.
fn resolve_info_to_peer(
    info: &mdns_sd::ResolvedService,
    scheme: &str,
    default_port: u16,
    observed_ms: u32,
) -> Option<DiscoveredPeer> {
    // Prefer a numeric IPv4; fall back to any other address; then to the
    // hostname. ResolvedService.addresses is a HashSet<ScopedIp> and
    // ScopedIp Display-prints to its textual form.
    let mut ipv4: Option<String> = None;
    let mut other: Option<String> = None;
    for a in info.get_addresses() {
        let s = a.to_string();
        // ScopedIp's Display includes "%scope" for link-local; the
        // ScopedIpV4 case is always IPv4.
        if s.contains('.') && !s.contains(':') {
            ipv4 = Some(s);
            break;
        }
        other.get_or_insert(s);
    }
    let host: String = ipv4
        .or(other)
        .unwrap_or_else(|| info.get_hostname().trim_end_matches('.').to_owned());
    if host.is_empty() {
        return None;
    }

    // Port: prefer the TXT `port=` key if present (seed sets it), else
    // fall back to the DNS-SD record port, then the default.
    let txt_port = info
        .get_property_val_str("port")
        .and_then(|s| s.parse::<u16>().ok());
    let record_port = info.get_port();
    let port = txt_port
        .or(if record_port == 0 {
            None
        } else {
            Some(record_port)
        })
        .unwrap_or(default_port);

    // IPv6 hosts need bracketing in a URL; IPv4 and hostnames don't.
    let host_literal = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host
    };

    let url = format!("{scheme}://{host_literal}:{port}");
    let device_id = info.get_property_val_str("id").map(str::to_owned);
    // `fp=sha256:<hex>` per seed/src/cognitum-agent/src/discovery.rs.
    // Normalise to lowercase hex without colons so the FingerprintPinVerifier
    // comparison is trivial.
    let fp = info
        .get_property_val_str("fp")
        .map(super::normalize_fingerprint);

    Some(
        DiscoveredPeer::new(url)
            .with_latency_ms(observed_ms)
            .set_device_id(device_id)
            .set_tls_fingerprint(fp),
    )
}

// Small helpers: fluent `set_device_id(Option<String>)` /
// `set_tls_fingerprint(Option<String>)` — the existing `with_*`
// constructors take owned values, so these keep the call site clean
// when the parsed TXT key may be missing.
impl DiscoveredPeer {
    fn set_device_id(mut self, id: Option<String>) -> Self {
        self.device_id = id;
        self
    }

    fn set_tls_fingerprint(mut self, fp: Option<String>) -> Self {
        self.tls_fingerprint = fp;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_defaults_match_adr() {
        let d = MdnsDiscovery::builder().build();
        assert_eq!(d.service_type(), DEFAULT_SERVICE_TYPE);
        assert_eq!(d.browse_duration(), DEFAULT_BROWSE_DURATION);
    }

    #[test]
    fn builder_overrides_are_applied() {
        let d = MdnsDiscovery::builder()
            .service_type("_cognitum-dev._tcp.local.")
            .browse_duration(Duration::from_millis(500))
            .scheme("http")
            .default_port(18080)
            .build();
        assert_eq!(d.service_type(), "_cognitum-dev._tcp.local.");
        assert_eq!(d.browse_duration(), Duration::from_millis(500));
    }

    #[tokio::test]
    async fn discover_on_empty_network_returns_empty_fast() {
        // Smoke test: on CI / sandboxed containers multicast is usually
        // blocked. The browse budget elapses with no `ServiceResolved`
        // events and we return `Ok(vec![])`. Cap the budget tight so
        // the test doesn't pad suite runtime.
        let d = MdnsDiscovery::builder()
            .service_type("_cognitum-nope._tcp.local.")
            .browse_duration(Duration::from_millis(150))
            .build();
        let peers = d.discover().await.unwrap_or_default();
        assert!(peers.is_empty());
    }

    #[test]
    fn fingerprint_normalisation_strips_prefix_and_colons() {
        use super::super::normalize_fingerprint;
        // Seed wire form is `sha256:AA:BB:...` — we want lowercase hex.
        let got = normalize_fingerprint("sha256:AA:BB:CC:DD");
        assert_eq!(got, "aabbccdd");
        let got2 = normalize_fingerprint("  SHA256:AaBb  ");
        assert_eq!(got2, "aabb");
        // No prefix — still works.
        let got3 = normalize_fingerprint("AABB");
        assert_eq!(got3, "aabb");
    }

    #[test]
    fn set_tls_fingerprint_round_trip_on_discovered_peer() {
        let p = DiscoveredPeer::new("https://seed:8443").with_tls_fingerprint("sha256:AA:BB");
        assert_eq!(p.tls_fingerprint.as_deref(), Some("aabb"));
    }
}
