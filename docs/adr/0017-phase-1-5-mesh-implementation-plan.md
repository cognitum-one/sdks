# 0017: Phase 1.5 Mesh Implementation Plan (Work Breakdown)

- **Status:** Plan (not an ADR — no decisions; executes ADR-0016a/b)
- **Date:** 2026-04-22
- **Scope:** sdks/node, sdks/python, sdks/rust
- **Supersedes:** none. **Executes:** ADR-0016a D1-D9 and ADR-0016b
  §Signatures, §Mesh lifecycle, §Compliance.

This document is a work plan, not a decision record. Each SDK's
implementer follows the same seven-step sequence; the cross-SDK
acceptance criteria in §5 are the definition of done.

## 1. Mesh invariants (cross-SDK)

Every SDK MUST preserve these invariants (citation → ADR-0016a section).

| # | Invariant | Source |
|---|-----------|--------|
| I1 | One concrete `SeedClient` type; N=1 degenerates to single mode with zero API change | §D1, §D9 |
| I2 | 1..N endpoints accepted; explicit list is the required primitive | §D1, §D6 |
| I3 | Default routing = closest-first with session-sticky reads | §D2 |
| I4 | Default consistency = session (read-your-writes within a session) | §D4 |
| I5 | Failover cycles peers on NetworkError / TimeoutError / 5xx / 503 | §D3 |
| I6 | 429 pins to the same peer; ADR-0005 backoff applies; do NOT cycle | §D3 |
| I7 | AuthError / ValidationError / NotFoundError surface immediately, never cycle | §D3 |
| I8 | TokenBook is per-peer; `pair_all(client_name)` iterates peers | §D5 |
| I9 | Health tracking is opportunistic by default; active probe is opt-in via `health_interval` | §D7 |
| I10 | ADR-0005 retry budget is per-request (60 s `maxElapsedMs` ceiling); N peers × M retries is NOT allowed | §D3 |

## 2. Data structures (per SDK)

Language-agnostic shapes. Each SDK renders them per local idiom
(Node: classes + interfaces; Python: dataclasses + Protocols; Rust:
structs + traits).

```
// §D7
Peer {
  url:            Endpoint
  state:          Healthy | Degraded | Unhealthy
  latency_ema_ms: f64              // exponential moving avg; seed initial from first probe
  last_used_at:   Option<Instant>
  consecutive_failures: u32
}

PeerSet {
  peers: Vec<Peer>                 // stable order from constructor
  // Sort key: (state rank, latency_ema_ms, list_index). Unhealthy skipped unless all unhealthy.
  fn pick(ctx: CallContext) -> &Peer
  fn next_after(failed: &Peer) -> Option<&Peer>
  fn record_outcome(peer, outcome: Ok{latency_ms} | Err{class}) -> ()
}

// §D5
TokenBook {                        // trait / interface / Protocol
  fn get(peer_url) -> Option<PairingToken>
  fn set(peer_url, token, client_name) -> ()
  fn delete(peer_url) -> ()
}
InMemoryTokenBook  // default impl; zeroes on drop per ADR-0007

// §D9
SessionHandle {
  pinned_peer: Endpoint
  client_ref:  WeakRef<SeedClient>
  fn epoch_hint() -> Option<u64>
  // resource accessors mirror client (store, witness, custody, pair, mesh)
}

// §D7
HealthMonitor {
  mode: Opportunistic | Active { interval: Duration }
  fn observe(peer, outcome) -> ()  // called from request pipeline
  fn probe_tick() -> ()            // Active mode only; pings GET /api/v1/status
}
```

## 3. Implementation sequence (per SDK)

Each step is independently testable. Later steps can merge without
touching earlier step tests.

