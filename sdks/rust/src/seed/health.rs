//! Active health probe (ADR-0016a §D7, opt-in).
//!
//! Off by default. When the caller passes `Duration` to
//! [`SeedClientBuilder::health_interval`](super::client::SeedClientBuilder::health_interval),
//! a `tokio` task spawns alongside the client and pings
//! `GET /api/v1/status` on every configured peer on the given interval.
//! Outcomes feed [`PeerSet::mark_success`] / [`mark_failure`] so routing
//! reflects the probe view even when the caller is idle.
//!
//! The task aborts when the owning [`SeedClient`](super::SeedClient) is
//! dropped — the shutdown channel in [`HealthHandle`] closes and the
//! loop wakes up to exit.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use super::peers::{PeerErrorClass, PeerSet};

/// Background-probe handle.
///
/// Owned by `SeedInner`; dropping it fires the shutdown signal and joins
/// the task so the runtime has a clean exit point.
#[derive(Debug)]
pub(crate) struct HealthHandle {
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl HealthHandle {
    pub(crate) fn spawn(
        http: reqwest::Client,
        peers: Arc<Mutex<PeerSet>>,
        interval: Duration,
    ) -> Self {
        let (tx, rx) = oneshot::channel();
        let task = tokio::spawn(probe_loop(http, peers, interval, rx));
        Self {
            shutdown: Some(tx),
            task: Some(task),
        }
    }
}

impl Drop for HealthHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn probe_loop(
    http: reqwest::Client,
    peers: Arc<Mutex<PeerSet>>,
    interval: Duration,
    mut shutdown: oneshot::Receiver<()>,
) {
    loop {
        tokio::select! {
            _ = &mut shutdown => return,
            _ = tokio::time::sleep(interval) => {}
        }

        // Snapshot the endpoint list so we don't hold the lock across
        // `await` points. Probe URLs are cheap to rebuild per iteration.
        let targets: Vec<(String, reqwest::Url)> = {
            match peers.lock() {
                Ok(guard) => guard
                    .peers()
                    .iter()
                    .filter_map(|p| {
                        p.endpoint
                            .join_api("/status")
                            .ok()
                            .map(|u| (p.endpoint.key(), u))
                    })
                    .collect(),
                Err(_) => return,
            }
        };

        for (key, url) in targets {
            let started = Instant::now();
            let result = http
                .get(url.clone())
                .header(reqwest::header::ACCEPT, "application/json")
                .send()
                .await;

            match result {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_success() {
                        if let Ok(mut guard) = peers.lock() {
                            guard.mark_success(&key, started.elapsed());
                        }
                    } else if let Ok(mut guard) = peers.lock() {
                        let class = match status.as_u16() {
                            503 => PeerErrorClass::ServiceUnavailable,
                            500 | 502 | 504 => PeerErrorClass::Server5xx,
                            // 4xx on an unauthenticated status probe usually
                            // means the peer is up but refusing us — don't
                            // mark unhealthy in that case.
                            _ => continue,
                        };
                        guard.mark_failure(&key, class);
                    }
                }
                Err(e) => {
                    let class = if e.is_timeout() {
                        PeerErrorClass::Timeout
                    } else {
                        PeerErrorClass::Network
                    };
                    if let Ok(mut guard) = peers.lock() {
                        guard.mark_failure(&key, class);
                    }
                }
            }
        }
    }
}
