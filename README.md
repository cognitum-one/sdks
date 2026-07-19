# Cognitum SDKs

Official SDKs for the **Cognitum** platform — ship against the **Cognitum Seed**
appliance (direct, over mDNS / USB gadget / LAN) or the **Cognitum Cloud**
control plane (`api.cognitum.one`).

One surface. Three runtimes.

| Language | Package | Version | Install |
|----------|---------|---------|---------|
| Node.js / TypeScript | [`@cognitum-one/sdk`](sdks/node/) | 0.3.0 | `npm install @cognitum-one/sdk` |
| Python | [`cognitum-sdk`](sdks/python/) (import as `cognitum`) | 0.3.0 | `pip install cognitum-sdk` |
| Rust | [`cognitum-one`](sdks/rust/) | 0.3.0 | `cognitum-one = "0.3"` |

> The Python **distribution** name is `cognitum-sdk` (the PyPI project name
> `cognitum` belongs to an unrelated third party) but the **import** name is
> still `cognitum` — `pip install cognitum-sdk`, then `from cognitum import ...`.

All three SDKs implement the same domain model, the same HTTP contract, and
the same failover / security / observability invariants — they differ only
where the host runtime makes a different idiom natural.

Package identifiers, registry versions, and per-capability maturity are also
published as a machine-readable manifest:
[`capabilities/sdk-release.v1.json`](capabilities/sdk-release.v1.json)
(validated against [`capabilities/sdk-release.schema.json`](capabilities/sdk-release.schema.json)
and cross-checked against live npm/PyPI/crates.io in CI — see
[`scripts/verify-release-manifest.mjs`](scripts/verify-release-manifest.mjs)).

## Quick start — talking to a Seed

### Node

```ts
import { SeedClient } from "@cognitum-one/sdk/seed";

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
  `@cognitum-one/sdk/seed/discovery/mdns` · `pip install cognitum-sdk[mdns]` ·
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

## Agentic layer (v0.3)

Additive to the Seed/Cloud surface above: bounded clients for Meta-LLM,
Meta-Proxy, HarnessaaS, and MetaHarness, plus a shared agentic contract layer
(credentials, typed errors/retry, receipts, redaction, trace context). Every
SDK exposes the same namespace shape (`<pkg>/agentic`, `<pkg>/meta-llm`, …) —
see each per-language README for exact import paths.

Maturity uses one shared vocabulary across all three SDKs and the
[cognitum.one developer portal](https://cognitum.one/developers):

| State | Meaning |
|---|---|
| **Available** | Published package, implemented network behavior. |
| **Source available** | On the SDK main branch, not yet confirmed in the public registry artifact. |
| **Contract preview** | Typed API that deliberately fails closed — its runtime bridge isn't available yet. |
| **Planned** | No supported client behavior yet. |

| Capability | Maturity | What it does |
|---|---|---|
| **Agentic core** | Available | Credential providers (API key + OAuth), scope preflight, typed error/retry taxonomy, execution receipts + lineage verification, secret redaction, W3C trace context. Telemetry primitives (sink interface, event/metric catalog) are public and tested but not yet wired into a live emission path. |
| **Meta-LLM** | Available | Real HTTP client for all 6 serving protocols (chat.completions, messages.create, messages.countTokens, completions, responses, embeddings), OpenAI + Anthropic SSE streaming, routing controls, receipts. Platform resources (batches, pods, Brain, vectors, …) are REST-only for now — [issue #59](https://github.com/cognitum-one/sdks/issues/59). |
| **Meta-Proxy** | Available | Local data-plane status/capabilities discovery and chat.completions forwarding (streaming + non-streaming), consent-gated cloud routing. Sponsor/budget lifecycle is not yet implemented. |
| **HarnessaaS** | Available | Real synchronous `health` / `solve` / `lineage` calls against the deployed API. The async job/poll/approval contract some ADRs describe does not exist upstream yet. |
| **MetaHarness** | Contract preview | Full typed method surface, every operation fail-closed by design — there is no published local bridge protocol for it to call yet. Do not represent any method as functional until that changes. |

The full detail (per-language namespaces, feature flags, governing ADRs,
known gaps) lives in
[`capabilities/sdk-release.v1.json`](capabilities/sdk-release.v1.json).

## Choosing an SDK

| You want to… | Use |
|--------------|-----|
| Hit a seed from a browser, edge worker, or Node service | `@cognitum-one/sdk` |
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

MIT. Every SDK package carries its own `LICENSE` file matching the root
`LICENSE`; the licence applies identically.
