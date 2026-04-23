# ADR 0016b: Seed Client Configuration — Signatures, Lifecycle, Compliance

- **Status:** Accepted
- **Date:** 2026-04-22
- **Scope:** cross-cutting (sdks/node, sdks/python, sdks/rust)
- **Split:** this ADR is 0016b of 0016 — language-agnostic signatures,
  per-language examples, mesh lifecycle, compliance tests. See
  ADR-0016a for the nine decisions (D1-D9) and rationale this document
  realises.

## Context

ADR-0016a locks nine decisions covering shape (D1), routing (D2),
failover (D3), consistency (D4), credentials (D5), discovery (D6),
health (D7), surface (D8), and type split (D9). This document (0016b)
is the contract implementers bind against: the language-agnostic
constructor and method signatures every SDK MUST expose, three
concrete per-language examples, the mesh lifecycle, and the
conformance test suite that proves each SDK implements ADR-0016a.

## Decision

### Language-agnostic signatures

Every SDK MUST expose a constructor and method set equivalent to the
signatures below. Names follow per-language convention; semantics are
identical across languages.

```
// Core
SeedClient.new(
    endpoints: Endpoint | [Endpoint],
    *,
    auth:        PairingToken | {Endpoint: PairingToken} | (Endpoint -> PairingToken) | None,
    tls:         TlsConfig | None,           // per ADR-0007
    timeouts:    Timeouts | None,            // per ADR-0002
    routing:     Routing = "session",        // "session" | "eventual" | "closest"
    failover:    Failover = Failover.default(),
    health:      Health = Health.opportunistic(),
    token_book:  TokenBook | None,           // default InMemoryTokenBook
    discovery:   Discovery | None,           // default: Explicit(endpoints)
) -> SeedClient

// Introspection
client.peers()                   -> [PeerHealth]       // SDK's view of configured peers
client.session(prefer: str | None = None) -> Session   // D9 session handle
client.rediscover()              -> ()                 // explicit, no scheduled rediscovery

// Resource methods (mirrored on Session with sticky pinning per D2/D4)
client.status()                  -> Status
client.identity()                -> Identity
client.pair.status()             -> PairStatus
client.pair.open(client_name)    -> PairingToken       // persists to TokenBook (D5)
client.pair.close(client_name)   -> ()                 // deletes from TokenBook (D5)
client.pair_all(client_name)     -> {Endpoint: PairingToken}  // iterates peers (D5)
client.store.status()            -> StoreStatus
client.store.ingest(vectors)     -> IngestResult
client.store.query(q)            -> [QueryResult]
client.store.delete(ids)         -> DeleteResult
client.witness.chain()           -> WitnessChain
client.custody.sign(payload)     -> Signature
client.custody.verify(sig, data) -> VerifyResult
client.custody.attestation()     -> Attestation

// Mesh observability (Phase 1 per D8)
client.mesh.status()     -> MeshStatus      // GET /api/v1/network/mesh/status
client.mesh.peers()      -> [Peer]          // GET /api/v1/peers
client.mesh.swarm()      -> SwarmStatus     // GET /api/v1/swarm/status
client.mesh.health()     -> ClusterHealth   // GET /api/v1/cluster/health
```

Note the two "peers" concepts:

- `client.peers()` is the SDK's local view of which configured
  endpoints are healthy (see ADR-0016a §D7).
- `client.mesh.peers()` is the seed's view of ITS peers on the
  overlay.

Both exist; they answer different questions. Naming MUST reflect the
difference in every SDK (Node `peers()` vs `mesh.peers()`, Python
`peers()` vs `mesh.peers()`, Rust `peers()` vs `mesh().peers()`).

### Per-call knobs

Every resource method accepts an optional per-call options bag:

| Option | Type | Effect |
|--------|------|--------|
| `peer` | `str` endpoint | Pin this single call to the named peer. Overrides routing. |
| `prefer` | `"closest"` \| `"round_robin"` \| `"first_live"` | Override the client's routing for this call only. |
| `consistency` | `"session"` \| `"eventual"` \| `"strong"` | See ADR-0016a §D4. `"strong"` returns `UnsupportedError`. |
| `idempotent` | `bool` | Caller attestation per ADR-0005 §"Caller-attested idempotency". |

