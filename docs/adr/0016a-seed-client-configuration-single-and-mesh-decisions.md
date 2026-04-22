# ADR 0016a: Seed Client Configuration — Decisions (Single and Mesh)

- **Status:** Accepted
- **Date:** 2026-04-22
- **Scope:** cross-cutting (sdks/node, sdks/python, sdks/rust)
- **Split:** this ADR is 0016a of 0016 — nine decisions + rationale. See
  ADR-0016b for language-agnostic signatures, mesh lifecycle, compliance
  tests, and per-language examples.

## Context

Today none of the three SDKs implement the seed-direct surface at all.
They are cloud-only (`https://api.cognitum.one`) and have no
`SeedClient` type. This is tracked as `cognitum-one/sdks#2` and is the
1.0 blocker for Phase 1 of ADR-0011 §"Rollout phasing". A user who
plugs a seed into their laptop or runs a seed cluster on their tailnet
cannot use `@cognitum/sdk`, `cognitum` (Python), or `cognitum-rs` to
talk to it directly.

Seed v0.20.0 ships a peer-to-peer mesh with three layered mechanisms:

1. **mDNS discovery** (ADR-040) — each seed advertises
   `_cognitum._tcp.local` with `device_id`, `ip`, `port`, `epoch`,
   `vector_count`, `cert_fingerprint`
   (`seed/src/cognitum-agent/src/discovery.rs:99, 137-180`). Served on
   UDP 5353, parsed natively without external crates.
2. **Delta sync over HTTPS** (ADR-040 multi-seed clustering) — each
   seed is a client against other seeds' `/api/v1/store/sync` endpoint
   (GET with `?since_epoch=N` pulls, POST pushes with
   `source_device_id` and `source_epoch`;
   `seed/src/cognitum-agent/src/api.rs:1143-1144`,
   `seed/src/cognitum-agent/src/delta_sync.rs:24-48, 283-331`).
3. **Mesh overlay** (ADR-084) — encrypted UDP tunnels with mTLS, STUN
   NAT traversal, relay fallback via GCP control plane, max 20 peers
   per seed (`seed/src/cognitum-agent/src/mesh/mod.rs:1-25`,
   `seed/src/cognitum-agent/src/mesh/control_plane.rs`, relay ticket
   request at `mesh/mod.rs:1028-1073`).

The SDK-facing surface of the mesh is five HTTP endpoints:

- `GET  /api/v1/network/mesh/status` (unpaired — in the WiFi-read
  allowlist at `seed/src/cognitum-agent/src/api.rs:394-400`).
- `GET  /api/v1/peers` and `GET /api/v1/swarm/peers`
  (`api.rs:6943-6967`) — peer roster with per-peer `epoch`,
  `vector_count`, `sync_status ∈ {in_sync, behind}`.
- `GET  /api/v1/swarm/status` (`api.rs:6973-6987`) — this seed's view
  of the swarm.
- `GET  /api/v1/cluster/health` (`api.rs:7013-7043`) — aggregate health
  + last sync timestamp.
- `POST /api/v1/peers/sync` (`api.rs:7045-7082`, paired) — registers
  the caller as a peer.

**The open question this ADR closes:** does an SDK consumer connect to
ONE seed (which handles mesh internally — delta pull/push, mDNS,
overlay), or to MULTIPLE seeds with SDK-side routing? The answer
shapes every line of the Phase 1 seed-client implementation.

This ADR locks the configuration surface that all three SDKs MUST
expose so implementers can start Phase 1 without re-opening the shape
question.

## Decision

Each of the nine decisions below is load-bearing. Rejected options are
listed per-decision and collected again in §Alternatives considered.

### D1. Configuration API shape — explicit peer list

SDKs ship **one** `SeedClient` type. Its primary constructor takes
either a single `Endpoint` or a list of `Endpoint`s:

```
SeedClient.new(endpoints, *, auth, tls, routing, failover, health, token_book)
```

