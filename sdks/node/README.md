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

## Agentic layer (v0.3)

Bounded clients for Meta-LLM, Meta-Proxy, HarnessaaS, and MetaHarness, plus a
shared agentic contract layer, all additive to the Seed/Cloud client above.

```ts
import { MetaLlmClient } from "@cognitum-one/sdk/meta-llm";
import { StaticApiKeyCredentialProvider } from "@cognitum-one/sdk/agentic";

const llm = new MetaLlmClient({
  baseUrl: "https://api.cognitum.one",
  credentialProvider: new StaticApiKeyCredentialProvider({
    product: "meta-llm",
    normalizedOrigin: "https://api.cognitum.one",
    audience: "cognitum.meta-llm",
  }), // reads COGNITUM_API_KEY by default
});

for await (const event of llm.chat.completionsStream({
  model: "cognitum-meta-llm",
  messages: [{ role: "user", content: "hello" }],
})) {
  if (event.type === "content_delta") process.stdout.write(event.delta);
}
```

| Namespace | Maturity | Notes |
|---|---|---|
| `@cognitum-one/sdk/agentic` | Available | Credentials, typed errors/retry, receipts + lineage, redaction, W3C trace context. Telemetry primitives are public/tested but no product client wires them into a live emission path yet. |
| `@cognitum-one/sdk/meta-llm` | Available | 5 serving protocols, OpenAI/Anthropic SSE streaming, routing, receipts. Platform resources (batches, pods, Brain, …) are REST-only — [issue #59](https://github.com/cognitum-one/sdks/issues/59). |
| `@cognitum-one/sdk/meta-proxy` | Available | Local status/capabilities + chat.completions forwarding (streaming + non-streaming), consent-gated cloud routing. |
| `@cognitum-one/sdk/harnessaas` | Available | Real synchronous `health` / `solve` / `lineage`. No async job/poll/approval contract exists upstream yet. |
| `@cognitum-one/sdk/metaharness` | Contract preview | Full typed surface, every call fail-closed — no published local bridge protocol yet. |

See [`../../capabilities/sdk-release.v1.json`](../../capabilities/sdk-release.v1.json)
for the full, machine-readable maturity/feature matrix across all 3 SDKs.

## Documentation

- Cross-cutting: [`../../docs/adr/`](../../docs/adr/)
- Node-specific ADRs: [`docs/adr/`](docs/adr/)
- Changelog: [`CHANGELOG.md`](CHANGELOG.md)

## License

MIT — see [`LICENSE`](LICENSE).