### Node example

```ts
// Single
import { SeedClient } from '@cognitum/sdk/seed';

const seed = new SeedClient('https://cognitum.local:8443', {
  auth: { pairingToken: process.env.COGNITUM_SEED_TOKEN },
});
await seed.status();

// Mesh (explicit list)
const mesh = new SeedClient(
  [
    'https://seed-a.tailnet.ts.net:8443',
    'https://seed-b.tailnet.ts.net:8443',
    'https://seed-c.tailnet.ts.net:8443',
  ],
  {
    auth: {
      'https://seed-a.tailnet.ts.net:8443': tokens.a,
      'https://seed-b.tailnet.ts.net:8443': tokens.b,
      'https://seed-c.tailnet.ts.net:8443': tokens.c,
    },
    routing: 'session',                    // default, closest-first + sticky
    health: { interval: 30_000 },          // 30 s active probe
  },
);

const session = mesh.session();
await session.store.ingest(vectors);
await session.store.query({ vector, k: 5 });  // same peer as ingest
```

### Python example

```python
# Single
from cognitum.seed import SeedClient, PairingToken

seed = SeedClient(
    "https://cognitum.local:8443",
    auth=PairingToken(os.environ["COGNITUM_SEED_TOKEN"]),
)
seed.status()

# Mesh (explicit list, async)
from cognitum.seed import AsyncSeedClient, Health

mesh = AsyncSeedClient(
    endpoints=[
        "https://seed-a.tailnet.ts.net:8443",
        "https://seed-b.tailnet.ts.net:8443",
    ],
    auth={
        "https://seed-a.tailnet.ts.net:8443": tokens["a"],
        "https://seed-b.tailnet.ts.net:8443": tokens["b"],
    },
    routing="session",
    health=Health(interval=30.0),
)

async with mesh.session() as s:
    await s.store.ingest(vectors)
    await s.store.query(vector=v, k=5)  # same peer
```

### Rust example

```rust
// Single
use cognitum_rs::seed::{SeedClient, PairingToken};

let seed = SeedClient::builder()
    .endpoint("https://cognitum.local:8443")
    .auth(PairingToken::from_env("COGNITUM_SEED_TOKEN")?)
    .build()?;
seed.status().await?;

// Mesh (explicit list)
use cognitum_rs::seed::{SeedClient, TokenBook, Routing, Health};
use std::time::Duration;

let mesh = SeedClient::builder()
    .endpoints([
        "https://seed-a.tailnet.ts.net:8443",
        "https://seed-b.tailnet.ts.net:8443",
        "https://seed-c.tailnet.ts.net:8443",
    ])
    .token_book(TokenBook::from_map(tokens))
    .routing(Routing::Session)
    .health(Health::active(Duration::from_secs(30)))
    .build()?;

let session = mesh.session();
session.store().ingest(&vectors).await?;
session.store().query(&q).await?;
```

## Mesh lifecycle

- **Open** — constructor resolves `discovery` to a peer list, builds a
  per-peer connection pool (ADR-0002 §Transport), loads auth from the
  TokenBook, optionally issues one active health probe per peer (only
  if `health.interval` is set), returns the client. A failed probe
  does NOT fail construction — the peer is marked `Unhealthy` and the
  client opens anyway (consistent with ADR-0007 "fail at first call,
  not at construction" for network problems; TLS misconfiguration is
  still fatal at construction per ADR-0007 §"Fail-fast rule").
- **Track** — opportunistic health per ADR-0016a §D7; optional active
  probe. No reshaping of the peer list.
- **Rebalance** — peer health state updates live per request outcome.
  The SDK does not re-run discovery during the client's lifetime
  unless the caller invokes `client.rediscover()` (explicit, no
  scheduled rediscovery in Phase 1). Adding or removing peers without
  rediscovery requires constructing a new client.
- **Close** — `client.close()` (or Python `__aexit__`, Rust `Drop`)
  drains in-flight requests, closes every connection pool, zeroes
  credential material in the TokenBook per ADR-0007 §"Credentials in
  memory".

