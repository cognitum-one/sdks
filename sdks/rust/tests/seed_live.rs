//! Live-seed integration tests, gated on `--features live-seed-tests`.
//!
//! These run against a real seed reachable at `https://localhost:18443`,
//! which assumes an SSH tunnel is in place. Without the tunnel, each
//! test prints a skip message and returns Ok.
//!
//! Tunnel recipe (run on ruvultra):
//!
//! ```bash
//! ssh -f -N -o BatchMode=yes -L 18443:169.254.42.1:8443 cohen@100.123.117.38
//! ```

#![cfg(feature = "live-seed-tests")]

use std::time::Duration;

use cognitum_rs::seed::{
    PairCreate, SeedAuth, SeedClient, SeedTls, StoreIngest, StoreIngestEntry, StoreQuery,
};

const SEED_URL: &str = "https://localhost:18443";
const TUNNEL_HOST: &str = "localhost";
const TUNNEL_PORT: u16 = 18443;

async fn tunnel_open() -> bool {
    match tokio::time::timeout(
        Duration::from_millis(500),
        tokio::net::TcpStream::connect((TUNNEL_HOST, TUNNEL_PORT)),
    )
    .await
    {
        Ok(Ok(_)) => true,
        _ => {
            eprintln!(
                "\nskipping live-seed tests — no SSH tunnel to seed on \
                 {TUNNEL_HOST}:{TUNNEL_PORT}.\n\
                 recipe:\n    \
                 ssh -f -N -o BatchMode=yes -L 18443:169.254.42.1:8443 \
                 cohen@100.123.117.38"
            );
            false
        }
    }
}

fn client() -> SeedClient {
    SeedClient::builder()
        .endpoint(SEED_URL)
        .auth(SeedAuth::None)
        .tls(SeedTls::Insecure) // live seed has a self-signed cert
        .max_retries(1)
        .build()
        .expect("live seed client builds")
}

/// Be polite per `CLAUDE.local.md` §"Rate limits" — ≤1 req/s across tests.
async fn pace() {
    tokio::time::sleep(Duration::from_millis(1100)).await;
}

#[tokio::test]
async fn phase1_end_to_end() {
    if !tunnel_open().await {
        return;
    }

    let c = client();

    // -- allowlisted reads (no token) ----------------------------------
    let status = c.status().await.expect("GET /status");
    println!(
        "status: device_id={}, paired={}",
        status.device_id, status.paired
    );
    pace().await;

    let identity = c.identity().await.expect("GET /identity");
    println!("identity: {}", identity.device_id);
    pace().await;

    let _ = c.pair().status().await.expect("GET /pair/status");
    pace().await;
    let _ = c.witness().chain().await.expect("GET /witness/chain");
    pace().await;
    let _ = c.custody().epoch().await.expect("GET /custody/epoch");
    pace().await;
    let _ = c.store().status().await.expect("GET /store/status");
    pace().await;
    let _ = c.ota().config().await.expect("GET /ota/config");
    pace().await;

    // -- pair, then paired writes, then unpair -------------------------
    let pair_status = c.pair().status().await.expect("GET /pair/status (2)");
    if !pair_status.pairing_window_open {
        eprintln!(
            "live test: pairing window not open — skipping write tests. \
             Open the window via a trusted path first."
        );
        return;
    }

    let created = c
        .pair()
        .create(PairCreate {
            client_name: format!("rust-sdk-live-{}", std::process::id()),
        })
        .await
        .expect("POST /pair");
    pace().await;

    let paired = SeedClient::builder()
        .endpoint(SEED_URL)
        .auth(SeedAuth::pairing_token(created.token.as_str().to_owned()))
        .tls(SeedTls::Insecure)
        .max_retries(1)
        .build()
        .expect("paired client builds");

    // read + write with the pairing token
    let _ = paired.store().status().await.expect("paired store status");
    pace().await;
    let _ = paired
        .store()
        .query(StoreQuery {
            vector: vec![0.0; status.dimension as usize],
            k: 3,
        })
        .await
        .expect("POST /store/query");
    pace().await;
    let _ = paired
        .store()
        .ingest(StoreIngest {
            vectors: vec![StoreIngestEntry {
                id: "rust-sdk-live-vec-1".into(),
                values: vec![0.1; status.dimension as usize],
                metadata: None,
            }],
        })
        .await
        .expect("POST /store/ingest");
    pace().await;
    let _ = paired.ota().check_now().await.expect("POST /ota/check-now");
    pace().await;

    // cleanup: unpair
    paired
        .pair()
        .delete(&created.client_name)
        .await
        .expect("DELETE /pair/{name}");
}
