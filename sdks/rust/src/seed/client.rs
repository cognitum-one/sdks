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

use super::config::{CallOptions, Consistency, Prefer, Routing, SeedAuth, SeedTls, Timeouts};
use super::discovery::{DiscoveredPeer, Discovery};
use super::error as seed_err;
use super::health::HealthHandle;
use super::peers::{Endpoint, Peer, PeerErrorClass, PeerSet};
use super::resources::{
    CustodyResource, MeshResource, OtaResource, PairResource, StoreResource, WitnessResource,
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
    /// Optional [`Discovery`] provider for dynamic peer resolution
    /// (ADR-0016a §D6, Phase 3). When set, [`SeedClient::rediscover`]
    /// calls the provider and rebuilds the `PeerSet` from the result;
    /// when `None`, `rediscover()` falls back to the Phase 2 behaviour
    /// of resetting the existing `PeerSet` to a clean `Healthy` state.
    pub(crate) discovery: Option<Arc<dyn Discovery>>,
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

    /// Mesh observability resource (Phase 2 — ADR-0016a §D8).
    ///
    /// Wraps `GET /api/v1/network/mesh/status`, `/peers`, `/swarm/status`,
    /// and `/cluster/health` — all allowlisted reads on v0.20.0.
    pub fn mesh(&self) -> MeshResource<'_> {
        MeshResource { client: self }
    }

    /// Reset the per-peer routing state (Phase 2 — ADR-0016b) or re-run
    /// the configured [`Discovery`] provider (Phase 3 — ADR-0016a §D6).
    ///
    /// * When the builder was given a [`Discovery`] via
    ///   [`SeedClientBuilder::discovery`], this call invokes
    ///   [`Discovery::discover`] and rebuilds the `PeerSet` from the
    ///   returned list. Any session pin whose URL is present in the new
    ///   list survives; pins that drop out become dangling and the next
    ///   request on that session falls back to the session's resolved
    ///   peer (ADR-0016a §D9). An empty list fails with
    ///   `Error::Validation` — the SDK refuses to be left with zero
    ///   routable peers.
    /// * When no [`Discovery`] is configured, behaves as before: marks
    ///   every peer `Healthy`, zeros `consecutive_failures`, and clears
    ///   `latency_ema_ms` / `last_used_at`. No network I/O.
    ///
    /// Idempotent in the provider-less case. With a provider, each call
    /// performs I/O and may return transient `Error::Api { code: 0, ... }`
    /// errors; callers SHOULD be prepared to retry or fall back to the
    /// existing `PeerSet` (which this function leaves unchanged on
    /// failure).
    pub async fn rediscover(&self) -> Result<(), Error> {
        if let Some(ref d) = self.inner.discovery {
            let new_peers = d.discover().await?;
            if new_peers.is_empty() {
                return Err(Error::Validation(
                    "seed: Discovery returned zero peers; refusing to reset PeerSet".into(),
                ));
            }
            self.rebuild_peer_set(&new_peers)?;
        } else {
            let mut guard = self.inner.peers.lock().map_err(|_| Error::Api {
                code: 0,
                message: "seed: peers lock poisoned".into(),
            })?;
            guard.rediscover();
        }
        Ok(())
    }

    /// Replace the live `PeerSet` with one built from `discovered`. New
    /// peers start in `Healthy` with cleared EMAs; peers present in both
    /// sets retain no state (the caller asked for a fresh probe — see
    /// `PeerSet::rediscover`). TokenBook entries for dropped peers are
    /// left in place so a rediscovery race that transiently drops a peer
    /// doesn't lose its pairing token.
    fn rebuild_peer_set(&self, discovered: &[DiscoveredPeer]) -> Result<(), Error> {
        let endpoints = discovered
            .iter()
            .map(|p| Endpoint::parse(&p.url))
            .collect::<Result<Vec<_>, _>>()?;
        let new_set = PeerSet::new(endpoints)?;
        let mut guard = self.inner.peers.lock().map_err(|_| Error::Api {
            code: 0,
            message: "seed: peers lock poisoned".into(),
        })?;
        *guard = new_set;
        // `SeedSession::pinned_peer` holds a canonical URL string; we
        // don't touch it here — if the pinned URL is still present in
        // `guard`, `find_by_key` will resolve it on the next dispatch.
        // If it dropped out, `SeedClient::pick_peer` falls through to
        // the closest-first picker (documented behaviour in the type
        // doc above).
        Ok(())
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

    /// `GET /api/v1/status` with per-call [`CallOptions`] overrides
    /// (Phase 2 — ADR-0016b).
    pub async fn status_with(&self, opts: CallOptions) -> Result<super::models::Status, Error> {
        self.request_get_opts("/status", &opts).await
    }

    /// `GET /api/v1/identity` — immutable identity document. Allowlisted read.
    pub async fn identity(&self) -> Result<super::models::Identity, Error> {
        self.request_get("/identity").await
    }

    /// `GET /api/v1/identity` with per-call [`CallOptions`] overrides.
    pub async fn identity_with(&self, opts: CallOptions) -> Result<super::models::Identity, Error> {
        self.request_get_opts("/identity", &opts).await
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

    /// `GET` with per-call [`CallOptions`] overrides (Phase 2). Resolves
    /// `opts` into a concrete pinned peer / max_retries override then
    /// dispatches via the existing request loop.
    pub(crate) async fn request_get_opts<T: DeserializeOwned>(
        &self,
        path: &str,
        opts: &CallOptions,
    ) -> Result<T, Error> {
        let pin = self.resolve_call_options(opts)?;
        self.request::<T, ()>(Method::GET, path, None, false, pin.as_deref())
            .await
    }

    /// `POST` with per-call [`CallOptions`] overrides (Phase 2).
    pub(crate) async fn request_post_opts<T, B>(
        &self,
        path: &str,
        body: &B,
        idempotent: bool,
        opts: &CallOptions,
    ) -> Result<T, Error>
    where
        T: DeserializeOwned,
        B: Serialize + ?Sized,
    {
        let pin = self.resolve_call_options(opts)?;
        self.request::<T, &B>(Method::POST, path, Some(body), idempotent, pin.as_deref())
            .await
    }

    /// Turn a [`CallOptions`] into a concrete `Option<peer_key>` that the
    /// existing request loop understands. Returns:
    ///
    /// * `Err` if the caller asked for `Consistency::Strong` (no quorum)
    ///   or named an unknown peer URL.
    /// * `Ok(Some(key))` for `CallOptions::peer` or when `prefer` picks
    ///   a non-default peer.
    /// * `Ok(None)` to fall through to the existing closest-first picker.
    fn resolve_call_options(&self, opts: &CallOptions) -> Result<Option<String>, Error> {
        // `Strong` is unsupported per ADR-0016b §"Per-call knobs".
        if let Some(Consistency::Strong) = opts.consistency {
            return Err(seed_err::unsupported(
                "strong consistency unsupported; seed has no quorum",
            ));
        }

        // `peer` wins over every other preference. Validate it against
        // the PeerSet up front so callers see a clean config error rather
        // than a confused 404 / network timeout.
        if let Some(peer) = opts.peer.as_deref() {
            let guard = self.inner.peers.lock().map_err(|_| Error::Api {
                code: 0,
                message: "seed: peers lock poisoned".into(),
            })?;
            let key = match guard.find_by_key(peer) {
                Some(p) => p.endpoint.key(),
                None => {
                    // Also accept a trailing-slash / scheme-trivia mismatch
                    // by parsing through `Endpoint::parse`. Keep the error
                    // shape the caller asked for (`peer not in mesh: …`).
                    return Err(seed_err::config(&format!("peer not in mesh: {peer}")));
                }
            };
            return Ok(Some(key));
        }

        // `prefer` tweaks the peer picker for this call only. We do NOT
        // mutate the PeerSet — we resolve the chosen peer's key once and
        // let the request loop treat it as a pinned peer.
        if let Some(prefer) = opts.prefer {
            let guard = self.inner.peers.lock().map_err(|_| Error::Api {
                code: 0,
                message: "seed: peers lock poisoned".into(),
            })?;
            let key = match prefer {
                Prefer::Closest | Prefer::Any => guard.pick().endpoint.key(),
                Prefer::LocalFirst => guard.pick_local_first().endpoint.key(),
                Prefer::Random => guard.pick_random().endpoint.key(),
            };
            return Ok(Some(key));
        }

        // `Consistency::Eventual` bypasses any session stickiness. The
        // top-level `SeedClient` has no session pin to bypass (that lives
        // on `SeedSession`), so this is a no-op here; `SeedSession` calls
        // `request_get_opts` through its own helper that drops the pin.
        Ok(None)
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

        // #23: serialize the body exactly once, outside the retry loop.
        // On every attempt / peer cycle we clone the resulting `Vec<u8>`
        // (a cheap memcpy) instead of re-entering `serde_json` — which
        // allocates, walks the whole struct, and re-runs every
        // `#[serde(...)]` hook. For typed `POST` bodies this was the
        // single largest per-attempt cost in the bench.
        let body_bytes: Option<Vec<u8>> = match body.as_ref() {
            Some(b) => Some(serde_json::to_vec(b).map_err(Error::from)?),
            None => None,
        };

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

            if let Some(bytes) = body_bytes.as_ref() {
                // Pre-serialized: set content-type and ship the raw bytes.
                req = req
                    .header(reqwest::header::CONTENT_TYPE, "application/json")
                    .body(bytes.clone());
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
    discovery: Option<Arc<dyn Discovery>>,
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
            .field("discovery", &self.discovery.is_some())
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

    /// Install a [`Discovery`] provider (ADR-0016a §D6). When set,
    /// [`SeedClient::rediscover`] invokes the provider and rebuilds the
    /// `PeerSet` from the returned list.
    ///
    /// Mutually exclusive with [`Self::endpoints`] / [`Self::endpoint`]:
    /// `.discovery(...)` seeds the initial list from the provider's
    /// first `discover()` call inside `build()`. Calling
    /// `.endpoints(...)` afterwards is still permitted — the explicit
    /// list wins for the initial `PeerSet` while the provider remains
    /// armed for later `rediscover()` calls.
    pub fn discovery<D: Discovery + 'static>(mut self, discovery: D) -> Self {
        self.discovery = Some(Arc::new(discovery));
        self
    }

    /// Install a pre-boxed [`Discovery`] provider. Useful when the
    /// provider type is erased at a higher layer (e.g. a plugin).
    pub fn discovery_arc(mut self, discovery: Arc<dyn Discovery>) -> Self {
        self.discovery = Some(discovery);
        self
    }

    /// Build the client.
    pub fn build(self) -> Result<SeedClient, Error> {
        // If the caller went the Phase 3 route (`.discovery(...)` without
        // an explicit list), seed the initial `PeerSet` from the
        // provider synchronously. We use `tokio::runtime::Handle::block_on`
        // when inside a runtime, or a one-shot runtime otherwise — this
        // keeps `build()` infallibly synchronous the way the rest of the
        // builder expects, and lets us surface config errors (e.g. empty
        // mDNS response) at construction time instead of lurking until
        // the first request.
        //
        // We keep the full `Vec<DiscoveredPeer>` around (not just the
        // URL list) so the builder can feed any `tls_fingerprint=`
        // advertisements into `FingerprintPinVerifier` alongside the
        // PeerSet construction.
        let mut endpoints_str = self.endpoints.clone();
        let mut discovered_peers: Vec<DiscoveredPeer> = Vec::new();
        if endpoints_str.is_empty() {
            if let Some(ref d) = self.discovery {
                let discovered = block_on_discover(d.as_ref())?;
                if discovered.is_empty() {
                    return Err(Error::Validation(
                        "SeedClient: Discovery returned zero peers at build time".into(),
                    ));
                }
                endpoints_str = discovered.iter().map(|p| p.url.clone()).collect();
                discovered_peers = discovered;
            }
        }

        if endpoints_str.is_empty() {
            return Err(Error::Validation(
                "SeedClient: at least one .endpoint(...) or .discovery(...) is required".into(),
            ));
        }

        let endpoints = endpoints_str
            .iter()
            .map(|s| Endpoint::parse(s))
            .collect::<Result<Vec<_>, _>>()?;

        let peer_set = PeerSet::new(endpoints)?;
        let peers = Arc::new(Mutex::new(peer_set));
        let http = build_http_client(&self.tls, &self.timeouts, &discovered_peers)?;

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
                discovery: self.discovery,
            }),
        })
    }
}