- **Single-seed** (N=1): `SeedClient.new("https://cognitum.local:8443")`.
  This is the default for laptop-plugged-in-USB (`169.254.42.1`) and
  single-seed tailnets. The URL form is identical to the single-cloud-
  endpoint construction in today's cloud client.
- **Mesh (explicit list)**:
  `SeedClient.new(["https://seed-a:8443", "https://seed-b:8443", ...])`.
  The caller owns the peer list. This is the canonical mesh form.
- **Mesh (discovery)**: same constructor with a `discovery` option
  replacing the explicit list — `SeedClient.new(discovery=Mdns)`. At
  client-open the SDK performs one mDNS query against
  `_cognitum._tcp.local`
  (`seed/src/cognitum-agent/src/discovery.rs:99`) and treats the result
  as the explicit list. Discovery is OPTIONAL in Phase 1 (see D6);
  explicit list is REQUIRED in Phase 1.

Rationale: explicit list is the smallest primitive that covers every
multi-seed deployment we have today (tailnet with 2-4 seeds, dev laptop
with one USB seed, CI test fixture with N virtual seeds in Docker).
mDNS is a convenience layer on top of it, not a replacement. Forcing
callers to construct the list themselves also keeps the SDK testable
without real network multicast.

**Rejected:**
- *Gateway seed that forwards to peers* — not a thing the seed
  supports. Every seed is peer-to-peer; there is no forwarding mode.
  `seed/src/cognitum-agent/src/main.rs:2712-2765` shows one seed's
  `peer_http_post` to another seed over HTTPS — that's peer-to-peer,
  not a gateway.
- *Discovery-only (no explicit list)* — mDNS requires real multicast;
  unit tests and Docker networks without multicast would be
  un-testable.
- *URL templating (`https://seed-{0..2}:8443`)* — cute, brittle, no
  real ops value.

### D2. Routing policy — closest-first with read-any/write-pin

Default routing: **closest-first with sticky reads** when N > 1.

- **First request** picks the peer with the lowest observed connect
  latency; ties broken by list position.
- **Subsequent reads** stay sticky to the same peer for the life of a
  caller-visible *session handle* (see D9).
- **Writes** use the same peer as reads (session-pin); on peer failure,
  writes follow the failover rules in D3.
- **Per-call override**: callers MAY pass `peer: "<endpoint>"` or
  `prefer: "closest" | "round_robin" | "first_live"` on any call.

Rationale: the seed mesh is eventually consistent via binary RVF delta
sync (D4), so spraying reads across peers returns stale data.
Closest-first minimises latency; sticky reads give read-your-writes at
the session level for free (D4). Round-robin is available per-call but
not as a default.

Default policy in single-seed mode (N=1) degenerates to "use the one
peer".

**Rejected:**
- *Round-robin by default* — violates read-your-writes when the caller
  writes to peer A and reads from peer B before delta sync catches up.
- *Read-any/write-one (leader)* — there is no leader in the seed mesh;
  every peer is a write target. `delta_sync.rs:324-331` shows conflict
  resolution happens pairwise by `source_epoch` comparison with
  `source_device_id` tiebreak, not by leader vote.
- *Random* — non-deterministic tests.

### D3. Failover — cycle peers, extend ADR-0005 retry budget

When the current peer returns a peer-level error, cycle to the next
peer. When every peer has been tried, fall through to ADR-0005's retry
budget. Peer-level errors:

| Outcome on peer P | Action |
|-------------------|--------|
| `NetworkError` (DNS/TCP/TLS/connect refused) | Mark P unhealthy, cycle to next peer, do **not** count against the per-attempt retry budget for the first pass |
| `TimeoutError` on connect | Same as above |
| `5xx` (500, 502, 504) | Mark P unhealthy, cycle to next peer |
| `503 Service Unavailable` | Lockdown-in-progress per `seed/docs/seed/security-model.md`. Cycle immediately; do NOT retry the same peer |
| `429 RateLimited` | **Do not** cycle — 429 is per-IP trust-score shaped (`seed/src/cognitum-agent/src/rate_limit.rs:140-178`); cycling burns three peers' budgets in a row. Apply ADR-0005 backoff on the same peer. Surface a log warning after 3 consecutive 429s on the same credential |
| `AuthError`, `ValidationError`, `NotFoundError` | Do **not** cycle. Surface immediately. These are non-transport errors. |

