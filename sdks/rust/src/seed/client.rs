//! [`SeedClient`] and its fluent [`SeedClientBuilder`].
//!
//! The client composes over a locally-built `reqwest::Client` — it does
//! NOT reuse the cloud [`crate::Client`] because cloud defaults to
//! `X-API-Key` and `https://api.cognitum.one`, and the seed has a
//! different auth header (`X-Pairing-Token`) and host (`https://<seed>:8443`).
//!
//! Phase 1 delivers:
//!
//! * Single-endpoint construction.
//! * `SeedTls::{System, Pinned, Insecure}` — insecure logs once per process.
//! * `Routing::Pinned` — mesh variants return `Error::Validation`
//!   ("not_implemented: feature `mesh-routing`").
//! * Shared request loop with retry, equal-jitter backoff, `Retry-After`
//!   parsing.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::Error;

use super::config::{Routing, SeedAuth, SeedTls, Timeouts};
use super::error as seed_err;
use super::peers::{Endpoint, PeerSet};
use super::resources::{
    CustodyResource, OtaResource, PairResource, StoreResource, WitnessResource,
};
use super::retry;

/// One-shot process-global flag for the insecure-TLS warning.
static INSECURE_WARN: AtomicBool = AtomicBool::new(false);

/// Opaque seed client.
///
/// Cheap to clone — the inner state lives behind an [`Arc`].
#[derive(Debug, Clone)]
pub struct SeedClient {
    inner: Arc<SeedInner>,
}

#[derive(Debug)]
pub(crate) struct SeedInner {
    pub(crate) http: reqwest::Client,
    pub(crate) peers: PeerSet,
    pub(crate) auth: SeedAuth,
    pub(crate) timeouts: Timeouts,
    pub(crate) max_retries: u32,
    /// Current routing mode. Phase 1 always stores `Routing::Pinned`;
    /// retained so Phase 1.5 can swap the selection logic without
    /// changing the struct layout.
    #[allow(dead_code)]
    pub(crate) routing: Routing,
}

impl SeedClient {
    /// Start a fluent builder.
    pub fn builder() -> SeedClientBuilder {
        SeedClientBuilder::default()
    }

    // -- resource accessors -------------------------------------------------

    /// `/api/v1/pair*` resource.
    pub fn pair(&self) -> PairResource<'_> {
        PairResource { client: self }
    }

    /// `/api/v1/store/*` resource.
    pub fn store(&self) -> StoreResource<'_> {
        StoreResource { client: self }
    }

    /// `/api/v1/witness/*` resource.
    pub fn witness(&self) -> WitnessResource<'_> {
        WitnessResource { client: self }
    }

    /// `/api/v1/custody/*` resource.
    pub fn custody(&self) -> CustodyResource<'_> {
        CustodyResource { client: self }
    }

    /// `/api/v1/ota/*` resource.
    pub fn ota(&self) -> OtaResource<'_> {
        OtaResource { client: self }
    }

    // -- top-level conveniences --------------------------------------------

    /// `GET /api/v1/status` — combined device / optimizer / delivery
    /// snapshot. Allowlisted read per ADR-0003 §"WiFi-read allowlist".
    pub async fn status(&self) -> Result<super::models::Status, Error> {
        self.request_get("/status").await
    }

    /// `GET /api/v1/identity` — immutable identity document. Allowlisted read.
    pub async fn identity(&self) -> Result<super::models::Identity, Error> {
        self.request_get("/identity").await
    }

    // -- internal HTTP helpers ---------------------------------------------

    #[allow(dead_code)]
    pub(crate) fn inner(&self) -> &SeedInner {
        &self.inner
    }

    pub(crate) async fn request_get<T: DeserializeOwned>(&self, path: &str) -> Result<T, Error> {
        self.request::<T, ()>(Method::GET, path, None, false).await
    }

    pub(crate) async fn request_post<T, B>(
        &self,
        path: &str,
        body: &B,
        idempotent: bool,
    ) -> Result<T, Error>
    where
        T: DeserializeOwned,
        B: Serialize + ?Sized,
    {
        self.request::<T, &B>(Method::POST, path, Some(body), idempotent)
            .await
    }

    pub(crate) async fn request_delete<T: DeserializeOwned>(&self, path: &str) -> Result<T, Error> {
        self.request::<T, ()>(Method::DELETE, path, None, false)
            .await
    }

    async fn request<T, B>(
        &self,
        method: Method,
        path: &str,
        body: Option<B>,
        idempotent: bool,
    ) -> Result<T, Error>
    where
        T: DeserializeOwned,
        B: Serialize,
    {
        let started = Instant::now();
        let mut attempt: u32 = 0;

        // Phase 1: always the primary endpoint. Mesh routing is rejected
        // at build time, so `PeerSet::primary()` is the single peer.
        let endpoint = self.inner.peers.primary();
        let url = endpoint.join_api(path)?;

        loop {
            if started.elapsed() > self.inner.timeouts.total {
                return Err(Error::Api {
                    code: 0,
                    message: "seed: total deadline exceeded".into(),
                });
            }

            let mut req = self.inner.http.request(method.clone(), url.clone());

            if let SeedAuth::PairingToken(tok) = &self.inner.auth {
                req = req.header("X-Pairing-Token", tok.as_str());
            }
            req = req.header(reqwest::header::ACCEPT, "application/json");

            if let Some(b) = body.as_ref() {
                req = req.json(b);
            }

            let send_result = req.send().await;

            match send_result {
                Ok(response) => {
                    let status = response.status();
                    if status.is_success() {
                        // 204 → empty body: try to deserialize a unit tuple;
                        // fallback to explicit null-body handler.
                        return parse_success::<T>(response).await;
                    }

                    // Eagerly read body so retry-after parsing has it.
                    let headers = response.headers().clone();
                    let body_text = response.text().await.unwrap_or_default();

                    if retry::should_retry(&method, status, idempotent)
                        && attempt < self.inner.max_retries
                    {
                        let hint = retry::parse_retry_after(&headers, &body_text);
                        let delay = delay_for(attempt, hint);
                        if started.elapsed() + delay > self.inner.timeouts.total {
                            return Err(seed_err::from_response(status, &body_text, path));
                        }
                        tokio::time::sleep(delay).await;
                        attempt += 1;
                        continue;
                    }

                    return Err(seed_err::from_response(status, &body_text, path));
                }
                Err(e) => {
                    // Transport error. Retry on any method if attempts remain
                    // and we're still inside the total budget. POST-without-
                    // idempotency still gets retried on pure connect failures
                    // per ADR-0005 ("connection refused / TLS failure"),
                    // which is exactly what surfaces here when the body
                    // was never accepted.
                    let retriable = e.is_connect() || e.is_timeout() || e.is_request();
                    if retriable && attempt < self.inner.max_retries {
                        let delay = retry::compute_delay(
                            attempt,
                            retry::DEFAULT_BASE_MS,
                            retry::DEFAULT_CAP_MS,
                        );
                        if started.elapsed() + delay > self.inner.timeouts.total {
                            return Err(Error::from(e));
                        }
                        tokio::time::sleep(delay).await;
                        attempt += 1;
                        continue;
                    }
                    return Err(Error::from(e));
                }
            }
        }
    }
}

