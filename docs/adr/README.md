# Cognitum SDK ADRs + Domain Model

Architecture Decision Records and Domain-Driven Design documentation for the
Cognitum SDK ecosystem. Ground truth for the domain is the **Cognitum Seed**
appliance firmware at `/home/ruvultra/projects/sdks/seed/` (git submodule).

## Layout

```
docs/adr/                           # this directory — shared / cross-cutting
├── 0001-adr-template.md
├── 0002-seed-wire-protocol.md
├── 0003-cross-cutting-auth-model.md
├── 0004-cross-cutting-error-taxonomy.md
├── 0005-cross-cutting-retry-backoff.md
├── 0006-cross-cutting-versioning.md
├── 0007-cross-cutting-security-model.md
├── 0011-sdk-scope-cloud-vs-seed.md
├── 0012-sdk-typescript-supersession.md     # Executed — sdk-typescript/ removed
└── ddd/
    └── seed-domain.md                       # read this first

sdks/node/docs/adr/                 # Node / TypeScript SDK (see per-SDK README)
sdks/python/docs/adr/               # Python SDK
sdks/rust/docs/adr/                 # Rust SDK
```

Per-SDK ADRs live with their SDK source so they travel together. Cross-cutting
ADRs (wire protocol, auth, errors, retry, versioning, security) stay here and
are referenced by each SDK's architecture + implementation ADRs.

## Reading order

1. [`ddd/seed-domain.md`](ddd/seed-domain.md) — DDD model of the Seed (bounded
   contexts, aggregates, value objects, domain events, ubiquitous language).
   **Read this first; every ADR references it.**
2. [`0001-adr-template.md`](0001-adr-template.md) — Template used for all ADRs.
3. [`0002-seed-wire-protocol.md`](0002-seed-wire-protocol.md) — The HTTP
   contract all three SDKs bind to for direct-to-Seed traffic.
4. [`0003-cross-cutting-auth-model.md`](0003-cross-cutting-auth-model.md) —
   Shared auth/signing model (X-API-Key, pairing token, mTLS).
5. [`0004-cross-cutting-error-taxonomy.md`](0004-cross-cutting-error-taxonomy.md) —
   Shared error taxonomy and HTTP status-code mapping.
6. [`0005-cross-cutting-retry-backoff.md`](0005-cross-cutting-retry-backoff.md) —
   Retry and rate-limit backoff policy.
7. [`0006-cross-cutting-versioning.md`](0006-cross-cutting-versioning.md) —
   API, SDK, and wire-version compatibility.
8. [`0007-cross-cutting-security-model.md`](0007-cross-cutting-security-model.md) —
   TLS, pairing, lockdown, mTLS, DICE identity.
9. [`0011-sdk-scope-cloud-vs-seed.md`](0011-sdk-scope-cloud-vs-seed.md) — Cloud
   control plane vs seed-direct client topology.
10. [`0012-sdk-typescript-supersession.md`](0012-sdk-typescript-supersession.md) —
    Historical disposition of the removed `sdk-typescript/` chip-simulator SDK.

Then jump into the per-SDK folders:

| SDK | Location | Start here |
|-----|----------|------------|
| Node / TypeScript | [`sdks/node/docs/adr/`](../../sdks/node/docs/adr/) | [`README.md`](../../sdks/node/docs/adr/README.md) |
| Python | [`sdks/python/docs/adr/`](../../sdks/python/docs/adr/) | [`README.md`](../../sdks/python/docs/adr/README.md) |
| Rust | [`sdks/rust/docs/adr/`](../../sdks/rust/docs/adr/) | [`README.md`](../../sdks/rust/docs/adr/README.md) |

## File naming

- ADRs: `NNNN-kebab-title.md` starting at `0001-`.
- Multi-part ADRs split at ~500 lines: `NNNN{a,b,c}-kebab-title.md`.
- DDD docs under `ddd/`.
- Each ADR cites source with `path:line` refs so claims are verifiable.

## Scope

| In scope | Out of scope |
|----------|-------------|
| `sdks/node/`, `sdks/python/`, `sdks/rust/` | Chip simulator (ADR-0012 Executed) |
| Seed HTTP API at `https://169.254.42.1:8443/api/v1/*` | Direct mesh, cog runtime, OTA internals |
| Cloud control plane at `https://api.cognitum.one/*` | Stripe payments plumbing (sits behind `orders`) |
| Shared wire, auth, error, retry, versioning | Internal seed subsystems (see seed repo ADRs) |

## Seed release audit log

ADRs are synced to a specific seed firmware tag. When the seed ships a new
release, sync-check + update in place rather than forking a new ADR.