| Step | Deliverable | Scope | Est. |
|------|-------------|-------|------|
| S1 | `PeerSet` + `Peer` + latency-ordered sort | Pure data structure; no HTTP. Unit tests for ordering, next_after, unhealthy skip. | S |
| S2 | `TokenBook` trait + `InMemoryTokenBook` default | Trait/Protocol/interface + default. Unit tests for get/set/delete, zero-on-drop. | S |
| S3 | Wire into `SeedClient.request<T>()` | Replace single-peer call with `peer = PeerSet.pick(ctx)`; fetch token via `TokenBook.get(peer)`; record outcome. | M |
| S4 | Failover state machine | On Net/Timeout/5xx/503: cycle via `next_after`. On 429: pin + ADR-0005 backoff. On Auth/Validation/NotFound: propagate. Respect 60 s `maxElapsedMs` ceiling (I10). | M |
| S5 | `client.session()` + `SessionHandle` | Pins peer per §D2; mirrors resource methods; optional `prefer` argument. | M |
| S6 | Active health probe (opt-in) | Background task (tokio/asyncio/node timers) pings `GET /api/v1/status` every `health_interval`; updates `Peer.state`. Defaults off. | S |
| S7 | Integration tests | Wiremock/httpmock multi-peer fixtures covering §5 acceptance suite. | M |

Estimate key: S ≈ ≤0.5 day, M ≈ 0.5-1.5 day, L ≈ 2-3 day. Sum per
SDK below in §4.

## 4. Work-unit estimates per SDK

Each SDK runs the same seven steps. Deltas reflect existing Phase 1
state and language ergonomics.

| SDK | S | M | L | Notes |
|-----|---|---|---|-------|
| Python | 3 (S1, S2, S6) | 4 (S3, S4, S5, S7) | 0 | Cleanest Phase 1 (9/9 live); `httpx` mocking via `respx` is well-known. |
| Node | 2 (S2, S6) | 4 (S3, S4, S5, S7) | 1 (S1 — redo once; see below) | Phase 1 had the URL-path bug; expect extra friction re-wiring `request()` without re-introducing it. Treat S1 as M on Node if the existing peer abstraction is stubbed. |
| Rust | 2 (S2, S6) | 3 (S1, S3, S5) | 2 (S4, S7) | Phase 1 had 0/12 live; async failover state machine + lifetime/borrow for `SessionHandle` elevate S4 + S7 to L. Wiremock-rs fixtures are verbose. |

Rough wall-clock budget (single implementer, uninterrupted): Python
~3-4 days, Node ~4-5 days, Rust ~6-8 days.

## 5. Cross-SDK acceptance criteria

Language-agnostic pseudo-spec. Each SDK implements these under
`sdks/<lang>/tests/seed_mesh/phase_1_5/`. Fixture naming is
non-normative; behaviour is.

```
test_mesh_single_peer_behaves_like_single_mode
  given SeedClient(["https://seed-a:8443"])          // N=1
  when  client.status()
  then  request hits seed-a exactly once; no peer cycling; matches I1.

test_mesh_two_peers_round_robin_for_reads
  given SeedClient([a, b], routing="eventual")       // §D4 eventual hint
  when  10 x client.store.query(...) with consistency="eventual"
  then  both a and b receive at least 1 call (rough 50/50 tolerance).

test_mesh_cycles_on_5xx                              // §D3, I5
  given mock a -> 500, mock b -> 200
  when  client.store.query()
  then  one 500 on a, one 200 on b; total < 60 s; I10 budget respected.

test_mesh_pins_on_429                                // §D3, I6
  given mock a -> 429 (Retry-After: 1), then 200
  when  client.store.query()
  then  all retries land on a (never b); ADR-0005 backoff schedule
        observed; no peer cycling.

test_mesh_session_stickiness                         // §D2, §D4, I3, I4
  given SeedClient([a, b]).session()
  when  session.store.ingest(v); session.store.query(v)
  then  both requests land on the SAME peer (whichever pick chose first).

test_mesh_token_book_per_peer                        // §D5, I8
  given SeedClient([a, b])
  when  client.pair.open("cli") against a, then against b
  then  TokenBook has two distinct entries keyed by a, b;
        pair_all("cli") on a fresh client produces the same shape.

test_mesh_health_probe_degrades_unhealthy_peer       // §D7, I9
  given SeedClient([a, b], health_interval=100ms), mock a -> network error
  when  wait 500ms without any user request
  then  client.peers()[a].state == Unhealthy; subsequent user call picks b.
```