After one full pass of N peers without success, the SDK applies
ADR-0005's backoff formula (`500 ms * 2^attempt + equal-jitter`, cap
30 s, max 3 attempts, `maxElapsedMs=60 s`) against the full list
again. Peer marks clear after `health_interval` seconds (D7) OR after
a successful probe, whichever comes first.

`maxRetries` in ADR-0005 is the per-*request* budget — N peers × M
retries is NOT allowed. The total elapsed-time ceiling of 60 s is
authoritative.

**Rejected:**
- *Retry same peer first, cycle only on exhaustion* — makes outages
  feel like the whole cluster is down; 429 is the ONLY error type
  where that's correct, and it's handled.
- *Retry every peer, every attempt* — multiplicative; exceeds
  trust-score block threshold.
- *Fail fast, no cycle* — wastes a mesh.

### D4. Consistency model — session consistency by default

Default: **session consistency** (a.k.a. read-your-writes within a
session). Mechanism: D2's sticky reads mean a session's writes AND
reads go to the same peer; the peer's own epoch is monotonic
(`seed/docs/seed/api-reference.md:38`, ADR-0002 §Endpoint inventory >
Custody), so the caller always observes their own writes.

When a session has to failover to a new peer (D3), the SDK MAY expose
the new peer's epoch to the caller via `session.epoch_hint()`. Callers
requiring strict read-your-writes across failover MUST pin to a
specific peer with `prefer: "first_live"` — the SDK will fail the call
rather than switch peers silently.

Per-call hint: `consistency: "eventual" | "session" | "strong"`.

| Hint | Behaviour |
|------|-----------|
| `session` (default) | Sticky reads. Single peer for session. Read-your-writes within session. |
| `eventual` | Any live peer. Round-robin. Useful for status dashboards, cluster health aggregations. |
| `strong` | Not supported today — returns `UnsupportedError` (see D8). Reserved for a future seed feature (Raft/Paxos write quorum). |

Rationale from seed code:

- Delta sync is pairwise pull/push
  (`seed/src/cognitum-agent/src/delta_sync.rs:193-277`). No global
  ordering. Two peers can have different `epoch` values at any
  instant; `handle_peers_list` at `api.rs:6946-6960` explicitly
  reports per-peer `sync_status` as either `in_sync` or `behind`.
- Witness chain is append-only and Ed25519-signed per device
  (`seed/docs/seed/api-reference.md:149-165`). Each seed has its OWN
  witness chain — they are not federated. A write to peer A bumps A's
  chain; peer B's chain is unaffected. Cross-peer read of witness
  chain is meaningful only if the caller knows which peer produced the
  entry.

The SDK MUST document this in the doc comment of the `witness` and
`custody` resource methods: "Witness chains are per-seed. When routing
across a mesh, the chain you observe is the chain of the peer that
handled the call."

**Rejected:**
- *Eventual by default* — silently violates the principle of least
  surprise. A caller who ingests then queries expects their vector
  back; delta sync has a non-zero RTT, so eventual default would
  flake.
- *Strong consistency* — the seed has no write quorum protocol. The
  delta sync in `delta_sync.rs:324-331` is last-writer-wins by epoch +
  device_id tiebreak, which is the opposite of strong.

### D5. Credential scope — per-seed pairing tokens via TokenBook

Pairing is per-device. `seed/src/cognitum-agent/src/api.rs:17-156`
shows `PairedClient` is scoped to a single device's state; a
`DELETE /api/v1/pair/{client_name}` deletes one client on one seed.
There is no shared cluster-wide token.

SDKs MUST expose a **TokenBook** abstraction that maps peer URL to
pairing token:

```
trait TokenBook {
    fn get(peer_url: str) -> Option<PairingToken>;
    fn set(peer_url: str, token: PairingToken, client_name: str) -> None;
    fn delete(peer_url: str) -> None;
}
```

