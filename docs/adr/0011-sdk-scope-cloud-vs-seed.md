# ADR 0011: SDK Scope — Cloud Control Plane vs Seed Direct

- **Status:** Proposed (addresses OQ-2)
- **Date:** 2026-04-22
- **Scope:** cross-cutting (sdks/node, sdks/python, sdks/rust)

## Context

The three SDKs under `sdks/node|python|rust/` all target
`https://api.cognitum.one` (cloud control plane), exposing seven resources:
`catalog`, `orders`, `leads`, `contact`, `devices`, `mcp`, `brain`. The
`devices` module reaches the *cloud* fleet manager (`/seedRegisterDevice`,
`/seedCheckUpdate`, `/seedHeartbeat`), NOT the seed itself.

The **Cognitum Seed** appliance exposes 71 SDK-facing endpoints under
`https://<seed>:8443/api/v1/*` on v0.20.0 (see ADR-0002 §Endpoint
inventory). None of the SDKs implement any of them today. A user who
plugs a seed into their laptop can curl it but cannot use
`@cognitum/sdk`, `cognitum` (Python), or `cognitum-rs` to talk to it
directly.

This ADR decides how and where that gap is filled.

## Decision

### Two packages, one family — shipped as subpaths (Node) / submodules (Python) / features (Rust), not separate crates/packages

#### Node: `@cognitum/sdk/seed` subpath export

- Cloud: `import { Cognitum } from '@cognitum/sdk'`
- Seed:  `import { SeedClient } from '@cognitum/sdk/seed'`
- `package.json` `exports` map adds:
  ```json
  "./seed": {
    "types": "./dist/seed/index.d.ts",
    "import": "./dist/seed/index.js",
    "require": "./dist/seed/index.cjs"
  }
  ```
- Tree-shakeable: consumers who only need one half import only that half.

#### Python: `cognitum.seed` submodule

- Cloud: `from cognitum import Cognitum, AsyncCognitum`
- Seed:  `from cognitum.seed import SeedClient, AsyncSeedClient`
- Single `pip install cognitum` pulls both; tree-shaking is not a concern
  in Python and lazy imports keep import cost down.

#### Rust: `cognitum_rs::seed` module behind `seed` feature

- Cloud: `use cognitum_rs::Client;`
- Seed:  `use cognitum_rs::seed::SeedClient;`
- `Cargo.toml`: `cognitum-rs = { version = "0.2", features = ["seed"] }`
- Feature-gated so cloud-only users pay no extra compile cost.

### Why one family instead of two packages

| Factor | One family | Separate packages |
|--------|-----------|-------------------|
| Release coordination | Simpler | Harder |
| Discoverability | Users find both | Risk of parallel universes |
| Type-sharing (error model, URL helpers) | Free | Requires a third "common" crate |
| Node bundle size | Tree-shakeable subpath handles it | Minor win |
| Python import cost | Lazy imports handle it | Neutral |
| Rust compile time | Feature-gated handles it | Neutral |

One family wins on every axis except the last. Decision: one family.

### Shared contract

- Both halves MUST share:
  - Error taxonomy (ADR-0004)
  - Retry/backoff (ADR-0005)
  - Versioning policy (ADR-0006)
  - Security rules (ADR-0007)
- Both halves MAY share:
  - Low-level HTTP plumbing (Node `HttpClient`, Python `_http.py`,
    Rust `request` helper), parameterized by the auth strategy.
  - CLI (see below).

### CLI

Each SDK's CLI gains seed subcommands alongside cloud ones:

```
cognitum cloud catalog browse
cognitum cloud devices list
cognitum seed status
cognitum seed pair my-laptop
cognitum seed query --vector 0.1,0.2,... --k 5
cognitum seed thermal state
```

The default host for `cognitum seed ...` is `169.254.42.1:8443` and can be
overridden with `--host` or `COGNITUM_SEED_HOST`.

### Capability probe

On `SeedClient` construction, do NOT auto-probe. Let the first real call
surface errors. Provide `seed.status()` as the canonical first-call the
user makes themselves; the roles array returned there lets the user decide
which methods to invoke.

### Future: direct SDK from cloud-returned seed address

