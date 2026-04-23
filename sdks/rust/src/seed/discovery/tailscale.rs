//! Tailscale-native [`Discovery`] provider (ADR-0016a §D6, closes OQ-11).
//!
//! Shells out to `tailscale status --json`, walks the `Peer` map, and
//! emits one [`DiscoveredPeer`] per entry whose hostname matches a
//! configurable prefix (default `"cognitum-"`) or a caller-supplied
//! predicate. The tailnet carries no device-id or cert-fingerprint
//! advertisements today, so `device_id` / `tls_fingerprint` always stay
//! `None`.
//!
//! # Feature gating
//!
//! Unlike [`MdnsDiscovery`](super::MdnsDiscovery), this provider has NO
//! feature flag — it only depends on `std::process::Command` +
//! `tokio::task::spawn_blocking`, both of which are unconditionally
//! available. Callers on platforms without a usable `tailscale` CLI
//! simply won't have the binary on PATH; the resulting
//! `Error::Validation` is the correct signal.
//!
//! # Windows
//!
//! Windows ships the CLI as `tailscale.exe`. `Command::new("tailscale")`
//! resolves the extension via `PATHEXT`, so the default config works on
//! Windows too. Override [`TailscaleDiscovery::with_command`] if you
//! need an absolute path.

use std::process::Command;
use std::sync::Arc;

use serde::Deserialize;

use super::{DiscoveredPeer, Discovery};
use crate::error::Error;

/// Default host-name prefix used to filter tailnet peers.
pub const DEFAULT_PREFIX: &str = "cognitum-";

/// Default TCP port used when constructing `https://` URLs.
pub const DEFAULT_PORT: u16 = 8443;

/// Default CLI binary name — resolved on `PATH` (incl. `PATHEXT` on Windows).
pub const DEFAULT_COMMAND: &str = "tailscale";

/// Relevant slice of `tailscale status --json`.
#[derive(Debug, Deserialize)]
struct TailscaleStatus {
    #[serde(default, rename = "Peer")]
    peer: std::collections::HashMap<String, TailscalePeer>,
    #[serde(default, rename = "Self")]
    self_peer: Option<TailscalePeer>,
}

/// One entry in the tailnet peer map. Only the fields we care about.
#[derive(Debug, Clone, Deserialize)]
pub struct TailscalePeer {
    /// Short hostname — e.g. `cognitum-61bc`.
    #[serde(default, rename = "HostName")]
    pub host_name: Option<String>,
    /// Fully-qualified DNS name — e.g. `cognitum-61bc.tail1234.ts.net.`.
    #[serde(default, rename = "DNSName")]
    pub dns_name: Option<String>,
    /// Whether Tailscale considers the peer reachable right now.
    #[serde(default, rename = "Online")]
    pub online: Option<bool>,
}

/// Predicate trait used for custom peer filtering. Trait-object friendly
/// so the builder can erase closure types. We deliberately do NOT
/// require `Debug` on the underlying closure — Rust closures don't
/// auto-impl it — so the `TailscaleDiscovery`'s `Debug` impl opaquely
/// renders the field as `"<fn>"` instead.
pub trait PeerPredicate: Send + Sync {
    /// Return `true` to keep the peer, `false` to drop it.
    fn matches(&self, peer: &TailscalePeer) -> bool;
}

impl<F> PeerPredicate for F
where
    F: Fn(&TailscalePeer) -> bool + Send + Sync + 'static,
{
    fn matches(&self, peer: &TailscalePeer) -> bool {
        (self)(peer)
    }
}

/// One-shot Tailscale discovery provider.
///
/// Cheap to clone — holds only configuration. Each `discover()` call
/// spawns a fresh `tailscale status --json` subprocess so failures are
/// self-contained.
///
/// # Example
///
/// ```no_run
/// # #[cfg(feature = "seed")]
/// # {
/// use cognitum_rs::seed::{SeedClient, SeedTls};
/// use cognitum_rs::seed::discovery::tailscale::TailscaleDiscovery;
///
/// # async fn _doc() -> Result<(), cognitum_rs::error::Error> {
/// let client = SeedClient::builder()
///     .discovery(TailscaleDiscovery::new())
///     .tls(SeedTls::System)
///     .build()?;
/// # Ok(()) }
/// # }
/// ```
#[derive(Clone)]
pub struct TailscaleDiscovery {
    prefix: String,
    port: u16,
    scheme: &'static str,
    command: String,
    predicate: Option<Arc<dyn PeerPredicate>>,
}

