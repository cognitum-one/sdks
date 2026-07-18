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
├── 0016a-seed-client-configuration-single-and-mesh-decisions.md
├── 0016b-seed-client-configuration-signatures-and-lifecycle.md
├── 0017-phase-1-5-mesh-implementation-plan.md
├── 0018-sd-card-flashing-tool.md
├── 0019-agentic-platform-bounded-contexts.md
├── 0020-agentic-contract-source-of-truth-and-code-generation.md
├── 0021-agentic-service-configuration-transports-and-capabilities.md
├── 0022-agentic-auth-tenant-budget-secret-and-consent-isolation.md
├── 0023-agentic-errors-retries-idempotency-cancellation-and-time-budgets.md
├── 0024a-meta-llm-serving-protocols-and-streaming.md
├── 0024b-meta-llm-platform-resources-routing-and-usage.md
├── 0025a-meta-proxy-client-routing-and-consent.md
├── 0025b-meta-proxy-lifecycle-integrity-and-ga-gates.md
├── 0026a-oss-metaharness-identity-bridge-and-api.md
├── 0026b-metaharness-process-filesystem-and-npx-supply-chain.md
├── 0027a-harnessaas-jobs-events-approvals-and-artifacts.md
├── 0027b-harnessaas-isolation-evidence-webhooks-and-ga-gates.md
├── 0028-agentic-telemetry-usage-receipts-lineage-and-redaction.md
├── 0029-language-packaging-features-and-cli.md
├── 0030a-conformance-ci-and-release-evidence.md
├── 0030b-migration-rollout-and-publication.md
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
11. [`0016a-seed-client-configuration-single-and-mesh-decisions.md`](0016a-seed-client-configuration-single-and-mesh-decisions.md) —
    Nine decisions locking the `SeedClient` configuration shape for both
    single-seed and mesh-of-seeds modes. **Trigger for Phase 1 seed-client
    implementation** across all three SDKs.
12. [`0016b-seed-client-configuration-signatures-and-lifecycle.md`](0016b-seed-client-configuration-signatures-and-lifecycle.md) —
    Language-agnostic constructor/method signatures, Node/Python/Rust
    examples, mesh lifecycle, and conformance test matrix realising
    ADR-0016a.
13. [`0017-phase-1-5-mesh-implementation-plan.md`](0017-phase-1-5-mesh-implementation-plan.md) —
    Work-breakdown + rollout order realising ADR-0016a/b; Phase 1.5
    delivered across all three SDKs 2026-04-22/23.
14. [`0018-sd-card-flashing-tool.md`](0018-sd-card-flashing-tool.md) —
    **Proposed** — new first-party `cognitum-seed-flash` Rust binary
    tool codifying the seed-image flashing recipe from project
    `CLAUDE.md`; thin `seed.images.*` read-only helpers in each SDK.
15. [`0019-agentic-platform-bounded-contexts.md`](0019-agentic-platform-bounded-contexts.md) —
    Separate bounded contexts and public namespaces for Meta LLM, Meta Proxy,
    OSS MetaHarness, and HarnessaaS.
16. [`0020-agentic-contract-source-of-truth-and-code-generation.md`](0020-agentic-contract-source-of-truth-and-code-generation.md) —
    Immutable contract bundles, protocol identity, internal code generation,
    and source-drift reconciliation.
17. [`0021-agentic-service-configuration-transports-and-capabilities.md`](0021-agentic-service-configuration-transports-and-capabilities.md) —
    Product-specific origins, transport metadata, capability expressions,
    concurrency, and fail-closed preconditions.
18. [`0022-agentic-auth-tenant-budget-secret-and-consent-isolation.md`](0022-agentic-auth-tenant-budget-secret-and-consent-isolation.md) —
    Credential, tenant, budget, secret, delegated-access, and routing-consent
    isolation.
19. [`0023-agentic-errors-retries-idempotency-cancellation-and-time-budgets.md`](0023-agentic-errors-retries-idempotency-cancellation-and-time-budgets.md) —
    Shared error taxonomy, canonical idempotency binding, retry boundaries,
    cancellation, and durable-operation handles.
20. [`0024a-meta-llm-serving-protocols-and-streaming.md`](0024a-meta-llm-serving-protocols-and-streaming.md)
    and [`0024b-meta-llm-platform-resources-routing-and-usage.md`](0024b-meta-llm-platform-resources-routing-and-usage.md) —
    Direct Meta LLM serving protocols, streams, platform resources, routing,
    usage, and GA gates.
21. [`0025a-meta-proxy-client-routing-and-consent.md`](0025a-meta-proxy-client-routing-and-consent.md)
    and [`0025b-meta-proxy-lifecycle-integrity-and-ga-gates.md`](0025b-meta-proxy-lifecycle-integrity-and-ga-gates.md) —
    Narrow loopback Proxy client semantics and an independently injected,
    integrity-verified lifecycle provider.
