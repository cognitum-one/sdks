# cognitum

Official [Cognitum](https://cognitum.one) SDK for Python.

Talk to a **Cognitum Seed** appliance (direct, over mDNS / USB gadget / LAN)
or the **Cognitum Cloud** control plane (`api.cognitum.one`).

## Install

```bash
pip install cognitum
# optional: mDNS discovery
pip install "cognitum[mdns]"
```

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

## Documentation

- Cross-cutting: [`../../docs/adr/`](../../docs/adr/)
- Python-specific ADRs: [`docs/adr/`](docs/adr/)
- Changelog: [`CHANGELOG.md`](CHANGELOG.md)

## License

MIT — see [`LICENSE`](LICENSE).