/// Drive a `Discovery::discover()` call from the synchronous builder.
///
/// Always runs on a freshly-spawned thread with its own current-thread
/// tokio runtime. This avoids "cannot block the current thread from
/// within a runtime" panics no matter which runtime flavour (if any) is
/// active on the caller's thread, and keeps the builder infallibly
/// synchronous. The thread is short-lived — it lives only for the
/// duration of the discover call, which mDNS caps at ~2s by default.
fn block_on_discover(d: &dyn Discovery) -> Result<Vec<DiscoveredPeer>, Error> {
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|e| Error::Validation(format!("seed: rt build: {e}")))?;
                rt.block_on(d.discover())
            })
            .join()
            .map_err(|_| Error::Api {
                code: 0,
                message: "seed: discovery thread panicked".into(),
            })?
    })
}

fn build_http_client(
    tls: &SeedTls,
    timeouts: &Timeouts,
    discovered: &[DiscoveredPeer],
) -> Result<reqwest::Client, Error> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(timeouts.connect)
        .timeout(timeouts.read)
        .redirect(reqwest::redirect::Policy::none())
        .pool_idle_timeout(Some(Duration::from_secs(60)));

    // Collect any `fp=` fingerprints surfaced by discovery. A non-empty
    // pin map activates `FingerprintPinVerifier` — see ADR-0014c
    // §"fp= cert pinning" for the precedence rules.
    let pins = super::tls_pin::build_pin_map(discovered)
        .map_err(|e| Error::Validation(format!("seed: invalid peer URL during pin map: {e}")))?;

    match tls {
        SeedTls::Pinned(pem) => {
            // Explicit pinned CA trumps per-peer fingerprint pinning —
            // the caller has asked for a named CA and we honour that
            // verbatim. Fingerprints from discovery are ignored.
            let cert = reqwest::Certificate::from_pem(pem)
                .map_err(|e| Error::Validation(format!("invalid seed trust root PEM: {e}")))?;
            builder = builder
                .tls_built_in_root_certs(false)
                .add_root_certificate(cert);
        }
        SeedTls::System if !pins.is_empty() => {
            // System trust + per-peer fingerprint pins. Build a rustls
            // ClientConfig backed by webpki-roots and install our
            // FingerprintPinVerifier as the custom verifier.
            let verifier = super::tls_pin::FingerprintPinVerifier::with_webpki_roots(pins)
                .map_err(|e| Error::Validation(format!("seed: fingerprint verifier: {e}")))?;
            builder = install_rustls_verifier(builder, verifier)?;
        }
        SeedTls::Insecure if !pins.is_empty() => {
            // Insecure + fingerprint pins — pinned peers are verified
            // strictly; unknown peers are waved through. This keeps
            // dev-on-seed setups that mix pinned mDNS-discovered peers
            // with a locally-mocked wiremock working.
            if !INSECURE_WARN.swap(true, Ordering::Relaxed) {
                eprintln!(
                    "cognitum-rs seed: TLS verification is DISABLED via \
                     SeedTls::Insecure. Never use this in production — \
                     prefer SeedTls::Pinned for self-signed seeds (ADR-0007)."
                );
            }
            let verifier = super::tls_pin::FingerprintPinVerifier::with_insecure_fallback(pins);
            builder = install_rustls_verifier(builder, verifier)?;
        }
        SeedTls::System => {}
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

/// Build a rustls `ClientConfig` that uses `verifier` and hand it to
/// reqwest via `use_preconfigured_tls`. The crypto provider falls back
/// to the process-wide default if one has been installed; otherwise we
/// install `rustls::crypto::ring` so a test binary that never touches
/// the process-wide default still gets a working ClientConfig.
fn install_rustls_verifier(
    builder: reqwest::ClientBuilder,
    verifier: super::tls_pin::FingerprintPinVerifier,
) -> Result<reqwest::ClientBuilder, Error> {
    use rustls::crypto::CryptoProvider;
    // Ensure a CryptoProvider is installed. The builder below calls
    // `.with_safe_default_protocol_versions()` which panics if no
    // default provider is available. `install_default` is a no-op if
    // one is already set — and it ignores `Err` to tolerate the
    // double-install case in tests.
    if CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    let config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    Ok(builder.use_preconfigured_tls(config))
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

    /// #23 regression: the request body is serialized exactly once —
    /// even when the retry loop cycles three attempts. A custom
    /// `Serialize` impl bumps a counter; we then drive a POST that
    /// 503s twice (cycles) then 200s, and assert the counter is `1`.
    ///
    /// Before the fix, `req.json(&b)` was called on every attempt, so
    /// the counter would equal the number of attempts.
    #[tokio::test]
    async fn post_body_serialized_once_across_retries() {
        use std::sync::atomic::{AtomicUsize, Ordering as SerdeOrd};
        use std::sync::Arc as StdArc;
        use wiremock::matchers::{method as wmethod, path as wpath};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        // Counter-backed Serialize: bumps on every `serialize` call.
        struct CountingBody {
            counter: StdArc<AtomicUsize>,
        }

        impl serde::Serialize for CountingBody {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                self.counter.fetch_add(1, SerdeOrd::Relaxed);
                // Emit a minimal valid JSON object so downstream parsing
                // (wiremock match / reqwest body) stays happy.
                use serde::ser::SerializeMap;
                let mut m = s.serialize_map(Some(1))?;
                m.serialize_entry("probe", "1")?;
                m.end()
            }
        }

        let server = MockServer::start().await;
        // Two 503s (idempotent POST → cycles/retries), then 200.
        Mock::given(wmethod("POST"))
            .and(wpath("/api/v1/store/query"))
            .respond_with(ResponseTemplate::new(503).set_body_string("{}"))
            .up_to_n_times(2)
            .mount(&server)
            .await;
        Mock::given(wmethod("POST"))
            .and(wpath("/api/v1/store/query"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"results": [], "query_ms": 0.0})),
            )
            .expect(1)
            .mount(&server)
            .await;

        let client = SeedClient::builder()
            .endpoint(server.uri())
            .tls(SeedTls::System)
            .max_retries(3)
            .build()
            .unwrap();

        let counter = StdArc::new(AtomicUsize::new(0));
        let body = CountingBody {
            counter: StdArc::clone(&counter),
        };

        // `store/query` is declared idempotent, so 503 cycles through
        // the retry/backoff path after the peer list is exhausted.
        let _: serde_json::Value = client
            .request_post("/store/query", &body, true)
            .await
            .expect("eventual success");

        assert_eq!(
            counter.load(SerdeOrd::Relaxed),
            1,
            "body serialized more than once — retry loop re-serialized \
             per attempt (regression on #23)"
        );
    }
}