- **Default**: in-memory TokenBook seeded from the constructor's
  `auth` argument, which accepts either:
  - A single `PairingToken` — applied to EVERY peer (only valid when
    the caller asserts all peers share a token, e.g. a single seed
    with two URLs — loopback + tailscale).
  - A `dict`/`map`/`HashMap<String, PairingToken>` — explicit per-peer
    tokens.
  - A callable/closure `fn(peer_url) -> PairingToken` — lazy
    resolution (used by the Cloud-returned
    `cloud.devices.seed(device_id)` helper tracked in ADR-0011
    §"Future: direct SDK from cloud").
- **Opt-in persistence**: a `PersistentTokenBook` backed by the OS
  keychain or a file MAY be plugged in via constructor. Same shape as
  ADR-0007 §"Pairing flow safety".
- **Pair-time behaviour**: on successful `POST /api/v1/pair` against
  peer P, the SDK MUST call `tokenBook.set(P, token, client_name)`.
- **Unpair-time behaviour**: on `DELETE /api/v1/pair/{client_name}`
  against peer P, the SDK MUST call `tokenBook.delete(P)`.

The WiFi-read allowlist (ADR-0003 §"WiFi-read allowlist") applies
per-peer: `GET /api/v1/status` on any peer works without a token; any
write requires `tokenBook.get(P)` to return `Some`.

**Rejected:**
- *Cluster-wide token* — seed does not support it.
- *Pair once, share across peers* — violates per-device custody. If a
  caller wants one call to pair every peer in the mesh, the SDK ships
  a helper `seed.pair_all(client_name)` that iterates peers; each
  pairing is independent.

### D6. Peer discovery — explicit list required, mDNS optional

Phase 1 REQUIRES explicit-list discovery; mDNS is a Phase 1.5 opt-in.

| Mode | Phase | Implementation notes |
|------|-------|---------------------|
| Explicit list | 1 (required) | Caller provides `[Endpoint]` to constructor |
| mDNS | 1.5 (optional) | One-shot query against `_cognitum._tcp.local` at client-open; parses TXT records for `device_id`, `port`, `epoch`, `vector_count`, `cert_fingerprint` per `seed/src/cognitum-agent/src/discovery.rs:137-180` |
| Cloud-fleet | 2+ (future) | `cloud.devices.seed(device_id)` returns a preconfigured `SeedClient` using the cloud fleet API's tailnet address — ADR-0011 §"Future" |
| Tailscale-native | deferred | Seed does not advertise tailnet name today — OQ-11 |

Discovery is pluggable: SDKs MUST accept a
`discovery: DiscoveryProvider` constructor arg that returns
`[Endpoint]`. The built-in providers are `Explicit(list)` and `Mdns`
(Phase 1.5); custom providers are a stable public interface.

**Rejected:**
- *mDNS required in Phase 1* — multicast is blocked on many corporate
  and Docker networks; would make the default case brittle.
- *Auto-discovery as default* — surprising; callers expect to list
  their seeds explicitly.

### D7. Health tracking — opportunistic default, opt-in active probe

Default: **opportunistic**. The SDK observes request outcomes per D3
and marks peers healthy/unhealthy accordingly. No background traffic.

Opt-in: `health_interval: Duration` constructor arg enables an active
probe. When set, the SDK background-pings every peer with
`GET /api/v1/status` (allowlisted, no auth) on the interval. Default
`health_interval = None` (off).

Per-peer state:

```
PeerHealth {
    last_ok_at: Option<Instant>,
    last_fail_at: Option<Instant>,
    consecutive_failures: u32,
    status: Healthy | Degraded | Unhealthy,
}
```

- `Healthy`: last observation succeeded.
- `Degraded`: ≤2 consecutive failures. Still routable; closest-first
  (D2) still considers it.
- `Unhealthy`: ≥3 consecutive failures. Skipped by the routing policy
  until a successful observation (opportunistic probe on next request
  OR active probe if enabled).

SDKs expose `client.peers()` returning `[PeerHealth]` so callers can
render dashboards.

