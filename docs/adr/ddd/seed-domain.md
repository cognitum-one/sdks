# Cognitum Seed — Domain-Driven Design Model

This document is the canonical DDD model that the Node, Python, and Rust SDKs
bind to. Ground truth lives in `seed/src/cognitum-agent/src/` and
`seed/docs/seed/`. Quoted `path:line` refs are stable within the seed submodule
snapshot checked in at the repo root.

## 1. Ubiquitous language (glossary)

Terms MUST be used verbatim in SDK code, tests, and docs. Internal synonyms
are allowed only when wrapping a legacy term.

| Term | Definition | Source |
|------|-----------|--------|
| **Seed** | The sealed, immutable Pi Zero 2 W appliance running `cognitum-agent`. Canonical source of truth for identity, vectors, and provenance. | `seed/docs/seed/README.md:1-7` |
| **Device ID** | UUIDv4 derived from DICE identity on first boot. Stable for firmware lifetime; regenerated on firmware update. | `seed/docs/seed/security-model.md:139-148` |
| **Custody** | The role that proves what the device witnessed — owns the witness chain, measured-boot attestation, and Ed25519 signing. | `seed/docs/seed/api-reference.md:168-206`, `seed/docs/seed/README.md:41` |
| **Optimizer** | The role that reshapes stored knowledge — runs kNN rebuild, MinCut boundary analysis, coherence recomputation. | `seed/docs/seed/api-reference.md:207-236` |
| **Delivery** | The role that packages and delivers optimized knowledge — delta streams, delivery images, firmware bundles. | `seed/docs/seed/api-reference.md:238-250` |
| **Pairing** | One-time binding of a client to a seed inside a 30-second window. Unlocks writes. | `seed/docs/seed/api-reference.md:61-87` |
| **Pairing token** | Opaque token returned from `POST /api/v1/pair`; carried in `X-Pairing-Token` header. | `seed/docs/seed/api-reference.md:333-338` |
| **Lockdown** | One-way operational hardening: mTLS required, SFTP disabled, USB storage removed. | `seed/docs/seed/security-model.md:4-47` |
| **Epoch** | Monotonic counter over custody events. Every mutation bumps it. | `seed/docs/seed/api-reference.md:38` |
| **Vector** | Dense `f32` embedding of fixed `dimension` (default 8). Content-addressed by truncated SHA-256(dim + bytes). | `seed/docs/seed/rvf-format.md:39-47` |
| **Vector store** | Append-only RVF log with soft deletes; replayed on startup; indexed by HNSW when `foundation` feature is on. | `seed/docs/seed/rvf-format.md:50-58`, `seed/src/cognitum-agent/src/router.rs:1-17` |
| **Witness chain** | Append-only Ed25519-signed ledger of custody events. Parent-hashed for tamper evidence. | `seed/docs/seed/api-reference.md:149-165`, `seed/docs/seed/security-model.md:123-137` |
| **Measured boot** | Boot-time hash chain (kernel → slot → agent → store → API) exposed as `custody/attestation`. | `seed/docs/seed/security-model.md:125-137` |
| **DICE identity** | Device Compound Identifier — Ed25519 keypair KDF'd from `SHA-256(secret ‖ kernel ‖ slot)`. | `seed/docs/seed/security-model.md:139-148` |
| **RVF** | RuVector Format — binary container used for both the vector store file and firmware bundles. Magic `"RVF1"`. | `seed/docs/seed/rvf-format.md:14-36` |
| **Slot** | One of two A/B squashfs firmware images. Active slot is immutable. | `seed/docs/seed/README.md:109` |
| **Boundary** | MinCut partitioning of the vector graph; reports `fragility`, `cut_cost`, `partition_sizes`, `boundary_hash`, `boundary_epoch`. | `seed/docs/seed/api-reference.md:222-236` |
| **Temporal coherence** | 10-second slice window, recomputed every 5 slices, yielding `temporal_coherence`, `coherence_trend`, `phase_boundaries`, `global_rupture`. | `seed/docs/seed/api-reference.md:393-414` |
| **Phase boundary** | A detected rupture in the temporal coherence profile that survives persistence gating. | `seed/docs/seed/api-reference.md:421` |
| **Drift** | Statistical change detected by Page-Hinkley + ADWIN + Reservoir ESN over sensor embeddings. | `seed/docs/seed/api-reference.md:341-356` |
| **Reflex arc** | Per-rule safety-first automation (sensor-triggered actuator fires) with cooldowns. | `seed/docs/seed/api-reference.md:368-376` |
| **Actuator** | A named output (GPIO, LED, UART command) that the reflex arc or API can fire. Writes require pairing. | `seed/docs/seed/api-reference.md:359-366` |
| **Sensor embedding** | 45-dim vector: `5C + C*(C-1)/2` cross-correlations over the six synthetic channels. | `seed/docs/seed/api-reference.md:317-324` |
| **Thermal governor** | 1 Hz DVFS loop across 4 frequency steps (600/1000/1200/1300 MHz) with hysteresis. | `seed/docs/seed/api-reference.md:434-438` |
| **Trust score** | Per-IP credit adjusted by auth outcomes; 3 failures → 5-minute block. | `seed/docs/seed/security-model.md:173-177` |
| **Cloud control plane** | `https://api.cognitum.one` — orchestrates fleets, OTA, catalog, orders, brain. Not the Seed. | `sdks/node/src/client.ts:10-11` |
| **Brain** | Shared knowledge store at `https://pi.ruv.io` reachable through the cloud SDK. | `sdks/node/src/brain.ts:8` |

