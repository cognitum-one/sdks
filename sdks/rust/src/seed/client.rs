//! [`SeedClient`] and its fluent [`SeedClientBuilder`].
//!
//! The client composes over a locally-built `reqwest::Client` — it does
//! NOT reuse the cloud [`crate::Client`] because cloud defaults to
//! `X-API-Key` and `https://api.cognitum.one`, and the seed has a
//! different auth header (`X-Pairing-Token`) and host (`https://<seed>:8443`).
//!
//! Phase 1.5 delivery:
//!
//! * 1..N endpoints via `.endpoint(...)` / `.endpoints([...])`.
//! * Per-peer `TokenBook` (`InMemoryTokenBook` default).
//! * Session-sticky routing (closest-first) with failover that cycles on
//!   `NetworkError` / `5xx` / `503`, pins on `429`, and surfaces auth /
//!   validation / not-found immediately.
//! * Opt-in active health probe via `.health_interval(Duration)`.
//! * `.session()` handle that pins one peer for the life of the handle.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::Error;

use super::config::{Routing, SeedAuth, SeedTls, Timeouts};
use super::error as seed_err;
use super::health::HealthHandle;
use super::peers::{Endpoint, Peer, PeerErrorClass, PeerSet};
use super::resources::{
    CustodyResource, OtaResource, PairResource, StoreResource, WitnessResource,
};
use super::retry;
use super::session::SeedSession;
use super::token_book::{SharedTokenBook, TokenBook};

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
    pub(crate) peers: Arc<Mutex<PeerSet>>,
    pub(crate) auth: SeedAuth,
    pub(crate) timeouts: Timeouts,
    pub(crate) max_retries: u32,
    /// Routing mode captured at build-time. Current impl routes per D2
    /// semantics regardless of the concrete variant, but the field is
    /// kept so per-call override in Phase 2 has somewhere to read from.
    #[allow(dead_code)]
    pub(crate) routing: Routing,
    pub(crate) token_book: SharedTokenBook,
    /// Active health probe handle. `None` when `.health_interval` is
    /// unset. Dropped with the client to stop the task.
    #[allow(dead_code)]
    pub(crate) health: Option<HealthHandle>,
    /// Per-peer consecutive-auth-failure counter (ADR-0007 §Trust-score
    /// protection, [cognitum-one/sdks#16]). Keyed by
    /// [`Endpoint::key`](super::peers::Endpoint::key).
    ///
    /// Incremented on every `Error::Auth(_)` returned from a call on the
    /// peer; reset to 0 on a 2xx. When the counter hits 3, the request
    /// loop returns [`seed_err::trust_score_blocked`] for that peer and
    /// the mesh failover state machine does NOT cycle — the seed has
    /// already locked the peer out.
    ///
    /// [cognitum-one/sdks#16]: https://github.com/cognitum-one/sdks/issues/16
    pub(crate) auth_failure_counts: Mutex<BTreeMap<String, u32>>,
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

    /// Open a [`SeedSession`] pinned to the currently closest-first peer.
    ///
    /// The session holds the pin for its lifetime; all its resource calls
    /// go to the same peer unless the peer fails hard, in which case the
    /// failover state machine transparently cycles (per ADR-0016a §D3).
    pub fn session(&self) -> SeedSession<'_> {
        let pinned_peer = {
            let guard = self.inner.peers.lock().expect("peers lock poisoned");
            guard.pick().endpoint.key()
        };
        SeedSession {
            client: self,
            pinned_peer,
        }
    }

    /// Snapshot view of the SDK-local peer table (ADR-0016a §D7 —
    /// `client.peers()`).
    pub fn peers(&self) -> Vec<Peer> {
        let guard = self.inner.peers.lock().expect("peers lock poisoned");
        guard.peers().to_vec()
    }

    /// Introspection helper for tests: look up a pairing token by
    /// canonical peer URL. Returns `None` when the book has no entry.
    #[doc(hidden)]
    pub fn token_for_peer(&self, peer_key: &str) -> Option<String> {
        self.inner
            .token_book
            .get(peer_key)
            .map(|s| s.as_str().to_owned())
    }

    /// Current trust-score auth-failure counter for `peer_key`. Returns 0
    /// when the peer has no recorded failures. Intended for tests /
    /// observability per ADR-0007 §Trust-score protection.
    #[doc(hidden)]
    pub fn trust_score_failures(&self, peer_key: &str) -> u32 {
        self.inner
            .auth_failure_counts
            .lock()
            .ok()
            .and_then(|g| g.get(peer_key).copied())
            .unwrap_or(0)
    }

    /// Reset the trust-score counter for one peer (when `peer_url` is
    /// `Some`) or for every peer (when `None`). Exposed for tests and
    /// operator recovery flows — production code SHOULD NOT need to call
    /// this; the counter resets on the next 2xx response from the peer.
    #[doc(hidden)]
    pub fn reset_trust_score(&self, peer_url: Option<&str>) {
        if let Ok(mut guard) = self.inner.auth_failure_counts.lock() {
            match peer_url {
                Some(key) => {
                    guard.remove(key);
                }
                None => guard.clear(),
            }
        }
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
        self.request::<T, ()>(Method::GET, path, None, false, None)
            .await
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
        self.request::<T, &B>(Method::POST, path, Some(body), idempotent, None)
            .await
    }

    pub(crate) async fn request_delete<T: DeserializeOwned>(&self, path: &str) -> Result<T, Error> {
        self.request::<T, ()>(Method::DELETE, path, None, false, None)
            .await
    }

    pub(crate) async fn request_on_peer_get<T: DeserializeOwned>(
        &self,
        path: &str,
        pinned: Option<&str>,
    ) -> Result<T, Error> {
        self.request::<T, ()>(Method::GET, path, None, false, pinned)
            .await
    }

    pub(crate) async fn request_on_peer_post<T, B>(
        &self,
        path: &str,
        body: &B,
        idempotent: bool,
        pinned: Option<&str>,
    ) -> Result<T, Error>
    where
        T: DeserializeOwned,
        B: Serialize + ?Sized,
    {
        self.request::<T, &B>(Method::POST, path, Some(body), idempotent, pinned)
            .await
    }

    /// Pick a peer — prefer `pinned` if supplied, else use
    /// [`PeerSet::pick`]. Returns the owned endpoint so we don't hold
    /// the peers lock across awaits.
    fn pick_peer(&self, pinned: Option<&str>) -> Result<Endpoint, Error> {
        let guard = self.inner.peers.lock().map_err(|_| Error::Api {
            code: 0,
            message: "seed: peers lock poisoned".into(),
        })?;
        let ep = match pinned.and_then(|k| guard.find_by_key(k)) {
            Some(p) => p.endpoint.clone(),
            None => guard.pick().endpoint.clone(),
        };
        Ok(ep)
    }

    fn next_peer(&self, failed_key: &str) -> Option<Endpoint> {
        let guard = self.inner.peers.lock().ok()?;
        let failed_peer = guard.find_by_key(failed_key)?.clone();
        guard.next_after(&failed_peer).map(|p| p.endpoint.clone())
    }

    async fn request<T, B>(
        &self,
        method: Method,
        path: &str,
        body: Option<B>,
        idempotent: bool,
        pinned: Option<&str>,
    ) -> Result<T, Error>
    where
        T: DeserializeOwned,
        B: Serialize,
    {
        let started = Instant::now();
        let mut attempt: u32 = 0;
        let mut peer = self.pick_peer(pinned)?;
        // Track how many distinct peers we've tried during this logical
        // request so we can surface the last error instead of looping
        // through an unbounded mesh.
        let total_peers = self.peer_count();
        let mut peers_tried: usize = 0;
        let mut last_err: Option<Error> = None;

        loop {
            if started.elapsed() > self.inner.timeouts.total {
                return Err(last_err.unwrap_or(Error::Api {
                    code: 0,
                    message: "seed: total deadline exceeded".into(),
                }));
            }

            let peer_key = peer.key();
            let url = peer.join_api(path)?;
            let call_started = Instant::now();

            let mut req = self.inner.http.request(method.clone(), url.clone());

            // Per-peer pairing token from TokenBook wins over the
            // client-wide SeedAuth (ADR-0016a §D5).
            if let Some(tok) = self.inner.token_book.get(&peer_key) {
                req = req.header("X-Pairing-Token", tok.as_str());
            } else if let SeedAuth::PairingToken(tok) = &self.inner.auth {
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
                        self.mark_peer_success(&peer_key, call_started.elapsed());
                        // Trust-score protection (#16): a 2xx clears the
                        // per-peer auth-failure counter so a transient 401
                        // followed by a successful retry doesn't poison it.
                        self.reset_auth_failures(&peer_key);
                        return parse_success::<T>(response).await;
                    }

                    let headers = response.headers().clone();
                    let body_text = response.text().await.unwrap_or_default();

                    // Classify for peer bookkeeping first.
                    if let Some(class) = classify_status(status) {
                        self.mark_peer_failure(&peer_key, class);
                    }

                    // Trust-score protection (#16, ADR-0007): bump the
                    // per-peer auth-failure counter when the mapped error
                    // is `Error::Auth(_)` (401/403). On the 3rd consecutive
                    // failure on the same peer, short-circuit with a
                    // `trust_score_blocked` error — no retry, no cycling.
                    if is_auth_status(status) {
                        let count = self.bump_auth_failures(&peer_key);
                        if count >= TRUST_SCORE_THRESHOLD {
                            return Err(seed_err::trust_score_blocked(&peer_key));
                        }
                    }

                    match dispatch_status_outcome(status) {
                        StatusOutcome::Cycle => {
                            peers_tried += 1;
                            last_err = Some(seed_err::from_response(status, &body_text, path));
                            if peers_tried >= total_peers {
                                // All peers tried at least once — fall
                                // through to ADR-0005 retry on the
                                // current (last) peer.
                                if retry::should_retry(&method, status, idempotent)
                                    && attempt < self.inner.max_retries
                                {
                                    let hint = retry::parse_retry_after(&headers, &body_text);
                                    let delay = delay_for(attempt, hint);
                                    if started.elapsed() + delay > self.inner.timeouts.total {
                                        return Err(last_err.take().unwrap_or_else(|| {
                                            seed_err::from_response(status, &body_text, path)
                                        }));
                                    }
                                    tokio::time::sleep(delay).await;
                                    attempt += 1;
                                    continue;
                                }
                                return Err(last_err.take().unwrap_or_else(|| {
                                    seed_err::from_response(status, &body_text, path)
                                }));
                            }
                            match self.next_peer(&peer_key) {
                                Some(next) => {
                                    peer = next;
                                    continue;
                                }
                                None => {
                                    return Err(seed_err::from_response(status, &body_text, path));
                                }
                            }
                        }
                        StatusOutcome::PinAndBackoff => {
                            // 429: stay on the same peer, honour ADR-0005
                            // budget. Do NOT cycle (trust-score protection).
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
                        StatusOutcome::Surface => {
                            // 4xx (auth/validation/not-found) or non-cyclable
                            // 5xx (501). Surface; don't touch peer state.
                            return Err(seed_err::from_response(status, &body_text, path));
                        }
                    }
                }
                Err(e) => {
                    let class = if e.is_timeout() {
                        PeerErrorClass::Timeout
                    } else {
                        PeerErrorClass::Network
                    };
                    self.mark_peer_failure(&peer_key, class);
                    last_err = Some(Error::from(reqwest_error_into_transport(e)));

                    peers_tried += 1;
                    if peers_tried < total_peers {
                        if let Some(next) = self.next_peer(&peer_key) {
                            peer = next;
                            continue;
                        }
                    }

                    // All peers attempted. Fall through to ADR-0005 retry
                    // on the most recent peer for POSTs (if idempotent /
                    // connection-phase failure) and all other methods.
                    if attempt < self.inner.max_retries {
                        let delay = retry::compute_delay(
                            attempt,
                            retry::DEFAULT_BASE_MS,
                            retry::DEFAULT_CAP_MS,
                        );
                        if started.elapsed() + delay > self.inner.timeouts.total {
                            return Err(last_err.take().unwrap_or(Error::Api {
                                code: 0,
                                message: "seed: transport exhausted".into(),
                            }));
                        }
                        tokio::time::sleep(delay).await;
                        attempt += 1;
                        peers_tried = 0; // reset for this budget round
                        continue;
                    }
                    return Err(last_err.take().unwrap_or(Error::Api {
                        code: 0,
                        message: "seed: transport exhausted".into(),
                    }));
                }
            }
        }
    }

    fn peer_count(&self) -> usize {
        self.inner.peers.lock().map(|g| g.len()).unwrap_or(1)
    }

    fn mark_peer_success(&self, peer_key: &str, latency: Duration) {
        if let Ok(mut guard) = self.inner.peers.lock() {
            guard.mark_success(peer_key, latency);
        }
    }

    fn mark_peer_failure(&self, peer_key: &str, class: PeerErrorClass) {
        if let Ok(mut guard) = self.inner.peers.lock() {
            guard.mark_failure(peer_key, class);
        }
    }

    /// Reset the auth-failure counter for `peer_key`. Called on every
    /// 2xx response so a single flaky auth failure (e.g. clock skew on
    /// the seed) doesn't permanently poison the peer.
    fn reset_auth_failures(&self, peer_key: &str) {
        if let Ok(mut guard) = self.inner.auth_failure_counts.lock() {
            guard.remove(peer_key);
        }
    }

    /// Increment the auth-failure counter for `peer_key` and return the
    /// new value. Returns 0 if the lock is poisoned (best-effort; the
    /// caller surfaces the underlying `Error::Auth` in that case).
    fn bump_auth_failures(&self, peer_key: &str) -> u32 {
        match self.inner.auth_failure_counts.lock() {
            Ok(mut guard) => {
                let n = guard.entry(peer_key.to_owned()).or_insert(0);
                *n = n.saturating_add(1);
                *n
            }
            Err(_) => 0,
        }
    }
}