fn delay_for(attempt: u32, server_hint: Option<Duration>) -> Duration {
    let computed = retry::compute_delay(attempt, retry::DEFAULT_BASE_MS, retry::DEFAULT_CAP_MS);
    match server_hint {
        Some(hint) => {
            std::cmp::max(hint, computed).min(Duration::from_millis(retry::DEFAULT_CAP_MS))
        }
        None => computed,
    }
}

async fn parse_success<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, Error> {
    let status = response.status();
    let text = response.text().await?;

    if status == StatusCode::NO_CONTENT || text.is_empty() {
        // Try to deserialize "null" for `Option<T>` / unit-like responses.
        return serde_json::from_str::<T>("null")
            .or_else(|_| serde_json::from_str::<T>("{}"))
            .map_err(Error::from);
    }

    serde_json::from_str::<T>(&text).map_err(Error::from)
}

/// Fluent builder for [`SeedClient`].
#[derive(Debug, Clone, Default)]
pub struct SeedClientBuilder {
    endpoints: Vec<String>,
    auth: SeedAuth,
    tls: SeedTls,
    timeouts: Timeouts,
    routing: Routing,
    max_retries: Option<u32>,
}

impl SeedClientBuilder {
    /// Single endpoint (Phase 1 default).
    pub fn endpoint(mut self, url: impl Into<String>) -> Self {
        self.endpoints = vec![url.into()];
        self
    }

    /// Multiple endpoints (Phase 1.5). Accepted at builder-time but
    /// rejected at [`build`](Self::build) unless `routing == Pinned` with
    /// exactly one element.
    pub fn endpoints<S: AsRef<str>>(mut self, urls: &[S]) -> Self {
        self.endpoints = urls.iter().map(|u| u.as_ref().to_owned()).collect();
        self
    }

    /// Attach a pairing token / mTLS cert.
    pub fn auth(mut self, auth: SeedAuth) -> Self {
        self.auth = auth;
        self
    }

    /// Configure TLS posture.
    pub fn tls(mut self, tls: SeedTls) -> Self {
        self.tls = tls;
        self
    }

    /// Override the default timeouts.
    pub fn timeouts(mut self, timeouts: Timeouts) -> Self {
        self.timeouts = timeouts;
        self
    }