## 2. Bounded contexts

The Seed is naturally decomposed into the three roles it advertises in
`GET /api/v1/status` (`roles: ["custody", "optimizer", "delivery"]`) plus two
infrastructure contexts and one operator-facing context.

```
┌──────────────────────────────  Seed  ─────────────────────────────┐
│                                                                   │
│   ┌──────────────┐   ┌────────────────┐   ┌───────────────────┐   │
│   │   Custody    │   │   Optimizer    │   │     Delivery      │   │
│   │  (identity,  │──▶│  (knn, mincut, │──▶│ (delta, firmware, │   │
│   │   witness,   │   │   coherence,   │   │  image metadata)  │   │
│   │   signing)   │   │   drift)       │   │                   │   │
│   └──────┬───────┘   └───────┬────────┘   └─────────┬─────────┘   │
│          │                   │                      │             │
│   ┌──────▼───────────────────▼──────────────────────▼─────────┐   │
│   │            Platform (boot, thermal, gadget, TLS,          │   │
│   │            rate-limit, pairing, mTLS, seccomp)            │   │
│   └───────────────────────────────────────────────────────────┘   │
│                                                                   │
│   ┌───────────────────────────────────────────────────────────┐   │
│   │                    Sensing (ADR-041/042)                  │   │
│   │   sensor loop (10 Hz) → embedding (45-dim) → drift        │   │
│   │   → reflex arc → actuators                                │   │
│   └───────────────────────────────────────────────────────────┘   │
│                                                                   │
│   ┌───────────────────────────────────────────────────────────┐   │
│   │                  Operator (guide.html, /pair UI,          │   │
│   │                  /demo/*, /profiles)                      │   │
│   └───────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────┘
         ▲                                          ▲
         │ pairing / mTLS / rate limit              │ cloud OTA / fleet mgmt
         │                                          │
┌────────┴────────┐                       ┌─────────┴────────────┐
│   SDK Client    │                       │ Cloud Control Plane  │
│ (node/python/rs)│                       │  api.cognitum.one    │
└─────────────────┘                       └──────────────────────┘
```

### 2.1 Custody context

Owns identity, signing, and the tamper-evident audit trail. The aggregate
root is the **Witness Chain**.

- **Aggregate: Witness Chain**
  - Root: the ordered chain itself, addressed by `witness_chain_length`.
  - Invariants:
    - Every new entry MUST parent-hash the previous entry.
    - Every entry MUST be Ed25519-signed by the device's DICE key.
    - `epoch` is monotonic; writes advance it exactly once.
  - Commands: `POST /api/v1/custody/witness`, `POST /api/v1/custody/sign`,
    `POST /api/v1/custody/verify`.
  - Queries: `GET /api/v1/custody/attestation`, `GET /api/v1/custody/epoch`,
    `GET /api/v1/witness/chain`, `POST /api/v1/witness/verify`.
- **Entity: Device Identity**
  - Identified by `device_id` (UUID); holds Ed25519 public key.
  - Regenerated when the slot hash changes → forward secrecy for sealed data.
  - Exposed via `GET /api/v1/identity`.
- **Value objects**: `Epoch`, `WitnessEntry { parent_hash, action_hash, signature }`,
  `AttestationChain` (list of `{stage, sha256}`), `Signature` (base64 Ed25519).
- **Domain events**: `WitnessEntryAppended`, `EpochAdvanced`, `IdentityRotated`
  (firmware update), `AttestationPublished`.

### 2.2 Optimizer context

Owns the vector store and the derived structure (kNN, boundary, coherence,
drift). Aggregate roots: **Vector Store** and **Coherence Profile**.