/// High-level status-code disposition for the failover state machine.
enum StatusOutcome {
    /// Peer failed in a way that justifies trying another peer.
    Cycle,
    /// Keep the same peer and apply ADR-0005 backoff (429).
    PinAndBackoff,
    /// Surface to the caller (auth / validation / not-found / 501).
    Surface,
}

fn dispatch_status_outcome(status: StatusCode) -> StatusOutcome {
    match status.as_u16() {
        500 | 502 | 503 | 504 => StatusOutcome::Cycle,
        429 => StatusOutcome::PinAndBackoff,
        // 501 is non-retriable per ADR-0005; surface directly.
        _ => StatusOutcome::Surface,
    }
}

/// Whether `status` is the auth family (401 Unauthorized / 403 Forbidden).
/// Used by the trust-score counter to decide whether to bump the
/// per-peer auth-failure tally.
fn is_auth_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 401 | 403)
}

/// Trust-score abort threshold (ADR-0007 §Trust-score protection,
/// [cognitum-one/sdks#16]). The 3rd consecutive `Error::Auth(_)` on one
/// peer trips the circuit and the request loop returns a
/// `trust_score_blocked` error without retrying or cycling to another
/// peer.
///
/// [cognitum-one/sdks#16]: https://github.com/cognitum-one/sdks/issues/16
const TRUST_SCORE_THRESHOLD: u32 = 3;