Minimum coverage: seven tests above. Each SDK MAY add more; parity
across SDKs is asserted by the ADR-0016b §Compliance parity test.

## 6. Dependencies between SDKs

**None.** Each SDK ships Phase 1.5 independently. The only
cross-SDK artefact is the parity test from ADR-0016b §Compliance,
which already exists and will pick up new method names automatically.

Shared fixtures — not worth authoring once and vendoring across three
languages. Each ecosystem's mocking tool (`respx` / `nock` /
`wiremock-rs`) has its own fixture format, and the behaviour under
test is thin enough (status codes + Retry-After + body echoing) that
duplication costs less than maintaining a shared JSON schema. Skip.

## 7. Rollout order recommendation

**Order: Rust → Python → Node.**

Rationale:

1. Rust had 0/12 live endpoints post-Phase-1; Phase 1.5 must NOT
   stack mesh complexity on a shaky Phase 1 base. Shipping Rust first
   forces the Phase 1 rework (if needed) and establishes the failover
   state machine in the language that has the strictest types — which
   tends to surface contract gaps early.
2. Python had the cleanest Phase 1 (9/9 live). Landing Python second
   lets us re-use Rust's test matrix as a reference implementation
   and mostly translate; risk of regressing live endpoints is lowest.
3. Node landed after Python because of the Phase 1 path bug; doing
   Node last means the fix is confirmed in production before mesh
   wiring.

Alternative order (Python → Node → Rust) is defensible if the
priority is "fastest user-visible mesh". Defer to the loop driver;
the dependency graph permits any permutation.

## 8. Open questions from ADR-0016 — proposed defaults

Three items the architect flagged as open. Implementers should not
block on these; proceed with the defaults below until the architect
countermands.

| # | Question | Proposed default | Confirm? |
|---|----------|------------------|----------|
| OQ-A | Relay tickets (GCP control-plane, `mesh/mod.rs:1028-1073`) in SDK surface? | **Out of scope.** Seed-internal only; SDK never requests relay tickets. §D8 "Out of Phase 1" already excludes `/api/v1/mesh/*`. | Yes |
| OQ-B | Per-peer mesh-overlay mTLS in SDK? | **Out of scope.** SDK does TLS (ADR-0007); mesh-overlay mTLS (ADR-084) is seed-to-seed only. Lockdown mTLS (ADR-0007 §"Lockdown") is the only mTLS mode the SDK cares about. | Yes |
| OQ-C | `auto_pair` across the mesh at constructor time? | **No ctor arg.** §D5 `pair_all(client_name)` helper method only. A constructor flag would silently network-call during `new`, which violates ADR-0007 "fail at first call, not at construction". | Yes |

If the architect flips any of these, only the corresponding step in
§3 shifts (OQ-A/B would add endpoints to S3 surface; OQ-C would
inject an auto-pair call into the constructor path after S5).

## References

- ADR-0016a — Decisions D1-D9 (invariant source)
- ADR-0016b — Signatures, mesh lifecycle, compliance test matrix
- ADR-0005 — Retry/backoff budget (authoritative 60 s ceiling)
- ADR-0007 — Security model (TLS pinning, credential lifetime,
  fail-fast rule)
- ADR-0011 — SDK scope / rollout phasing (Phase 1.5 is the mesh
  increment on Phase 1)
- Issue `cognitum-one/sdks#2` — Phase 1 / Phase 1.5 parent tracker
