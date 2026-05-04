# @cognitum-one/sdk

Official [Cognitum](https://cognitum.one) SDK for Node.js and TypeScript.

Talk to a **Cognitum Seed** appliance (direct, over mDNS / USB gadget / LAN)
or the **Cognitum Cloud** control plane (`api.cognitum.one`).

## Install

```bash
npm install @cognitum-one/sdk
# optional: mDNS discovery
npm install multicast-dns
```

Requires Node.js `>=18`.

## Quick start — talking to a Seed

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
- Node-specific ADRs: [`docs/adr/`](docs/adr/)
- Changelog: [`CHANGELOG.md`](CHANGELOG.md)

## License

MIT — see [`LICENSE`](LICENSE).