    /// Routing strategy — Phase 1 only accepts [`Routing::Pinned`].
    pub fn routing(mut self, routing: Routing) -> Self {
        self.routing = routing;
        self
    }

    /// Max retries per request (default: 3).
    pub fn max_retries(mut self, n: u32) -> Self {
        self.max_retries = Some(n);
        self
    }

    /// Build the client.
    pub fn build(self) -> Result<SeedClient, Error> {
        if self.endpoints.is_empty() {
            return Err(Error::Validation(
                "SeedClient: at least one .endpoint(...) is required".into(),
            ));
        }

        // Phase 1: only Routing::Pinned is implemented.
        if self.routing != Routing::Pinned {
            return Err(seed_err::not_implemented("mesh-routing"));
        }
        if self.endpoints.len() > 1 {
            return Err(seed_err::not_implemented("mesh-routing"));
        }

        let endpoint = Endpoint::parse(&self.endpoints[0])?;
        let peers = PeerSet::single(endpoint);

        let http = build_http_client(&self.tls, &self.timeouts)?;

        Ok(SeedClient {
            inner: Arc::new(SeedInner {
                http,
                peers,
                auth: self.auth,
                timeouts: self.timeouts,
                max_retries: self.max_retries.unwrap_or(3),
                routing: self.routing,
            }),
        })
    }
}

fn build_http_client(tls: &SeedTls, timeouts: &Timeouts) -> Result<reqwest::Client, Error> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(timeouts.connect)
        .timeout(timeouts.read)
        .redirect(reqwest::redirect::Policy::none())
        .pool_idle_timeout(Some(Duration::from_secs(60)));

    match tls {
        SeedTls::System => {
            // Reqwest default trust store.
        }
        SeedTls::Pinned(pem) => {
            let cert = reqwest::Certificate::from_pem(pem)
                .map_err(|e| Error::Validation(format!("invalid seed trust root PEM: {e}")))?;
            builder = builder
                .tls_built_in_root_certs(false)
                .add_root_certificate(cert);
        }
        SeedTls::Insecure => {
            if !INSECURE_WARN.swap(true, Ordering::Relaxed) {
                // Prefer `log::warn!` style via eprintln — we intentionally
                // do not introduce a log-facade dep in Phase 1.
                eprintln!(
                    "cognitum-rs seed: TLS verification is DISABLED via \
                     SeedTls::Insecure. Never use this in production — \
                     prefer SeedTls::Pinned for self-signed seeds (ADR-0007)."
                );
            }
            builder = builder.danger_accept_invalid_certs(true);
        }
    }

    builder
        .build()
        .map_err(|e| Error::Validation(format!("seed http client: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_rejects_empty_endpoints() {
        let err = SeedClient::builder().build().unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
    }

    #[test]
    fn builder_rejects_mesh_routing() {
        let err = SeedClient::builder()
            .endpoint("https://s:8443")
            .routing(Routing::Balanced)
            .build()
            .unwrap_err();
        match err {
            Error::Validation(m) => assert!(m.contains("mesh-routing")),
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[test]
    fn builder_rejects_multi_endpoint_in_phase1() {
        let err = SeedClient::builder()
            .endpoints(&["https://s1:8443", "https://s2:8443"])
            .build()
            .unwrap_err();
        match err {
            Error::Validation(m) => assert!(m.contains("mesh-routing")),
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[test]
    fn builder_builds_with_system_tls() {
        let client = SeedClient::builder()
            .endpoint("https://cognitum.local:8443")
            .tls(SeedTls::System)
            .build()
            .expect("system-TLS seed client should build");
        assert_eq!(client.inner().peers.len(), 1);
    }

    #[test]
    fn builder_builds_with_insecure_tls() {
        let client = SeedClient::builder()
            .endpoint("https://localhost:18443")
            .tls(SeedTls::Insecure)
            .build()
            .expect("insecure seed client should build");
        assert_eq!(client.inner().peers.len(), 1);
    }

    #[test]
    fn builder_rejects_invalid_endpoint() {
        let err = SeedClient::builder()
            .endpoint("not a url")
            .build()
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
    }

    #[test]
    fn builder_accepts_pinned_tls_bytes() {
        // `reqwest::Certificate::from_pem` is lazy on this version and
        // accepts garbage without erroring. We only assert that the
        // plumbing path is exercised. Live-seed integration and the
        // mutually-exclusive TLS test in `client.rs` cover the runtime
        // failure mode.
        let result = SeedClient::builder()
            .endpoint("https://seed:8443")
            .tls(SeedTls::Pinned(b"not a real pem".to_vec()))
            .build();
        match result {
            Ok(_) => {}
            Err(Error::Validation(msg)) => {
                assert!(msg.contains("trust root"), "got: {msg}");
            }
            Err(other) => panic!("unexpected: {other:?}"),
        }
    }
}