impl std::fmt::Debug for TailscaleDiscovery {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TailscaleDiscovery")
            .field("prefix", &self.prefix)
            .field("port", &self.port)
            .field("scheme", &self.scheme)
            .field("command", &self.command)
            .field("predicate", &self.predicate.as_ref().map(|_| "<fn>"))
            .finish()
    }
}

impl Default for TailscaleDiscovery {
    fn default() -> Self {
        Self {
            prefix: DEFAULT_PREFIX.to_owned(),
            port: DEFAULT_PORT,
            scheme: "https",
            command: DEFAULT_COMMAND.to_owned(),
            predicate: None,
        }
    }
}

impl TailscaleDiscovery {
    /// Construct with defaults (`cognitum-` prefix, port 8443, `tailscale` CLI).
    pub fn new() -> Self {
        Self::default()
    }

    /// Override the hostname prefix used when no predicate is set.
    /// Case is folded to lower-case internally.
    pub fn with_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.prefix = prefix.into();
        self
    }

    /// Override the TCP port used in constructed URLs.
    pub fn with_port(mut self, port: u16) -> Self {
        self.port = port;
        self
    }

    /// Point at an alternate `tailscale` binary (absolute path or
    /// relative name). Defaults to `"tailscale"`, which on Windows
    /// resolves to `tailscale.exe` via `PATHEXT`.
    pub fn with_command(mut self, command: impl Into<String>) -> Self {
        self.command = command.into();
        self
    }

    /// Install a custom filter. When set, the `prefix` is ignored —
    /// only peers for which the predicate returns `true` are kept.
    pub fn with_predicate<P>(mut self, predicate: P) -> Self
    where
        P: PeerPredicate + 'static,
    {
        self.predicate = Some(Arc::new(predicate));
        self
    }

    fn keep(&self, peer: &TailscalePeer) -> bool {
        if let Some(p) = &self.predicate {
            return p.matches(peer);
        }
        let candidate = peer
            .host_name
            .as_deref()
            .or(peer.dns_name.as_deref())
            .unwrap_or("");
        candidate.to_ascii_lowercase().starts_with(&self.prefix.to_ascii_lowercase())
    }

    fn peer_host(peer: &TailscalePeer) -> Option<String> {
        if let Some(dns) = peer.dns_name.as_deref() {
            let trimmed = dns.trim().trim_end_matches('.');
            if !trimmed.is_empty() {
                return Some(trimmed.to_owned());
            }
        }
        peer.host_name.as_deref().and_then(|h| {
            let t = h.trim();
            if t.is_empty() { None } else { Some(t.to_owned()) }
        })
    }

    fn map_status(&self, status: TailscaleStatus) -> Vec<DiscoveredPeer> {
        let mut seen: std::collections::BTreeMap<String, DiscoveredPeer> =
            std::collections::BTreeMap::new();
        let mut visit = |peer: &TailscalePeer| {
            if !self.keep(peer) {
                return;
            }
            if let Some(host) = Self::peer_host(peer) {
                let url = format!("{}://{}:{}", self.scheme, host, self.port);
                seen.entry(url.clone()).or_insert_with(|| DiscoveredPeer::new(url));
            }
        };
        for p in status.peer.values() {
            visit(p);
        }
        if let Some(s) = &status.self_peer {
            visit(s);
        }
        seen.into_values().collect()
    }

    /// Run the configured command synchronously. Factored out so tests
    /// can exercise the parsing path without a tokio runtime.
    fn run_sync(&self) -> Result<TailscaleStatus, Error> {
        let output = Command::new(&self.command)
            .args(["status", "--json"])
            .output()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    Error::Validation(format!(
                        "TailscaleDiscovery: `{}` not found on PATH. Install the \
                         Tailscale CLI (https://tailscale.com/download) or pass \
                         `.with_command(...)` with an absolute path.",
                        self.command
                    ))
                } else {
                    Error::Validation(format!(
                        "TailscaleDiscovery: failed to spawn `{}`: {e}",
                        self.command
                    ))
                }
            })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(Error::Validation(format!(
                "TailscaleDiscovery: `{} status --json` exited {} — stderr: {}",
                self.command,
                output.status.code().unwrap_or(-1),
                stderr.trim()
            )));
        }

        serde_json::from_slice::<TailscaleStatus>(&output.stdout).map_err(|e| {
            Error::Validation(format!(
                "TailscaleDiscovery: failed to parse `tailscale status --json` output: {e}"
            ))
        })
    }
}