22. [`0026a-oss-metaharness-identity-bridge-and-api.md`](0026a-oss-metaharness-identity-bridge-and-api.md)
    and [`0026b-metaharness-process-filesystem-and-npx-supply-chain.md`](0026b-metaharness-process-filesystem-and-npx-supply-chain.md) —
    OSS product identity, a structured process bridge, exact npm distribution
    integrity, and crash-recoverable workspace mutation.
23. [`0027a-harnessaas-jobs-events-approvals-and-artifacts.md`](0027a-harnessaas-jobs-events-approvals-and-artifacts.md)
    and [`0027b-harnessaas-isolation-evidence-webhooks-and-ga-gates.md`](0027b-harnessaas-isolation-evidence-webhooks-and-ga-gates.md) —
    Asynchronous solves, resumable events, approvals, artifacts, fail-closed
    execution isolation, signed evidence, and durable webhooks.
24. [`0028-agentic-telemetry-usage-receipts-lineage-and-redaction.md`](0028-agentic-telemetry-usage-receipts-lineage-and-redaction.md) —
    Cross-product observability, cost observations, receipts, lineage, evidence
    verification, and recursive redaction.
25. [`0029-language-packaging-features-and-cli.md`](0029-language-packaging-features-and-cli.md) —
    Node, Python, and Rust package boundaries, optional features, canonical
    symbols, CLI behavior, and implementation layout.
26. [`0030a-conformance-ci-and-release-evidence.md`](0030a-conformance-ci-and-release-evidence.md)
    and [`0030b-migration-rollout-and-publication.md`](0030b-migration-rollout-and-publication.md) —
    Twelve-binding conformance, adversarial CI, migration, unique work
    breakdown, staged rollout, and coordinated publication.

Then jump into the per-SDK folders:

| SDK | Location | Start here |
|-----|----------|------------|
| Node / TypeScript | [`sdks/node/docs/adr/`](../../sdks/node/docs/adr/) | [`README.md`](../../sdks/node/docs/adr/README.md) |
| Python | [`sdks/python/docs/adr/`](../../sdks/python/docs/adr/) | [`README.md`](../../sdks/python/docs/adr/README.md) |
| Rust | [`sdks/rust/docs/adr/`](../../sdks/rust/docs/adr/) | [`README.md`](../../sdks/rust/docs/adr/README.md) |

## File naming

- ADRs: `NNNN-kebab-title.md` starting at `0001-`.
- Multi-part ADRs split at ~500 lines: `NNNN{a,b,c}-kebab-title.md`.
- An unsuffixed family reference such as ADR-0025 means every part of that
  numbered decision; normative requirements cite the exact part when only one
  part applies.
- DDD docs under `ddd/`.
- Each ADR cites source with `path:line` refs so claims are verifiable.

## Scope

| In scope | Out of scope |
|----------|-------------|
| `sdks/node/`, `sdks/python/`, `sdks/rust/` | Chip simulator (ADR-0012 Executed) |
| Seed HTTP API at `https://169.254.42.1:8443/api/v1/*` | Direct mesh, cog runtime, OTA internals |
| Cloud control plane at `https://api.cognitum.one/*` | Stripe payments plumbing (sits behind `orders`) |
| Shared wire, auth, error, retry, versioning | Internal seed subsystems (see seed repo ADRs) |
| Direct Meta LLM serving and platform APIs | Meta LLM deployment or provider internals |
| Authenticated loopback Meta Proxy client and injected lifecycle provider | Treating Meta Proxy as a complete Meta LLM transport |
| Public OSS `metaharness` structured bridge and verified local execution | Private commercial MetaHarness composition |
| HarnessaaS jobs, approvals, artifacts, webhooks, receipts, and lineage | Process-only execution of untrusted customer commands |

## Agentic integration source audit log

The agentic ADR series is bound to immutable source revisions. Registry state is
reported separately because published package identity can differ from source.

| Repository or registry | Audited revision or state | Date |
|------------------------|---------------------------|------|
| `cognitum-one/sdks` | `bccae6a3bfd8e0a59bc251738bf992852917a00f` | 2026-07-18 |
| `ruvnet/metaharness` | `072b95c0a74610de008dca5473343a81619cef20` | 2026-07-18 |
| `cognitum-one/metaharness` | `fc8845f3bfdb67f1ab6d99547cc98e3b57717029` | 2026-07-18 |
| `cognitum-one/meta-llm` | `948bd31a67a6daf3cf5888e06be64e732027be13` | 2026-07-18 |
| `cognitum-one/meta-proxy` | `43427e92ee0527413ca71744b538035537e0b6ef` | 2026-07-18 |
| `cognitum-one/harnessaas` | `908e4a99332617fd321d6f23a1d5a70e07413ffa` | 2026-07-18 |
| npm `metaharness` | Published `0.4.0`; reviewed source manifest reports `0.4.1` | 2026-07-18 |

