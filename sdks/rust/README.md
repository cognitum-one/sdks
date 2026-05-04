# cognitum-one

Official [Cognitum](https://cognitum.one) SDK for Rust.

Talk to a **Cognitum Seed** appliance (direct, over mDNS / USB gadget / LAN)
or the **Cognitum Cloud** control plane (`api.cognitum.one`).

## Install

```toml
[dependencies]
cognitum-one = { version = "0.2", features = ["seed"] }
# mesh + mDNS discovery
cognitum-one = { version = "0.2", features = ["seed", "mdns"] }
```

## Quick start — talking to a Seed

```rust
use cognitum::seed::{SeedClient, SeedTls};

let client = SeedClient::builder()
    .endpoint("https://cognitum.local:8443")
    .tls(SeedTls::Insecure)       // dev-only
    .build()?;

let status = client.status().await?;
println!("seed {} epoch {}", status.device_id, status.epoch);

let result = client.store().query(StoreQuery {
    vector: vec![0.1, 0.2, /*...*/ 0.8],
    k: 3,
}).await?;
```

## Feature flags

| Flag | Default | Purpose |
|------|---------|---------|
| `rustls` | yes | `rustls` TLS via `reqwest/rustls-tls` |
| `native-tls` | no | `native-tls` alternative |
| `seed` | no | Seed client surface (`cognitum::seed::*`) |
| `mdns` | no | mDNS discovery provider (implies `seed`) |
| `stream` | no | SSE streaming via `eventsource-stream` (implies `seed`) |
| `blocking` | no | Blocking `reqwest` client |
| `live-seed-tests` | no | Opt-in integration tests against a real seed |

## Features

- 12 typed seed endpoints (status, pair, witness, custody, store, OTA, …)
- Mesh routing with closest-first, session-sticky reads, failover on 5xx
- `client.mesh()` observability wrappers (status / peers / swarm / cluster)
- Per-call `CallOptions` — `peer` / `prefer` / `consistency` / `timeout` / `retries`
- Discovery providers: `ExplicitDiscovery`, `MdnsDiscovery`, `TailscaleDiscovery`
- TLS — explicit CA, `fp=sha256:<hex>` cert pinning, or dev-only `insecure`
- Trust-score 3-strike cutoff; redacting `SecretString` around pairing tokens
- ADR-0005 retry / rate-limit (500 ms base, 30 s cap, 60 s wall-clock)
- MCP client with both HTTP and stdio transports

## Documentation

- Cross-cutting: [`../../docs/adr/`](../../docs/adr/)
- Rust-specific ADRs: [`docs/adr/`](docs/adr/)
- Changelog: [`CHANGELOG.md`](CHANGELOG.md)

## License

MIT — see [`LICENSE`](LICENSE).
