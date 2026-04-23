# Cognitum SDKs

Official SDKs for the **Cognitum** platform — ship against the **Cognitum Seed**
appliance (direct, over mDNS / USB gadget / LAN) or the **Cognitum Cloud**
control plane (`api.cognitum.one`).

One surface. Three runtimes.

<!-- final-review-note: the three manifests are currently at 0.1.3 (node),
     0.1.0 (python), 0.1.0 (rust). Version column below reflects those
     shipped numbers. Per-SDK ADRs (0015c, 0013c, 0014c) call 0.2.0 the
     next release that carries the pre-1.0 breaking changes (POST
     idempotent default flip, Error taxonomy additions). Bump manifests
     before tagging, or update this table if we cut 0.1.x patches
     carrying the Phase 2/3 surface. -->

| Language | Package | Version | Install |
|----------|---------|---------|---------|
| Node.js / TypeScript | [`@cognitum/sdk`](sdks/node/) | 0.1.3 | `npm install @cognitum/sdk` |
| Python | [`cognitum`](sdks/python/) | 0.1.0 | `pip install cognitum` |
| Rust | [`cognitum`](sdks/rust/) | 0.1.0 | `cognitum = "0.1"` |

All three SDKs implement the same domain model, the same HTTP contract, and
the same failover / security / observability invariants — they differ only
where the host runtime makes a different idiom natural.

## Quick start — talking to a Seed

### Node

```ts
import { SeedClient } from "@cognitum/sdk/seed";

const client = new SeedClient({
  endpoints: "https://cognitum.local:8443",
  tls: { insecure: true }, // dev-only; use tls.ca for production
});

const status = await client.status();
console.log(`seed ${status.deviceId}, epoch ${status.epoch}`);

const result = await client.store.query({ vector: [0.1, 0.2, /*...*/ 0.8], k: 3 });
```

### Python

```python
from cognitum.seed import SeedClient, SeedTLS

client = SeedClient(
    endpoints="https://cognitum.local:8443",
    tls=SeedTLS(insecure=True),  # dev-only
)

status = client.status()
print(f"seed {status.device_id}, epoch {status.epoch}")

result = client.store.query(vector=[0.1, 0.2, 0.8], k=3)

# async variant available as AsyncSeedClient with the same surface
```

### Rust

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

Full Rust usage gated behind `features = ["seed"]`; mesh via
`features = ["seed", "mdns"]`.

## Features at a glance

Every SDK ships — with parity tests:

- **71 seed endpoints** typed and wrapped (custody, optimizer/vector-store,
  delivery, pairing, sensor, coherence, thermal, OTA, mesh observability).
- **Mesh routing** — one `SeedClient` with 1..N peers, closest-first with
  session-sticky reads, failover cycles on 5xx/network errors, pins on 429,
  respects an ADR-0005 60 s wall-clock budget across all peer attempts.
- **`client.mesh()`** observability — `status` / `peers` / `swarm_status` /
  `cluster_health` wrapping the seed's mesh inspection endpoints.
- **Per-call `CallOptions`** — pin a specific peer, bias routing (`closest`/
  `local-first`/`random`/`any`), request `session`/`eventual` consistency,
  override `timeout` / `retries` per call.
- **Health probing** — opt-in background probe that marks slow peers
  `Degraded` and failed peers `Unhealthy`.
- **Discovery providers** — explicit list (default), **mDNS** (opt-in:
  `@cognitum/sdk/seed/discovery/mdns` · `pip install cognitum[mdns]` ·
  `cargo --features seed,mdns`), **Tailscale** (any tailnet peer matching
  `cognitum-*`).
- **TLS pinning** — three modes: explicit CA (`tls.ca` / `SeedTLS(ca_pem=...)` /
  `SeedTls::Pinned`), per-peer SHA-256 cert fingerprint advertised via mDNS
  `fp=sha256:<hex>` TXT, or dev-only `insecure`. Fingerprint mismatch is a
  hard `TlsPinError` — **never** falls back to insecure.
- **Trust-score protection** — 3rd consecutive 401/403 on a peer aborts
  with `TrustScoreBlockedError` to protect the seed's trust state. Per-peer
  counter; 2xx resets.