**Rejected:**
- *Active probe always on* — needlessly chews battery on laptops and
  contributes to the seed's rate-limit budget.
- *No health tracking at all* — every request would retry through
  known-dead peers.

### D8. Phase 1 minimum-viable surface

Phase 1 `SeedClient` MUST wrap these endpoints. This is the MVP shape
that ships with the first seed-client release per SDK. It expands
ADR-0011 §"Rollout phasing > Phase 1" by adding the mesh-read
endpoints that make mesh mode observable.

| Bounded context | Endpoints |
|-----------------|-----------|
| Custody — identity/status | `GET /api/v1/status`, `GET /api/v1/identity` |
| Pairing | `GET /api/v1/pair/status`, `POST /api/v1/pair`, `DELETE /api/v1/pair/{client_name}` |
| Optimizer — vector store | `GET /api/v1/store/status`, `POST /api/v1/store/ingest`, `POST /api/v1/store/query`, `POST /api/v1/store/delete` |
| Custody — witness/signing | `GET /api/v1/witness/chain`, `POST /api/v1/custody/sign`, `POST /api/v1/custody/verify`, `GET /api/v1/custody/attestation` |
| **Mesh read (new)** | `GET /api/v1/network/mesh/status`, `GET /api/v1/peers` (alias `/swarm/peers`), `GET /api/v1/swarm/status`, `GET /api/v1/cluster/health` |

**Nice-to-have in Phase 1.5** (not blocking):

- `POST /api/v1/ota/check-now`
- `GET /api/v1/coherence/profile`
- `GET /api/v1/thermal/state`
- `POST /api/v1/peers/sync` — only needed by callers that want to
  register the SDK client as a participating peer, which Phase 1
  consumers don't.

**Out of Phase 1** (explicitly deferred):

- Binary RVF sync (`GET/POST /api/v1/store/sync`) — multi-MB payloads,
  different retry shape, only useful for seed-to-seed replication;
  SDK consumers call the JSON-based `/store/ingest`, `/store/delete`
  and let seeds sync among themselves over the overlay (ADR-084).
- `/api/v1/mesh/*` overlay-control routes (`mesh/disable`,
  `mesh/enable`, `mesh/peers`) — operator tooling, not SDK consumer
  surface.
- SSE streams (`/delta/stream`, `/sensor/stream`) — ADR-0002
  §Streaming keeps its 501 placeholder, out of scope.
