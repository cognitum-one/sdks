# cognitum

Official [Cognitum](https://cognitum.one) SDK for Python.

Talk to a **Cognitum Seed** appliance (direct, over mDNS / USB gadget / LAN)
or the **Cognitum Cloud** control plane (`api.cognitum.one`).

## Install

```bash
pip install cognitum-sdk
# optional: mDNS discovery
pip install "cognitum-sdk[mdns]"
```

> The PyPI **distribution** name is `cognitum-sdk` (the project name
> `cognitum` on PyPI belongs to an unrelated third party) but the **import**
> name is `cognitum` — install with `pip install cognitum-sdk`, then
> `from cognitum import ...` as shown below.

Requires Python `>=3.10`.

## Quick start — talking to a Seed

```python
from cognitum.seed import SeedClient, SeedTLS

client = SeedClient(
    endpoints="https://cognitum.local:8443",
    tls=SeedTLS(insecure=True),  # dev-only
)

status = client.status()
print(f"seed {status.device_id}, epoch {status.epoch}")

result = client.store.query(vector=[0.1, 0.2, 0.8], k=3)
```

An `AsyncSeedClient` is available with the same surface for async codebases.

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
- Lazy `__getattr__` keeps cold start fast when only `cognitum.seed` is used

## Agentic layer (v0.3)

Bounded clients for Meta-LLM, Meta-Proxy, HarnessaaS, and MetaHarness, plus a
shared agentic contract layer, all additive to the Seed/Cloud client above.

```python
from cognitum.agentic import StaticApiKeyCredentialProvider
from cognitum.meta_llm import ChatCompletionRequest, ChatMessage, MetaLlmClient, MetaLlmClientConfig

llm = MetaLlmClient(
    MetaLlmClientConfig(
        base_url="https://api.cognitum.one",
        credential_provider=StaticApiKeyCredentialProvider(
            product="meta-llm",
            normalized_origin="https://api.cognitum.one",
            audience="cognitum.meta-llm",
        ),  # reads COGNITUM_API_KEY by default
    )
)

request = ChatCompletionRequest(
    model="cognitum-meta-llm",
    messages=[ChatMessage(role="user", content="hello")],
)
async for event in llm.chat.completions_stream(request):
    if event.type == "content_delta":
        print(event.delta, end="")
```

| Namespace | Maturity | Notes |
|---|---|---|
| `cognitum.agentic` | Available | Credentials, typed errors/retry, receipts + lineage, redaction, W3C trace context. Telemetry primitives are public/tested but no product client wires them into a live emission path yet. |
| `cognitum.meta_llm` | Available | 5 serving protocols, OpenAI/Anthropic SSE streaming, routing, receipts. Platform resources (batches, pods, Brain, …) are REST-only — [issue #59](https://github.com/cognitum-one/sdks/issues/59). |
| `cognitum.meta_proxy` | Available | Local status/capabilities + chat.completions forwarding (streaming + non-streaming), consent-gated cloud routing. |
| `cognitum.harnessaas` | Available | Real synchronous `health` / `solve` / `lineage`. No async job/poll/approval contract exists upstream yet. |
| `cognitum.metaharness` | Contract preview | Full typed surface, every call fail-closed — no published local bridge protocol yet. |

See [`../../capabilities/sdk-release.v1.json`](../../capabilities/sdk-release.v1.json)
for the full, machine-readable maturity/feature matrix across all 3 SDKs.

## Documentation

- Cross-cutting: [`../../docs/adr/`](../../docs/adr/)
- Python-specific ADRs: [`docs/adr/`](docs/adr/)
- Changelog: [`CHANGELOG.md`](CHANGELOG.md)

## License

MIT — see [`LICENSE`](LICENSE).