fn classify_status(status: StatusCode) -> Option<PeerErrorClass> {
    match status.as_u16() {
        503 => Some(PeerErrorClass::ServiceUnavailable),
        500 | 502 | 504 => Some(PeerErrorClass::Server5xx),
        _ => None,
    }
}

fn reqwest_error_into_transport(e: reqwest::Error) -> reqwest::Error {
    // Pass-through: we just want to keep `Error::Http` semantics. Split
    // out for readability now that the request loop is larger.
    e
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
        return serde_json::from_str::<T>("null")
            .or_else(|_| serde_json::from_str::<T>("{}"))
            .map_err(Error::from);
    }

    serde_json::from_str::<T>(&text).map_err(Error::from)
}

/// Fluent builder for [`SeedClient`].
#[derive(Default)]
pub struct SeedClientBuilder {
    endpoints: Vec<String>,
    auth: SeedAuth,
    tls: SeedTls,
    timeouts: Timeouts,
    routing: Routing,
    max_retries: Option<u32>,
    token_book: Option<Box<dyn TokenBook>>,
    health_interval: Option<Duration>,
}

impl std::fmt::Debug for SeedClientBuilder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SeedClientBuilder")
            .field("endpoints", &self.endpoints)
            .field("auth", &self.auth)
            .field("tls", &self.tls)
            .field("timeouts", &self.timeouts)
            .field("routing", &self.routing)
            .field("max_retries", &self.max_retries)
            .field("token_book", &self.token_book.is_some())
            .field("health_interval", &self.health_interval)
            .finish()
    }
}