- `/api/v1/network/mesh/join`, `/api/v1/network/mesh/password`,
  `/api/v1/network/mesh/auto` — these are SEED-side mesh join commands
  (seed A's SDK telling seed A to WiFi-join seed B). Not an SDK
  consumer workflow.

### D9. Single vs mesh type split — one `SeedClient`, sessions for pinning

One concrete type, `SeedClient`, holding 1..N peers internally. `N=1`
degenerates to single mode with zero API change. Every method exists
on `SeedClient` regardless of mode; when `N=1` the per-call `peer:`
and `prefer:` args are no-ops.

Session handle:

```
let session = client.session();  // pins a peer via D2
session.store.query(q);          // sticky reads
session.witness.chain();         // same peer
drop(session);                    // unpins
```

Opening a session is optional. Stateless calls go through a per-call
session that ends with the call. Sessions are cheap (they hold a weak
ref to the client's peer table; no new connections).

Rationale:

- One type = one set of docs, one conformance test matrix, fewer
  "which do I import?" questions.
- Upgrading from single to mesh is a constructor change only.
- Callers that DON'T want routing knobs can ignore sessions entirely;
  default routing (D2) + opportunistic health (D7) is correct for 95 %
  of consumers.

**Rejected:**
- *Two types (`SeedClient` + `SeedMesh`)* — forces users to choose an
  abstraction at import time. Doubles the conformance suite. Makes
  the "upgrade from single seed to HA mesh" story require a code
  change where a config change would do.
- *Trait/interface-only* — Python and Node benefit from a concrete
  type for pickling/serialization (e.g. when handing a client to an
  async worker pool).

## Alternatives considered

Collected from D1-D9 for grep-ability.

| Rejected option | Comes from | Why rejected |
|-----------------|-----------|--------------|
| Gateway-seed forwards to peers | D1 | Seed does not implement gateway mode |
| Discovery-only (no explicit list) | D1, D6 | Untestable on networks without multicast |
| Round-robin by default | D2 | Breaks read-your-writes |
| Leader-based (read-any/write-one) | D2 | No leader in seed mesh (last-writer-wins by epoch) |
| Retry same peer before cycling | D3 | Amplifies outages as N-way budget exhaustion |
| Eventual consistency by default | D4 | Surprising for ingest-then-query |
| Strong consistency today | D4 | Seed has no quorum protocol |
| Cluster-wide shared token | D5 | Seed pairing is per-device |
| mDNS required | D6 | Multicast unreliability on many LAN/WAN setups |
| Active probe always on | D7 | Wastes battery + rate-limit budget |
| Two types (`SeedClient` + `SeedMesh`)| D9 | Doubles surface, forces import-time decision |

## Consequences

### Positive

- One configuration shape, two use cases: adding a seed to a working
  setup is a constructor-arg change, not a code rewrite.
- Mesh failure modes are observable by construction — `client.peers()`
  + `client.mesh.peers()` give callers everything they need to build a
  dashboard.
- Session consistency matches user intent without requiring the seed
  to grow a quorum protocol.
- Per-peer TokenBook honours the seed's per-device custody model
  rather than papering over it.

### Negative

- Per-peer credentials increase configuration burden — `pair_all`
  helper mitigates but doesn't eliminate.
- Session consistency can hide a mesh partition: if peer A is
  isolated, the session's reads look fine even though peer B is ahead.
  Callers querying `session.epoch_hint()` + `client.mesh.health()` can
  detect this; SDKs MUST document the pattern.
- Three SDKs × this ADR = three conformance test suites per ADR-0016b
  §Compliance.

### Risks and mitigation

| Risk | Mitigation |
|------|------------|
| Callers assume strong consistency | Default hint name is `"session"`, not `"strong"`; docstrings reference this ADR |
| Peer list staleness (e.g. tailnet IP changes) | `rediscover()` is explicit; callers paged by error hint when every peer fails to resolve DNS |
| Trust-score block from 429 cycling | D3 explicitly pins 429 to the same peer with backoff; unit test per ADR-0016b §Compliance |
| mDNS multicast blocked on Docker networks | mDNS is opt-in (D6); explicit list is the required primitive |

## References

- Issue: `cognitum-one/sdks#2` — "No SDK implements the seed-direct
  surface" (Phase 1 blocker).
- DDD model: `docs/adr/ddd/seed-domain.md` §2.1 Custody, §2.2
  Optimizer, §2.5 Platform (Pairing Session), §3 Context map.
- Seed endpoint ground truth:
  - `seed/src/cognitum-agent/src/api.rs:1143-1244` mesh + swarm routes.
  - `seed/src/cognitum-agent/src/api.rs:5452-5740` mesh handlers.
  - `seed/src/cognitum-agent/src/api.rs:6943-7082`
    peer/swarm/cluster handlers.
  - `seed/src/cognitum-agent/src/discovery.rs:1-100` mDNS structs.
  - `seed/src/cognitum-agent/src/delta_sync.rs:24-48, 193-331` sync
    semantics + conflict resolution.
  - `seed/src/cognitum-agent/src/mesh/mod.rs:1-100` overlay config.
  - `seed/src/cognitum-agent/src/main.rs:2686-2765` peer-to-peer
    HTTP(S) from one seed to another.
- Related ADRs:
  - ADR-0002 — wire protocol (endpoint inventory, transport posture)
  - ADR-0003 — auth (pairing token, mTLS, X-API-Key)
  - ADR-0005 — retry/backoff (extended by D3)
  - ADR-0007 — security (TLS pinning, redaction, trust score)
  - ADR-0011 — SDK scope (Phase 1 surface extended by D8)
  - ADR-0016b — signatures, lifecycle, compliance for this decision
    set