- **Secret handling** — pairing tokens and the response from `pair.create`
  are wrapped in a redacting `SecretString` type. `console.log(response)` /
  `repr(response)` / `format!("{:?}", response)` never leaks the raw value.
  Conformance tests pin the contract.
- **Retry / rate-limit** — equal-jitter backoff, base 500 ms, cap 30 s,
  60 s wall-clock ceiling. Honours `Retry-After` header **and** the seed's
  `retry_after_us` JSON body (body wins). POST methods do not auto-retry
  unless the caller opts in via `idempotent: true`.
- **MCP** — the SDKs include an MCP client with **both** HTTP and stdio
  transports. Use stdio to launch a local MCP server subprocess; use HTTP
  to talk to a remote MCP gateway.

## Choosing an SDK

| You want to… | Use |
|--------------|-----|
| Hit a seed from a browser, edge worker, or Node service | `@cognitum/sdk` |
| Glue Cognitum into a notebook, data pipeline, or research stack | `cognitum` (Python) |
| Ship a binary that talks to seeds — embedded, CLI tool, service | `cognitum` (Rust) |

## Surface map

```
seed/                       # Phase 1 — 12 endpoints per SDK, verified live
  status         identity
  pair.status    pair.create    pair.delete    pair.window
  witness.chain
  custody.epoch
  store.status   store.query    store.ingest
  ota.config     ota.checkNow

seed/mesh/                  # Phase 2 — observability
  mesh.status    mesh.peers    mesh.swarmStatus    mesh.clusterHealth

seed/ (advanced)            # Phase 2 — per-call knobs
  client.session()                        # sticky peer for a call chain
  client.peers()                          # SDK-local PeerSet snapshot
  client.rediscover()                     # re-resolve via provider
  resource.call({ peer, prefer, consistency, timeout, retries })
                                          # every resource method

mcp/                        # stdio + HTTP MCP transports
  McpClient(transport=StdioTransport(...))
  McpClient(transport=HttpTransport(...))

discovery/                  # Phase 3 — pluggable providers
  ExplicitDiscovery(urls)                 # default
  MdnsDiscovery(service_type="_cognitum._tcp.local.")
  TailscaleDiscovery(prefix="cognitum-")
```

## Configuration auth

Paired writes carry an `X-Pairing-Token` per seed (per-peer in mesh mode via
a `TokenBook`). Cloud calls carry `X-API-Key`. Each SDK resolves the key in
this order, stopping at the first hit:

1. Explicit constructor arg (`apiKey` / `api_key` / builder).
2. `COGNITUM_API_KEY` env var.
3. Hard error before the first request.

Pairing-token resolution is analogous (`pairingToken` arg, then
`COGNITUM_SEED_TOKEN` env, else require explicit `auto_pair`).

## Documentation

- **[Architecture Decision Records](docs/adr/)** — cross-cutting + per-SDK.
  Start with [`docs/adr/ddd/seed-domain.md`](docs/adr/ddd/seed-domain.md)
  (bounded contexts + ubiquitous language) and the
  [`docs/adr/README.md`](docs/adr/README.md) index.
- **[`docs/adr/0002-seed-wire-protocol.md`](docs/adr/0002-seed-wire-protocol.md)** —
  the HTTP contract (71 endpoints).
- **[`docs/adr/0016a-...md`](docs/adr/0016a-seed-client-configuration-single-and-mesh-decisions.md)** /
  **[`0016b-...md`](docs/adr/0016b-seed-client-configuration-signatures-and-lifecycle.md)** —
  the `SeedClient` configuration contract, single- and mesh-seed modes.
- **Per-SDK READMEs** live under each SDK's
  [`docs/adr/`](sdks/node/docs/adr/) folder.

## Support

- Issues: [`cognitum-one/sdks/issues`](https://github.com/cognitum-one/sdks/issues)
- Seed firmware: [`cognitum-one/seed`](https://github.com/cognitum-one/seed)
- Website: [cognitum.one](https://cognitum.one)

## License

Apache-2.0. Every SDK package carries its own `LICENSE` file; the licence
applies identically.