- **Aggregate: Vector Store**
  - Root: RVF file at `/var/lib/cognitum/rvf-store/`.
  - Invariants:
    - Vector IDs are content-addressed (`truncate_u64(SHA-256(dim‖bytes))`);
      ingesting the same vector twice is idempotent.
    - `dimension` is fixed per store and cannot change while entries exist.
    - Deletes are soft (`flags = 1`), preserving append-only history.
    - Batch ingest produces a single fsync.
  - Commands: `POST /api/v1/store/ingest`, `POST /api/v1/store/delete`,
    `POST /api/v1/store/sync`, `POST /api/v1/optimize/trigger`,
    `POST /api/v1/boundary/recompute`.
  - Queries: `POST /api/v1/store/query`, `GET /api/v1/store/status`,
    `GET /api/v1/store/sync`, `GET /api/v1/optimize/{status,metrics}`,
    `GET /api/v1/boundary`.
- **Aggregate: Coherence Profile**
  - Root: latest profile at `GET /api/v1/coherence/profile`.
  - Invariants: `slice_count > 0`; `is_partial = true` until 120 slices;
    updates only on every 5th slice.
  - Queries: `GET /api/v1/coherence/{profile,profile/history,phases,orphans}`.
  - Commands: `PUT /api/v1/coherence/config` (paired).
- **Entities**: `VectorEntry { id, values, metadata }`,
  `PhaseBoundary { epoch_range, persistence_score }`,
  `BoundaryReport { fragility, cut_cost, partition_sizes, boundary_hash, boundary_epoch }`.
- **Value objects**: `Dimension`, `DistanceMetric` (`cosine|euclidean|dot`),
  `QueryResult { id, distance, metadata }`, `DriftState { detected, severity }`.
- **Domain events**: `VectorsIngested`, `VectorsDeleted`, `OptimizerCycleCompleted`,
  `BoundaryRecomputed`, `CoherenceProfileUpdated`, `PhaseBoundaryDetected`,
  `DriftDetected`, `OrphanIdentified`.

### 2.3 Delivery context

Owns distribution: delta streams of store changes, firmware OTA bundles,
"delivery image" metadata.

- **Aggregate: Delivery Image**
  - Queries: `GET /api/v1/delivery/image`, `GET /api/v1/delta/history`.
  - Streams (501 placeholder today): `GET /api/v1/delta/stream` (SSE).
- **Aggregate: Firmware Bundle** (RVF on the wire)
  - Segments: `MANIFEST_SEG`, `KERNEL_SEG?`, `WITNESS_SEG`, `CRYPTO_SEG`,
    `DATA_SEG`. `seed/docs/seed/rvf-format.md:85-113`
  - Invariants: signed by the build key (Ed25519); in lockdown, additionally
    signed by device-specific key.
- **Value objects**: `SlotHash`, `FirmwareVersion`, `BuildProvenance`.
- **Domain events**: `DeltaEmitted`, `FirmwarePublished`, `UpdateApplied`,
  `RollbackTriggered`.

### 2.4 Sensing context (supporting)

- **Aggregate: Sensor Loop** — 10 Hz sampling, six synthetic channels,
  45-dim embedding.
- **Aggregate: Reflex Arc** — safety-first rules with cooldowns.
- **Entities**: `Sensor`, `Actuator`, `ReflexRule`, `CoprocessorLink`.
- **Value objects**: `ChannelReading`, `SensorEmbedding`,
  `DriftDetectorState { page_hinkley, adwin, esn, hd_gate }`.
- **Commands (paired)**: `PUT /api/v1/sensor/embedding/config`,
  `POST /api/v1/sensor/actuator/fire/{name}`, `PUT /api/v1/sensor/reflex/rules`.
- **Domain events**: `SensorSampled`, `EmbeddingProduced`, `DriftTriggered`,
  `ActuatorFired`, `ReflexRuleUpdated`.

### 2.5 Platform context (generic)

- **Aggregate: Pairing Session** — window-bound (30 s), at most one open.
- **Aggregate: Rate-Limit Ledger** — GCRA per-IP, 256 IP LRU.
- **Aggregate: Thermal Governor** — DVFS state machine.
- **Aggregate: Boot Attestation** — immutable after first measurement.
- **Domain events**: `PairingOpened`, `PairingClosed`, `ClientPaired`,
  `ClientUnpaired`, `RateLimited`, `IpBlocked`, `ThermalZoneChanged`,
  `TurboBurstFired`, `LockdownActivated`.

### 2.6 Operator context

- Guide HTML and demo routes (`/api/v1/demo/*`, `/api/v1/profiles`).
  Not safety-critical; SDKs MAY ignore.

