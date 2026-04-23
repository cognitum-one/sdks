# Rust SDK — ADRs

Architecture and implementation decisions for the `cognitum` crate
(`/home/ruvultra/projects/sdks/sdks/rust/`).

## Prerequisite reading (cross-cutting, in `docs/adr/`)

Start here — these apply to **all** SDKs and are referenced throughout:

- [`../../../../docs/adr/ddd/seed-domain.md`](../../../../docs/adr/ddd/seed-domain.md) — domain model + ubiquitous language
- [`../../../../docs/adr/0002-seed-wire-protocol.md`](../../../../docs/adr/0002-seed-wire-protocol.md) — HTTP contract
- [`../../../../docs/adr/0003-cross-cutting-auth-model.md`](../../../../docs/adr/0003-cross-cutting-auth-model.md) — X-API-Key is canonical (Rust currently sends Bearer — fixed in 0014b)
- [`../../../../docs/adr/0004-cross-cutting-error-taxonomy.md`](../../../../docs/adr/0004-cross-cutting-error-taxonomy.md) — 12-variant error taxonomy
- [`../../../../docs/adr/0005-cross-cutting-retry-backoff.md`](../../../../docs/adr/0005-cross-cutting-retry-backoff.md) — equal-jitter, 500ms base, 30s cap
- [`../../../../docs/adr/0006-cross-cutting-versioning.md`](../../../../docs/adr/0006-cross-cutting-versioning.md) — SemVer, forward-compat unknown fields
- [`../../../../docs/adr/0007-cross-cutting-security-model.md`](../../../../docs/adr/0007-cross-cutting-security-model.md) — TLS pinning, credential redaction via `SecretString`
- [`../../../../docs/adr/0011-sdk-scope-cloud-vs-seed.md`](../../../../docs/adr/0011-sdk-scope-cloud-vs-seed.md) — Cargo `seed` feature

## Rust-specific ADRs

Read in this order (cross-references form a chain):
`0014a → 0014d → 0014b → 0014e → 0014c`

| # | File | Topic |
|---|------|-------|
| 0010 | [`0010-rust-sdk-architecture.md`](0010-rust-sdk-architecture.md) | Architecture: reqwest + rustls, `seed` feature, `#[non_exhaustive] Error` |
| 0014a | [`0014a-rust-sdk-implementation-foundations.md`](0014a-rust-sdk-implementation-foundations.md) | Implementation §1–2: crate layout, feature flags, public API surface |
| 0014d | [`0014d-rust-sdk-implementation-wire-types-and-errors.md`](0014d-rust-sdk-implementation-wire-types-and-errors.md) | Implementation §3–5: typed models (7 structs), `Error` enum, transport + pinned TLS verifier |
| 0014b | [`0014b-rust-sdk-implementation-behaviors.md`](0014b-rust-sdk-implementation-behaviors.md) | Implementation §6–7: retry loop + jitter, auth fix (Bearer → X-API-Key), `SeedCredential` + `TokenStore` |
| 0014e | [`0014e-rust-sdk-implementation-streaming-tests-packaging.md`](0014e-rust-sdk-implementation-streaming-tests-packaging.md) | Implementation §8–10: SSE, wiremock + rstest, full `Cargo.toml` |
| 0014c | [`0014c-rust-sdk-implementation-release.md`](0014c-rust-sdk-implementation-release.md) | Implementation §11–15: CI matrix, criterion SLOs, examples, migration diff, open questions |

## Key Rust-specific decisions (from 0014x)

| Area | Decision |
|------|----------|
| Transport | `reqwest` with `rustls-tls` default, `http2_prior_knowledge()` |
| Features | `default = ["rustls"]`; optional `native-tls`, `seed` (implies `rustls`), `stream`, `blocking` |
| Typed models | `#[derive(Serialize, Deserialize)]` + `#[serde(flatten)] extras: Extras` newtype on responses |
| Strict writes | `#[serde(deny_unknown_fields)]` on request bodies only |
| Error enum | `#[non_exhaustive]` + 12 variants + `AuthReason` sub-enum; `thiserror`-driven |
| 403 disambiguation | Case-insensitive substring match on seed error string → `AuthReason` |
| Credential type | `SecretString` (or `secrecy` crate) with redacting `Debug` |
| 501 dispatch | SSE `open_sse` checks 501 before returning stream (fail-fast) |
| MSRV | 1.78 (stable `OnceLock`, saturating shift helpers) |
| Version | 0.1.x → 0.2.0 (pre-1.0 breaking `Error` changes per ADR-0006) |

## Open questions (Rust)

- **OQ-R1..OQ-R6** — enumerated in `0014c` §Open Questions.
- **OQ-1** (shared) — Bearer → X-API-Key fix: needs backend confirmation the cloud API won't silently accept Bearer.
- **OQ-4** (shared) **Answered 2026-04-23** — Rust ships both HTTP and
  stdio transports via `src/mcp/transport.rs` + `src/mcp/stdio.rs`
  (`Transport` trait, `HttpTransport`, `StdioTransport::builder()`,
  `McpClient`). See
  [`0014c-rust-sdk-implementation-release.md`](0014c-rust-sdk-implementation-release.md)
  §"MCP stdio parity".