## Seed release audit log

ADRs are synced to a specific seed firmware tag. When the seed ships a new
release, sync-check + update in place rather than forking a new ADR.

| Seed tag | Date | Impact on ADRs |
|----------|------|----------------|
| `v0.10.13` | 2026-04-22 | Initial ADR authoring baseline (submodule HEAD `76e5077`). |
| `v0.20.0`  | 2026-04-22 | Synced. Changes applied: ADR-0002 added OTA group (`/upgrade/apply`, `/upgrade/check`, `/ota/config` GET/POST, `/ota/log`, **`/ota/check-now`** new); ADR-0003 added WiFi-read allowlist + `/pair/window` authed-admin override (seed commits [#39](https://github.com/cognitum-one/seed/pull/39), [#43](https://github.com/cognitum-one/seed/pull/43)). SDK-facing endpoint count = 71 on v0.20.0 (see ADR-0002 §Endpoint inventory; earlier revisions cited 63/69). Hostname in seed examples moved `cognitum-v0.local` → `cognitum.local` (#37); no ADR used the old hostname so no change needed. Internal seed fixes (rustls `UnexpectedEof` tolerance #35, mesh `peer_id` dual-field #35) are transport-layer and do not impact SDK-facing contracts — reqwest handles the same rustls case internally. |
| `v0.20.0`  | 2026-04-22 | ADR-0016a/0016b authored. No new seed release; this ADR is the trigger for Phase 1 `SeedClient` implementation (issue `cognitum-one/sdks#2`). ADR-0011 Phase 1 rollout note patched to cite ADR-0016 as the mesh-support gate. |

## Open questions tracked across ADRs

Status legend: **Open** = active, owner must resolve; **Answered** = decision
locked in an ADR but implementation pending; **Resolved** = decision locked and
shipped/verified.

| # | Question | Owner | Status |
|---|----------|-------|--------|
| OQ-1 | Auth-header inconsistency: Node/Python use `X-API-Key`, Rust uses `Authorization: Bearer`. Which is canonical? | ADR-0003 + Rust impl (0014b) | **Answered 2026-04-22** — `X-API-Key` canonical (ADR-0003 §"Cloud auth"); Rust fix tracked at cognitum-one/sdks#10. Close once Rust 0.2.0 ships. |
| OQ-2 | No SDK currently implements the seed-direct API. Ship as submodule/subpath per SDK, or separate packages? | ADR-0011 | **Answered 2026-04-22** — one-family / subpath-per-SDK (ADR-0011 §Decision). Implementation phasing now in ADR-0011 §"Rollout phasing". Configuration shape for Phase 1 (single + mesh modes) locked in ADR-0016a/0016b. Close once each SDK ships Phase 1. |
| OQ-3 | `/api/v1/delta/stream` and `/api/v1/sensor/stream` return 501. When do SSE streams land? Ship placeholder stream types now? | ADR-0002 | **Open** — SDKs ship typed handles now and surface `NotImplementedError` on 501. Note: live v0.20.0 `/delta/stream` returns a 200 JSON snapshot (seed issue cognitum-one/seed#48), so the 501 path is seed-version-dependent; SDKs must handle both. |
| OQ-4 | `sdks/node/src/mcp-stdio.ts` + `mcp.ts` — split MCP transports (stdio local, HTTP cloud). Python/Rust only ship HTTP. Parity required? | Node/Python/Rust arch + impl ADRs | **Answered 2026-04-23** — Node ships both (ADR-0015c §9). **Rust**: stdio parity landed 2026-04-23 via `src/mcp/transport.rs` + `src/mcp/stdio.rs` (`Transport` trait, `HttpTransport`, `StdioTransport::builder()`, `McpClient`) with 5 green integration tests in `tests/mcp_stdio.rs` (ADR-0014c §"MCP stdio parity (OQ-4, 2026-04-23)"). **Python**: stdio parity landed 2026-04-23 via `cognitum/mcp/` package (`McpClient`, `StdioTransport`, `HttpTransport`, `Transport` Protocol) with 19 green tests in `tests/mcp/` (ADR-0013c §"MCP stdio parity (OQ-4, 2026-04-23)"). All three SDKs now ship both transports. |
| OQ-5 | `X-Signature` / `X-Signed` headers allowed by seed CORS (`seed/src/cognitum-agent/src/http.rs:148`) but no SDK signs requests. Signing scheme TBD. | ADR-0003 | **Open** — deferred. SDKs MUST NOT emit these headers until seed enforces them. Unblocks when the seed adds signature verification. |
| OQ-6 | `sdk-typescript/` package name `@ruv/cognitum-sdk` collided with `@cognitum/sdk`. | ADR-0012 | **Resolved 2026-04-22** — folder removed (ADR-0012 Executed). |
| OQ-7 | Error taxonomy: is every variant load-bearing? `ConflictError` / 409 has no seed producer today. | ADR-0004 | **Answered 2026-04-22** — kept as "reserved/future" in ADR-0004 (cloud orders will produce 409); no per-SDK test coverage required until a producer ships. |
| OQ-8 | 1.0 release criteria — when can SDKs drop the "pre-1.0 MINOR-breaking allowed" clause (ADR-0006)? | ADR-0006 | **Answered 2026-04-22** — criteria list added to ADR-0006 §"1.0 criteria". |
| OQ-9 | Cross-SDK trust-score protection: Python implements the 3-fail cutoff; do Node/Rust? | ADR-0007 | **Answered 2026-04-22** — ADR-0007 now MUST-requires all three SDKs to implement. Node per ADR-0015b §6; Rust per ADR-0014b §7.5; Python per ADR-0013b §6.1. |
| OQ-10 | POST idempotency surface: `idempotent=True` kwarg (Python) vs `Idempotency-Key` header. | ADR-0005 | **Answered 2026-04-22** — SDKs expose `idempotent` boolean opt-in per request (attestation); `Idempotency-Key` deferred until the seed or cloud honours it server-side. |
| OQ-11 | Tailscale-native peer discovery: should `DiscoveryProvider` include a built-in that reads the local tailnet (`tailscale status --json`) and filters for seeds? Seed does not advertise its tailnet name today. | ADR-0016a §D6 | **Answered 2026-04-23** — all three SDKs ship a `TailscaleDiscovery` provider that shells out to `tailscale status --json`, filters by a configurable hostname prefix (`cognitum-` default) or custom predicate, and maps each kept peer to `https://<DNSName>:<port>`. Stdlib-only (Node `child_process.execFile`; Python `subprocess.run`; Rust `std::process::Command` + `spawn_blocking`), no new deps, no feature flag. Tailnet carries no `device_id` / `tls_fingerprint` advertisements, so both stay `None`; callers wanting per-peer TLS pinning should combine with mDNS. Per-SDK impl notes: ADR-0015c §"Phase 3 — Tailscale discovery" (Node), ADR-0013c §"Phase 3 — Tailscale discovery" (Python), ADR-0014c §"Phase 3 — Tailscale discovery" (Rust). |
| OQ-12 | mDNS service type name: seed uses `_cognitum._tcp.local` (`seed/src/cognitum-agent/src/discovery.rs:99`). Is this the canonical SDK-facing service name, or should the SDK accept a configurable service type for air-gapped deployments that rename it? | ADR-0016a §D6 | **Open** — SDK ships `Mdns` provider with `service_type` as an optional override defaulting to `_cognitum._tcp.local`. No change needed unless an operator files a concrete use case. |
| OQ-13 | What are the production origins, exact protocol bundles, and stable operation inventories for Meta LLM and HarnessaaS? | Product owners + ADR-0020 | **Open** — SDKs require explicit origins and immutable reviewed bundles; no invented production default or GA claim. |
| OQ-14 | When will Meta LLM bind idempotency to the full ADR-0023 identity, persist complete replay results, and publish OAuth scope coverage per operation? | Meta LLM owner + ADR-0024a | **Open** — automatic POST replay remains disabled until conformance proves the corrected server contract. |
| OQ-15 | When will Meta Proxy publish one plane model, forwarding allowlist, authenticated selected-plane evidence, atomic ledger, and readiness challenge? | Meta Proxy owner + ADR-0025a/b | **Open** — affected routing, sponsored streaming, and lifecycle surfaces remain preview or blocked. |
| OQ-16 | Which exact OSS MetaHarness bridge distribution supersedes the npm `0.4.0` versus source `0.4.1` drift, and when will it publish complete JSONL schemas? | MetaHarness owner + ADR-0026a/b | **Open** — the SDK never parses human CLI prose or invokes mutable `npx` resolution internally. |
| OQ-17 | When will HarnessaaS publish durable asynchronous jobs, atomic submit idempotency, supported container or microVM isolation, signed evidence keys, and transactional webhooks? | HarnessaaS owner + ADR-0027a/b | **Open** — stable submit fails closed; legacy synchronous solve is preview-only and never executes untrusted commands through a process-only fallback. |
| OQ-18 | Which product revisions and live staging deployments are the first release candidates for the twelve-binding conformance matrix? | Release Engineering + ADR-0030a/b | **Open** — the signed release manifest must bind exact SDK artifacts, contract digests, product revisions, and deployment evidence before GA. |