## Compliance

Each SDK MUST include an integration test suite under
`sdks/<lang>/tests/seed_mesh/` that demonstrates every decision in
ADR-0016a:

| Test | Asserts | Decision |
|------|---------|----------|
| `test_single_endpoint.py\|.rs\|.ts` | String URL in constructor works unchanged | D1, D9 |
| `test_explicit_mesh.*` | Three-peer list constructs a client; `peers()` shows three entries | D1 |
| `test_session_pinning.*` | Two reads after one write land on the same peer | D2, D4, D9 |
| `test_failover_cycles_peers.*` | Mock peer A 500s → request succeeds via peer B | D3 |
| `test_429_no_cycle.*` | 429 on peer A triggers ADR-0005 backoff, NOT peer cycling | D3 |
| `test_session_consistency.*` | Writes + reads in one session see the write | D4 |
| `test_per_peer_token_book.*` | Pair against A then against B → two entries in TokenBook | D5 |
| `test_discovery_explicit.*` | `Explicit(list)` provider returns exactly the list | D6 |
| `test_health_opportunistic.*` | Peer marked `Unhealthy` after 3 failed requests | D7 |
| `test_health_active.*` | `health.interval=1s` triggers `/status` pings on an idle mock | D7 |
| `test_mvp_surface.*` | All endpoints listed in D8 are exposed and typed | D8 |
| `test_mesh_observability.*` | `client.mesh.status/peers/swarm/health` round-trip against a live seed | D8 |

Conformance test suite MUST run against:

1. A single virtual seed (Docker; `mesh-peers.json` fallback per
   `seed/src/cognitum-agent/src/api.rs:5454-5460`).
2. A three-seed Docker mesh (virtual mode, shared `mesh-peers.json`).
3. The ruvultra live fixture via SSH tunnel (see `CLAUDE.local.md`
   §"Active path") — manual, run on demand.

CI lint: grep for `http://` literals under `src/seed/` or
`src/cognitum/seed/` — MUST fail (ADR-0002 §Transport).

Parity test across SDKs: the three per-SDK `test_mvp_surface` tests
MUST produce the same ordered list of method names (modulo casing
convention: Node `seed.store.ingest`, Python `seed.store.ingest`, Rust
`seed.store().ingest`). A CI job runs all three and diffs the lists.

## Consequences

### Positive

- One conformance matrix — twelve tests × three SDKs = 36 cases, all
  with a single source of truth (ADR-0016a + this doc).
- Three concrete per-language examples eliminate ambiguity about how
  the language-agnostic shape maps to each SDK's idiomatic style.
- Mesh lifecycle is explicit, so implementers don't need to invent
  answers to "what happens on construction if peer 2 is down?"
  (answer: client opens; peer 2 marked `Unhealthy`).

### Negative

- The parity test is strict — adding a method to only one SDK will
  fail CI until all three catch up.
- `rediscover()` is explicit, so long-lived mesh clients on a tailnet
  where peers come and go will need an application-level scheduler.
  This is acceptable for Phase 1; automatic rediscovery is an
  ADR-0016c candidate if demand materialises.

## References

- ADR-0016a — the nine decisions this doc realises
- ADR-0002 — wire protocol (transport posture)
- ADR-0003 — auth (pairing token, mTLS)
- ADR-0005 — retry/backoff (extended by ADR-0016a §D3)
- ADR-0007 — security (TLS pinning, redaction, credential lifetime)
- ADR-0011 — SDK scope (Phase 1 surface extended by ADR-0016a §D8)
- Seed ground truth:
  - `seed/src/cognitum-agent/src/api.rs:1143-1244`,
    `5452-5740`, `6943-7082`
  - `seed/src/cognitum-agent/src/discovery.rs:1-100`
  - `seed/src/cognitum-agent/src/delta_sync.rs:24-48, 193-331`
  - `seed/src/cognitum-agent/src/mesh/mod.rs:1-100`
  - `seed/src/cognitum-agent/src/main.rs:2686-2765`