## 3. Context map (relationships)

| Upstream | Downstream | Relationship |
|----------|-----------|--------------|
| Custody | Optimizer | **Shared Kernel** — `epoch` and `WitnessChain` are both consumed by Optimizer (every ingest appends a witness). |
| Optimizer | Delivery | **Customer / Supplier** — Delivery reads optimized state but cannot mutate it. |
| Platform | All | **Conformist** — every context MUST accept pairing/rate-limit outcomes. |
| Sensing | Optimizer | **Published Language** — 45-dim sensor embedding is a first-class `Vector`. |
| Cloud control plane | Seed | **Anti-corruption layer** — OTA + fleet APIs translate between cloud vocabulary (`seedRegisterDevice`, `seedCheckUpdate`) and seed vocabulary (`identity`, `attestation`). SDK `devices.*` modules live on this layer. |
| SDK | Seed | **Conformist** — SDKs MUST use ubiquitous language verbatim. |

## 4. Domain-event catalog (for SDK observers)

Events the SDKs may wish to expose as typed callbacks or SSE stream records,
even when the seed returns 501 today.

| Event | When | Carrier today |
|-------|------|---------------|
| `VectorsIngested` | After `POST /store/ingest` | response JSON |
| `VectorsDeleted` | After `POST /store/delete` | response JSON |
| `OptimizerCycleCompleted` | Background after `POST /optimize/trigger` | `GET /optimize/metrics` |
| `BoundaryRecomputed` | Background after `POST /boundary/recompute` | `GET /boundary` |
| `CoherenceProfileUpdated` | Every 5 slices (~50 s) | `GET /coherence/profile` poll or SSE (501) |
| `DriftDetected` | Detector threshold crossed | `GET /sensor/drift/status` poll |
| `ThermalZoneChanged` | DVFS transition | `GET /thermal/state` poll |
| `PairingOpened` / `Closed` | `POST /pair`, window expiry | `GET /pair/status` |
| `WitnessEntryAppended` | After any write op | `GET /witness/chain` tail |
| `DeltaEmitted` | Every store mutation | `GET /delta/history`, SSE (501) |

## 5. Invariants the SDK MUST surface as types

These become type-level guarantees in each SDK:

1. `Dimension` is a positive integer equal to `store.status.dimension`; a
   query vector whose length differs MUST be rejected client-side with a
   `ValidationError` before the round-trip.
2. `Epoch` is monotonic; comparing epochs across responses is meaningful.
3. `DeviceId` is a UUIDv4; SDKs SHOULD treat it as opaque and never parse.
4. `VectorId` is a `u64` on the wire, NOT the user-supplied string ID. Two
   IDs are returned: the string `id` the user sent on ingest (echoed), and
   the numeric content-hash `id` returned on query.
5. `DistanceMetric`, `ThermalZone`, `OrderStatus`, `PairingState` are closed
   enums; unknown variants SHOULD round-trip as `Unknown(raw)` rather than
   error, so SDKs can coexist with newer seed firmware.

## 6. Anti-corruption surface

The SDK sits between two vocabularies:

- **Cloud control plane** uses camelCase, HTTPS-at-the-edge, and API-key auth
  (`/seedRegisterDevice`, `deviceId`, `firmwareVersion`, `clientSecret`).
- **Seed direct** uses snake_case, self-signed TLS, and pairing tokens
  (`device_id`, `total_vectors`, `temp_c`).

Every SDK MUST translate both into the ubiquitous language in §1 before the
type escapes the SDK boundary. Wire-format inconsistency is an ACL concern,
not a domain concern.

## 7. Non-goals of the domain model

The following are explicitly NOT part of the SDK domain and MUST NOT bleed
into public types:

- Cog runtime, WASM sandboxing, seccomp filters.
- Mesh transport and QUIC-lite.
- Silicon characterization, overclock profiles, turbo burst scheduler
  internals (SDKs read the state, they do not drive it).
- sql.js, AgentDB, HNSW, DiskANN implementation details on either side of
  the wire.
- Anything related to the legacy `sdk-typescript/` chip simulator (see
  ADR-0012).

## References

- Seed appliance README: `seed/docs/seed/README.md`
- API reference (ground truth): `seed/docs/seed/api-reference.md`
- Security model: `seed/docs/seed/security-model.md`
- RVF format: `seed/docs/seed/rvf-format.md`
- Rate limiter implementation: `seed/src/cognitum-agent/src/rate_limit.rs:27-40`
- HTTP server: `seed/src/cognitum-agent/src/http.rs:120-156`
- Router (vector DB): `seed/src/cognitum-agent/src/router.rs:96-128`