A seed paired via the cloud fleet API (`POST /seedRegisterDevice`) gets a
public-ish address (typically a Tailscale node on the operator's tailnet).
Future work: `cloud.devices.seed(device_id)` returns a `SeedClient`
pre-configured to the device's Tailscale address and the pairing token held
by the cloud. Tracked under OQ-2 but explicitly out of scope for 0.1.

### Rollout phasing (closes the "OQ-2 answered but nothing ships" gap)

Implementing 71 endpoints × 3 SDKs in one PR is not realistic. Each SDK MUST
ship the seed-direct module in three phases. Phase 1 is the minimum viable
`SeedClient`; phases 2 and 3 may ship over subsequent MINOR releases.

**Phase 1 — MVP seed client (blocks 1.0; see ADR-0006 §"1.0 criteria" item 1):**

| Bounded context (DDD §2) | Endpoints |
|--------------------------|-----------|
| Custody — identity/status | `GET /api/v1/status`, `GET /api/v1/identity` |
| Pairing | `GET /api/v1/pair/status`, `POST /api/v1/pair`, `DELETE /api/v1/pair/{client_name}` |
| Optimizer — vector store | `GET /api/v1/store/status`, `POST /api/v1/store/ingest`, `POST /api/v1/store/query`, `POST /api/v1/store/delete` |
| Custody — witness/signing | `GET /api/v1/witness/chain`, `POST /api/v1/custody/sign`, `POST /api/v1/custody/verify`, `GET /api/v1/custody/attestation` |

Rationale: this covers the "ingest a vector, query it, prove custody" loop,
which is the primary user journey for Seed-direct.

**Phase 2 — observability + analysis (0.3.x):**

| Context | Endpoints |
|---------|-----------|
| Optimizer — analysis | `/optimize/*`, `/boundary`, `/boundary/recompute` |
| Temporal coherence | `/coherence/*` |
| Delivery | `/delivery/image`, `/delta/history`, `/delta/stream` (SSE placeholder) |
| Sensor — read-only | `/sensor/list`, `/sensor/latest/{name}`, `/sensor/drift/*`, `/sensor/embedding/*`, `/sensor/stream` (SSE placeholder) |
| OTA (read) | `/upgrade/check`, `/ota/config` (GET), `/ota/log` |

**Phase 3 — platform controls + writes (0.4.x+):**

| Context | Endpoints |
|---------|-----------|
| Thermal | all 13 `/thermal/*` routes |
| Sensor — writes | `/sensor/actuator/fire/{name}`, `/sensor/reflex/rules`, `/sensor/gpio/pins`, `/sensor/coprocessor/*` |
| OTA (write) | `/upgrade/apply`, `/ota/config` (POST), `/ota/check-now` |
| Demo / profiles | `/demo/*`, `/profiles` (MAY be permanently omitted as non-safety-critical per DDD §2.6) |

SDKs MUST NOT block a cross-cutting ADR change on phase-2/3 endpoints; a
PR that updates the retry policy or error taxonomy is expected to touch
only the endpoints the SDK has shipped.

## Consequences

### Positive

- Users of the cognitum brand get both cloud and seed in one `npm install`
  / `pip install` / Cargo crate.
- Forces the shared contract (auth, errors, retry) to stay coherent —
  drift would be immediately visible in the same codebase.

### Negative

- Every new cloud-only dependency leaks to seed-only users if we're not
  careful with subpaths/features. Hence the strict subpath/feature split.
- Three SDKs × two scopes = six surfaces to keep in parity. ADR-0006's
  compatibility matrix + conformance tests (ADR-0004) keep it honest.

## Alternatives considered

| Option | Why rejected |
|--------|--------------|
| Separate `@cognitum/seed` package | Fragmented brand; users confused about which to install. |
| Everything under one class | Couples cloud and seed credential lifecycles. |
| Seed support lives only in the seed repo as a Rust crate | Node/Python users left behind. |

## Compliance

- Conformance test suite contains one matrix: `(sdk_language) × (cloud, seed)`.
- Both halves MUST implement the same error taxonomy (unit-tested).
- Docs MUST include a "when to use cloud vs seed" decision tree in each
  SDK's `README.md`.

## References

- DDD model: `docs/adr/ddd/seed-domain.md` §6 (anti-corruption).
- Cloud client: `sdks/node/src/client.ts:10-11`,
  `sdks/python/cognitum/client.py:18`, `sdks/rust/src/client.rs:17-18`.
- Seed docs: `seed/docs/seed/api-reference.md`, `seed/docs/seed/sdk-guide.md`.
- Related: ADRs 0002, 0003, 0004, 0005, 0006, 0007, 0008, 0009, 0010.