impl SeedClientBuilder {
    /// Single endpoint (Phase 1 default).
    pub fn endpoint(mut self, url: impl Into<String>) -> Self {
        self.endpoints = vec![url.into()];
        self
    }

    /// Multiple endpoints (Phase 1.5). Order is preserved as peer list
    /// index for tie-breaking in the closest-first picker.
    pub fn endpoints<S: AsRef<str>>(mut self, urls: &[S]) -> Self {
        self.endpoints = urls.iter().map(|u| u.as_ref().to_owned()).collect();
        self
    }

    /// Attach a pairing token. When `token_book` is also set, the
    /// per-peer TokenBook entries take priority.
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

    /// Routing strategy.
    pub fn routing(mut self, routing: Routing) -> Self {
        self.routing = routing;
        self
    }

    /// Max retries per request (default: 3).
    pub fn max_retries(mut self, n: u32) -> Self {
        self.max_retries = Some(n);
        self
    }

    /// Supply a per-peer [`TokenBook`]. Default is [`InMemoryTokenBook`].
    pub fn token_book<B: TokenBook + 'static>(mut self, book: B) -> Self {
        self.token_book = Some(Box::new(book));
        self
    }

    /// Enable the active health probe (ADR-0016a §D7). Disabled by
    /// default — the SDK observes outcomes opportunistically.
    pub fn health_interval(mut self, interval: Duration) -> Self {
        self.health_interval = Some(interval);
        self
    }

    /// Build the client.
    pub fn build(self) -> Result<SeedClient, Error> {
        if self.endpoints.is_empty() {
            return Err(Error::Validation(
                "SeedClient: at least one .endpoint(...) is required".into(),
            ));
        }

        let endpoints = self
            .endpoints
            .iter()
            .map(|s| Endpoint::parse(s))
            .collect::<Result<Vec<_>, _>>()?;

        let peer_set = PeerSet::new(endpoints)?;
        let peers = Arc::new(Mutex::new(peer_set));
        let http = build_http_client(&self.tls, &self.timeouts)?;

        let token_book = match self.token_book {
            Some(book) => SharedTokenBook::new_boxed(book),
            None => SharedTokenBook::default(),
        };
        // If caller supplied a single PairingToken via `.auth(...)`,
        // seed the TokenBook for every peer (ADR-0016a §D5 "single token
        // for all peers when the caller asserts they share").
        if let SeedAuth::PairingToken(tok) = &self.auth {
            let guard = peers.lock().expect("peers lock poisoned");
            for p in guard.peers() {
                if token_book.get(&p.endpoint.key()).is_none() {
                    token_book.set(&p.endpoint.key(), tok.clone());
                }
            }
        }

        let health = self
            .health_interval
            .map(|interval| HealthHandle::spawn(http.clone(), Arc::clone(&peers), interval));

        Ok(SeedClient {
            inner: Arc::new(SeedInner {
                http,
                peers,
                auth: self.auth,
                timeouts: self.timeouts,
                max_retries: self.max_retries.unwrap_or(3),
                routing: self.routing,
                token_book,
                health,
                auth_failure_counts: Mutex::new(BTreeMap::new()),
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
        SeedTls::System => {}
        SeedTls::Pinned(pem) => {
            let cert = reqwest::Certificate::from_pem(pem)
                .map_err(|e| Error::Validation(format!("invalid seed trust root PEM: {e}")))?;
            builder = builder
                .tls_built_in_root_certs(false)
                .add_root_certificate(cert);
        }
        SeedTls::Insecure => {
            if !INSECURE_WARN.swap(true, Ordering::Relaxed) {
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

// Convenience helpers so `SharedTokenBook` can accept a pre-boxed value
// from the builder path without allocating twice.
impl SharedTokenBook {
    pub(crate) fn new_boxed(book: Box<dyn TokenBook>) -> Self {
        Self::from_boxed(book)
    }
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
    fn builder_accepts_session_routing_with_mesh() {
        let client = SeedClient::builder()
            .endpoints(&["https://s1:8443", "https://s2:8443"])
            .routing(Routing::Session)
            .build()
            .expect("mesh builds");
        assert_eq!(client.inner().peers.lock().unwrap().len(), 2);
    }

    #[test]
    fn builder_accepts_multi_endpoint_phase_1_5() {
        let client = SeedClient::builder()
            .endpoints(&["https://s1:8443", "https://s2:8443", "https://s3:8443"])
            .build()
            .expect("three-peer mesh builds");
        assert_eq!(client.peers().len(), 3);
    }

    #[test]
    fn builder_builds_with_system_tls() {
        let client = SeedClient::builder()
            .endpoint("https://cognitum.local:8443")
            .tls(SeedTls::System)
            .build()
            .expect("system-TLS seed client should build");
        assert_eq!(client.peers().len(), 1);
    }

    #[test]
    fn builder_builds_with_insecure_tls() {
        let client = SeedClient::builder()
            .endpoint("https://localhost:18443")
            .tls(SeedTls::Insecure)
            .build()
            .expect("insecure seed client should build");
        assert_eq!(client.peers().len(), 1);
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

    #[test]
    fn builder_seeds_token_book_from_single_pairing_token() {
        let client = SeedClient::builder()
            .endpoints(&["https://a:8443", "https://b:8443"])
            .auth(SeedAuth::pairing_token("shared"))
            .build()
            .expect("build");
        assert_eq!(
            client
                .inner()
                .token_book
                .get("https://a:8443")
                .unwrap()
                .as_str(),
            "shared"
        );
        assert_eq!(
            client
                .inner()
                .token_book
                .get("https://b:8443")
                .unwrap()
                .as_str(),
            "shared"
        );
    }

    #[test]
    fn session_pins_peer_key() {
        let client = SeedClient::builder()
            .endpoints(&["https://a:8443", "https://b:8443"])
            .build()
            .unwrap();
        let session = client.session();
        assert!(
            session.pinned_peer() == "https://a:8443" || session.pinned_peer() == "https://b:8443"
        );
    }
}