| Seed tag | Date | Impact on ADRs |
|----------|------|----------------|
| `v0.10.13` | 2026-04-22 | Initial ADR authoring baseline (submodule HEAD `76e5077`). |
| `v0.20.0`  | 2026-04-22 | Synced. Changes applied: ADR-0002 added OTA group (`/upgrade/apply`, `/upgrade/check`, `/ota/config` GET/POST, `/ota/log`, **`/ota/check-now`** new); ADR-0003 added WiFi-read allowlist + `/pair/window` authed-admin override (seed commits [#39](https://github.com/cognitum-one/seed/pull/39), [#43](https://github.com/cognitum-one/seed/pull/43)). SDK-facing endpoint count = 71 on v0.20.0 (see ADR-0002 §Endpoint inventory; earlier revisions cited 63/69). Hostname in seed examples moved `cognitum-v0.local` → `cognitum.local` (#37); no ADR used the old hostname so no change needed. Internal seed fixes (rustls `UnexpectedEof` tolerance #35, mesh `peer_id` dual-field #35) are transport-layer and do not impact SDK-facing contracts — reqwest handles the same rustls case internally. |

## Open questions tracked across ADRs

Status legend: **Open** = active, owner must resolve; **Answered** = decision
locked in an ADR but implementation pending; **Resolved** = decision locked and
shipped/verified.

| # | Question | Owner | Status |
|---|----------|-------|--------|
| OQ-1 | Auth-header inconsistency: Node/Python use `X-API-Key`, Rust uses `Authorization: Bearer`. Which is canonical? | ADR-0003 + Rust impl (0014b) | **Answered 2026-04-22** — `X-API-Key` canonical (ADR-0003 §"Cloud auth"); Rust fix tracked at cognitum-one/sdks#10. Close once Rust 0.2.0 ships. |
| OQ-2 | No SDK currently implements the seed-direct API. Ship as submodule/subpath per SDK, or separate packages? | ADR-0011 | **Answered 2026-04-22** — one-family / subpath-per-SDK (ADR-0011 §Decision). Implementation phasing now in ADR-0011 §"Rollout phasing". Close once each SDK ships phase 1. |
| OQ-3 | `/api/v1/delta/stream` and `/api/v1/sensor/stream` return 501. When do SSE streams land? Ship placeholder stream types now? | ADR-0002 | **Open** — SDKs ship typed handles now and surface `NotImplementedError` on 501. Note: live v0.20.0 `/delta/stream` returns a 200 JSON snapshot (seed issue cognitum-one/seed#48), so the 501 path is seed-version-dependent; SDKs must handle both. |
| OQ-4 | `sdks/node/src/mcp-stdio.ts` + `mcp.ts` — split MCP transports (stdio local, HTTP cloud). Python/Rust only ship HTTP. Parity required? | Node/Python/Rust arch + impl ADRs | **Open** — Node ships both (ADR-0015c §9). Python/Rust parity deferred to 0.3.x — tracked but not 1.0-blocking. |
| OQ-5 | `X-Signature` / `X-Signed` headers allowed by seed CORS (`seed/src/cognitum-agent/src/http.rs:148`) but no SDK signs requests. Signing scheme TBD. | ADR-0003 | **Open** — deferred. SDKs MUST NOT emit these headers until seed enforces them. Unblocks when the seed adds signature verification. |
| OQ-6 | `sdk-typescript/` package name `@ruv/cognitum-sdk` collided with `@cognitum/sdk`. | ADR-0012 | **Resolved 2026-04-22** — folder removed (ADR-0012 Executed). |
| OQ-7 | Error taxonomy: is every variant load-bearing? `ConflictError` / 409 has no seed producer today. | ADR-0004 | **Answered 2026-04-22** — kept as "reserved/future" in ADR-0004 (cloud orders will produce 409); no per-SDK test coverage required until a producer ships. |
| OQ-8 | 1.0 release criteria — when can SDKs drop the "pre-1.0 MINOR-breaking allowed" clause (ADR-0006)? | ADR-0006 | **Answered 2026-04-22** — criteria list added to ADR-0006 §"1.0 criteria". |
| OQ-9 | Cross-SDK trust-score protection: Python implements the 3-fail cutoff; do Node/Rust? | ADR-0007 | **Answered 2026-04-22** — ADR-0007 now MUST-requires all three SDKs to implement. Node per ADR-0015b §6; Rust per ADR-0014b §7.5; Python per ADR-0013b §6.1. |
| OQ-10 | POST idempotency surface: `idempotent=True` kwarg (Python) vs `Idempotency-Key` header. | ADR-0005 | **Answered 2026-04-22** — SDKs expose `idempotent` boolean opt-in per request (attestation); `Idempotency-Key` deferred until the seed or cloud honours it server-side. |
