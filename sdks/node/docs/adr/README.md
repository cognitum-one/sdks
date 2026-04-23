# Node / TypeScript SDK — ADRs

Architecture and implementation decisions for `@cognitum/sdk`
(`/home/ruvultra/projects/sdks/sdks/node/`).

## Prerequisite reading (cross-cutting, in `docs/adr/`)

Start here — these apply to **all** SDKs and are referenced throughout:

- [`../../../../docs/adr/ddd/seed-domain.md`](../../../../docs/adr/ddd/seed-domain.md) — domain model + ubiquitous language
- [`../../../../docs/adr/0002-seed-wire-protocol.md`](../../../../docs/adr/0002-seed-wire-protocol.md) — HTTP contract
- [`../../../../docs/adr/0003-cross-cutting-auth-model.md`](../../../../docs/adr/0003-cross-cutting-auth-model.md) — X-API-Key, pairing, mTLS
- [`../../../../docs/adr/0004-cross-cutting-error-taxonomy.md`](../../../../docs/adr/0004-cross-cutting-error-taxonomy.md) — 12-variant error taxonomy
- [`../../../../docs/adr/0005-cross-cutting-retry-backoff.md`](../../../../docs/adr/0005-cross-cutting-retry-backoff.md) — equal-jitter, 500ms base, 30s cap
- [`../../../../docs/adr/0006-cross-cutting-versioning.md`](../../../../docs/adr/0006-cross-cutting-versioning.md) — SemVer, forward-compat unknown fields
- [`../../../../docs/adr/0007-cross-cutting-security-model.md`](../../../../docs/adr/0007-cross-cutting-security-model.md) — TLS pinning, credential redaction
- [`../../../../docs/adr/0011-sdk-scope-cloud-vs-seed.md`](../../../../docs/adr/0011-sdk-scope-cloud-vs-seed.md) — subpath `@cognitum/sdk/seed`

## Node-specific ADRs

| # | File | Topic |
|---|------|-------|
| 0008 | [`0008-node-sdk-architecture.md`](0008-node-sdk-architecture.md) | Architecture: fetch + AbortController, subpath export, zero runtime deps, vitest |
| 0015a | [`0015a-node-sdk-implementation.md`](0015a-node-sdk-implementation.md) | Implementation §1–3: package layout, public API, typed models |
| 0015b | [`0015b-node-sdk-implementation.md`](0015b-node-sdk-implementation.md) | Implementation §4–7: errors, transport, retry, auth |
| 0015c | [`0015c-node-sdk-implementation.md`](0015c-node-sdk-implementation.md) | Implementation §8–16: streaming, MCP parity, tests, packaging, CI, benches, migration |

## Key Node-specific decisions (from 0015x)

| Area | Decision |
|------|----------|
| Node floor | `>=20.0.0` (ADR-0008 said 18; raised for undici TLS pinning + EOL) |
| Transport | `undici.Agent` in `dependencies` (not zero-dep) — `fetch` alone can't do TLS pinning |
| HTTP agent | per-client (credential lifetime isolation) |
| Test runner | `vitest` retained over `node:test` |
| Runtime validation | `zod` as `optionalDependencies` behind `validateResponses: boolean` |
| Retry cap | 30s (fixes current 16s at `sdks/node/src/client.ts`) |
| MCP | stdio + HTTP transports; new `createStdioTransport` client symbol |
| Version target | `0.1.3 → 0.2.0` (pre-1.0 breaking errors allowed per ADR-0006) |

## Open questions (Node)

- **OQ-N1** `undici.Agent` per-client vs global — defaulted to per-client.
- **OQ-N2** `vitest` vs `node:test` — kept vitest pending tooling re-evaluation.
- **OQ-4** (shared) **Resolved 2026-04-23** — all three SDKs now ship
  stdio + HTTP MCP transports. Python via `cognitum.mcp`, Rust via
  `src/mcp/{transport,stdio}.rs`. See cross-ADR README OQ table.
