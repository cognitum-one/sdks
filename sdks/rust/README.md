# cognitum-one

Official [Cognitum](https://cognitum.one) SDK for Rust.

Talk to a **Cognitum Seed** appliance (direct, over mDNS / USB gadget / LAN)
or the **Cognitum Cloud** control plane (`api.cognitum.one`).

## Install

```toml
[dependencies]
cognitum-one = { version = "0.3", features = ["seed"] }
# mesh + mDNS discovery
cognitum-one = { version = "0.3", features = ["seed", "mdns"] }
# agentic layer: Meta-LLM, Meta-Proxy, HarnessaaS, MetaHarness
cognitum-one = { version = "0.3", features = ["meta-llm", "meta-proxy", "harnessaas", "metaharness"] }
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
| `meta-llm` | no | Meta-LLM client (`cognitum_one::meta_llm::*`) |
| `meta-proxy` | no | Meta-Proxy client (`cognitum_one::meta_proxy::*`) |
| `harnessaas` | no | HarnessaaS client (`cognitum_one::harnessaas::*`) |
| `metaharness` | no | MetaHarness contract-preview client (`cognitum_one::metaharness::*`) |
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

## Agentic layer (v0.3)

Bounded clients for Meta-LLM, Meta-Proxy, HarnessaaS, and MetaHarness, plus a
shared agentic contract layer (unconditional, no feature flag needed), all
additive to the Seed/Cloud client above.

```rust
use std::sync::Arc;

use cognitum_one::agentic::StaticApiKeyCredentialProvider;
use cognitum_one::meta_llm::types::{ChatCompletionRequest, ChatMessage, ChatMessageContent, ChatRole};
use cognitum_one::meta_llm::{MetaLlmClient, MetaLlmClientConfig, OpenAiStreamEvent};

let llm = MetaLlmClient::new(MetaLlmClientConfig {
    credential_provider: Some(Arc::new(StaticApiKeyCredentialProvider::new(
        "meta-llm",
        "https://api.cognitum.one",
        "https://api.cognitum.one", // audience must match base_url (ADR-0022 §D3)
        Default::default(), // reads COGNITUM_API_KEY by default
    )?)),
    ..MetaLlmClientConfig::new("https://api.cognitum.one")
})?;

let request = ChatCompletionRequest {
    model: "cognitum-meta-llm".into(),
    messages: vec![ChatMessage {
        role: ChatRole::User,
        content: Some(ChatMessageContent::Text("hello".into())),
        name: None,
        tool_call_id: None,
        tool_calls: None,
    }],
    max_tokens: None, temperature: None, top_p: None, n: None, stream: None, stop: None,
    presence_penalty: None, frequency_penalty: None, logit_bias: None, user: None,
    tools: None, tool_choice: None, response_format: None, seed: None, routing_controls: None,
};
let mut stream = llm.chat_completions_stream(&request, None, None).await?;
// pull with next_envelope() -- this isn't a futures::Stream, see the method's doc comment.
// The event lives on envelope.event -- the envelope itself only carries metadata
// (sequence, received_at, request_id, ...), never the event fields directly.
while let Some(envelope) = stream.next_envelope().await? {
    if let OpenAiStreamEvent::ContentDelta { delta, .. } = envelope.event {
        print!("{delta}");
    }
}
```

| Module | Feature flag | Maturity | Notes |
|---|---|---|---|
| `cognitum_one::agentic` | none (always available) | Available | Credentials, typed errors/retry, receipts + lineage, redaction, W3C trace context. Telemetry primitives are public/tested but no product client wires them into a live emission path yet. |
| `cognitum_one::meta_llm` | `meta-llm` | Available | 6 serving protocols, OpenAI/Anthropic SSE streaming, routing, receipts. Platform resources (batches, pods, Brain, …) are REST-only — [issue #59](https://github.com/cognitum-one/sdks/issues/59). |
| `cognitum_one::meta_proxy` | `meta-proxy` | Available | Local status/capabilities + chat.completions forwarding (streaming + non-streaming), consent-gated cloud routing. |
| `cognitum_one::harnessaas` | `harnessaas` | Available | Real synchronous `health` / `solve` / `lineage`. No async job/poll/approval contract exists upstream yet. |
| `cognitum_one::metaharness` | `metaharness` | Contract preview | Full typed surface, every call fail-closed — no published local bridge protocol yet. |

See [`../../capabilities/sdk-release.v1.json`](../../capabilities/sdk-release.v1.json)
for the full, machine-readable maturity/feature matrix across all 3 SDKs.

## Documentation

- Cross-cutting: [`../../docs/adr/`](../../docs/adr/)
- Rust-specific ADRs: [`docs/adr/`](docs/adr/)
- Changelog: [`CHANGELOG.md`](CHANGELOG.md)

## License

MIT — see [`LICENSE`](LICENSE).
