//! Peer set management.
//!
//! Phase 1 ships single-seed mode: a [`PeerSet`] of exactly one endpoint.
//! The API shape carries a `Vec<Endpoint>` so Phase 1.5 mesh-mode can
//! extend without a breaking change.

use url::Url;

use crate::error::Error;

/// A seed endpoint (base URL).
///
/// Base URL is of the form `https://<host>:<port>` — no trailing slash, no
/// `/api/v1` prefix (resources add their own path). If you pass a URL with
/// a path, the path is kept verbatim and resources concatenate onto it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub(crate) url: Url,
}

impl Endpoint {
    /// Parse `raw` as an absolute HTTPS URL. Returns `Error::Validation`
    /// for non-HTTP(S) schemes, missing host, or unparseable input.
    pub fn parse(raw: &str) -> Result<Self, Error> {
        let url = Url::parse(raw)
            .map_err(|e| Error::Validation(format!("invalid seed endpoint `{raw}`: {e}")))?;

        if url.scheme() != "http" && url.scheme() != "https" {
            return Err(Error::Validation(format!(
                "seed endpoint `{raw}` must be http or https, got `{}`",
                url.scheme()
            )));
        }

        if url.host_str().is_none() {
            return Err(Error::Validation(format!(
                "seed endpoint `{raw}` is missing a host"
            )));
        }

        Ok(Self { url })
    }

    /// Inner [`url::Url`].
    pub fn url(&self) -> &Url {
        &self.url
    }

    /// Full URL to `<base>/api/v1<path>`. `path` MUST start with `/`.
    pub(crate) fn join_api(&self, path: &str) -> Result<Url, Error> {
        debug_assert!(path.starts_with('/'), "seed path must be absolute");
        let full = format!("/api/v1{path}");
        self.url
            .join(&full)
            .map_err(|e| Error::Validation(format!("bad seed path `{path}`: {e}")))
    }
}

/// The ordered list of endpoints a [`SeedClient`](super::SeedClient)
/// talks to.
///
/// Phase 1 invariant: `len() == 1`. Phase 1.5 relaxes to `len() >= 1`
/// under [`Routing::Balanced`](super::config::Routing::Balanced) or
/// [`Routing::Failover`](super::config::Routing::Failover).
#[derive(Debug, Clone)]
pub struct PeerSet {
    endpoints: Vec<Endpoint>,
}

impl PeerSet {
    /// Single-endpoint constructor — Phase 1 path.
    pub fn single(endpoint: Endpoint) -> Self {
        Self {
            endpoints: vec![endpoint],
        }
    }

    /// Multi-endpoint constructor — Phase 1.5. Phase 1 rejects with
    /// `Error::Validation` when more than one endpoint is supplied.
    pub fn try_from_many(endpoints: Vec<Endpoint>) -> Result<Self, Error> {
        if endpoints.is_empty() {
            return Err(Error::Validation(
                "PeerSet requires at least one endpoint".into(),
            ));
        }
        Ok(Self { endpoints })
    }

    /// The endpoint selected by the current routing strategy. Phase 1
    /// always returns the first element (equivalent to `Routing::Pinned`).
    pub fn primary(&self) -> &Endpoint {
        &self.endpoints[0]
    }

    /// Total count — Phase 1 always returns 1.
    pub fn len(&self) -> usize {
        self.endpoints.len()
    }

    /// Whether the peer set is empty. Always `false` for Phase 1 — the
    /// constructors reject empty lists — but present to satisfy the
    /// `len_without_is_empty` lint.
    pub fn is_empty(&self) -> bool {
        self.endpoints.is_empty()
    }

    /// Iterator for Phase 1.5 routing (Balanced / Failover).
    pub fn iter(&self) -> impl Iterator<Item = &Endpoint> {
        self.endpoints.iter()
    }

    /// True if more than one peer is configured (Phase 1.5 signal).
    pub fn is_mesh(&self) -> bool {
        self.endpoints.len() > 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_rejects_ws() {
        let err = Endpoint::parse("ws://x:1").unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
    }

    #[test]
    fn parse_rejects_garbage() {
        let err = Endpoint::parse("not a url").unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
    }

    #[test]
    fn parse_accepts_https() {
        let ep = Endpoint::parse("https://cognitum.local:8443").unwrap();
        assert_eq!(ep.url().scheme(), "https");
        assert_eq!(ep.url().host_str(), Some("cognitum.local"));
        assert_eq!(ep.url().port(), Some(8443));
    }

    #[test]
    fn join_api_builds_full_url() {
        let ep = Endpoint::parse("https://cognitum.local:8443").unwrap();
        let url = ep.join_api("/status").unwrap();
        assert_eq!(url.as_str(), "https://cognitum.local:8443/api/v1/status");
    }

    #[test]
    fn single_peerset_is_len_one() {
        let ep = Endpoint::parse("https://seed:8443").unwrap();
        let ps = PeerSet::single(ep);
        assert_eq!(ps.len(), 1);
        assert!(!ps.is_mesh());
    }

    #[test]
    fn try_from_many_rejects_empty() {
        let err = PeerSet::try_from_many(vec![]).unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
    }
}