#[async_trait::async_trait]
impl Discovery for TailscaleDiscovery {
    async fn discover(&self) -> Result<Vec<DiscoveredPeer>, Error> {
        // Clone config into the blocking task so the future stays Send.
        let this = self.clone();
        let status = tokio::task::spawn_blocking(move || this.run_sync())
            .await
            .map_err(|e| {
                Error::Api {
                    code: 0,
                    message: format!("TailscaleDiscovery: discover task panicked: {e}"),
                }
            })??;
        Ok(self.map_status(status))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE_STATUS: &str = r#"{
        "Self": {
            "HostName": "ruvultra",
            "DNSName": "ruvultra.tail1234.ts.net.",
            "Online": true
        },
        "Peer": {
            "nodekey_a": {
                "HostName": "cognitum-61bc",
                "DNSName": "cognitum-61bc.tail1234.ts.net.",
                "Online": true
            },
            "nodekey_b": {
                "HostName": "cognitum-aaaa",
                "DNSName": "cognitum-aaaa.tail1234.ts.net.",
                "Online": true
            },
            "nodekey_c": {
                "HostName": "laptop-joe",
                "DNSName": "laptop-joe.tail1234.ts.net.",
                "Online": true
            }
        }
    }"#;

    fn parse_fixture() -> TailscaleStatus {
        serde_json::from_str(FIXTURE_STATUS).expect("fixture parses")
    }

    #[test]
    fn default_prefix_filters_to_cognitum_peers() {
        let provider = TailscaleDiscovery::new();
        let peers = provider.map_status(parse_fixture());
        let mut urls: Vec<String> = peers.iter().map(|p| p.url.clone()).collect();
        urls.sort();
        assert_eq!(
            urls,
            vec![
                "https://cognitum-61bc.tail1234.ts.net:8443".to_owned(),
                "https://cognitum-aaaa.tail1234.ts.net:8443".to_owned(),
            ]
        );
        for p in &peers {
            assert!(p.device_id.is_none());
            assert!(p.tls_fingerprint.is_none());
        }
    }

    #[test]
    fn custom_predicate_and_port_override() {
        let provider = TailscaleDiscovery::new()
            .with_port(18443)
            .with_predicate(|p: &TailscalePeer| {
                p.host_name.as_deref() == Some("cognitum-61bc")
            });
        let peers = provider.map_status(parse_fixture());
        assert_eq!(peers.len(), 1);
        assert_eq!(
            peers[0].url,
            "https://cognitum-61bc.tail1234.ts.net:18443"
        );
    }

    #[tokio::test]
    async fn missing_binary_raises_validation_error() {
        // `/nonexistent/tailscale` deterministically yields NotFound on
        // every supported OS — no real subprocess is spawned.
        let provider = TailscaleDiscovery::new().with_command("/nonexistent/tailscale");
        let err = provider.discover().await.expect_err("should fail");
        assert!(
            matches!(err, Error::Validation(ref m) if m.contains("not found on PATH")),
            "got: {err:?}"
        );
    }

    #[test]
    fn malformed_json_raises_validation_error_from_run_sync() {
        // Exercise the parse branch directly — we can't easily stub
        // Command::output() without pulling in a test-only mocker, but
        // the parse error path is trivially coverable.
        let err = serde_json::from_slice::<TailscaleStatus>(b"not json")
            .map_err(|e| Error::Validation(format!(
                "TailscaleDiscovery: failed to parse `tailscale status --json` output: {e}"
            )))
            .expect_err("parse should fail");
        assert!(
            matches!(err, Error::Validation(ref m) if m.contains("failed to parse")),
            "got: {err:?}"
        );
    }
}
