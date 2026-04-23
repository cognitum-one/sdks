# ADR 0008: Node SDK Architecture

- **Status:** Accepted (Cloud scope). Seed-direct module Proposed (ADR-0011).
- **Date:** 2026-04-22
- **Scope:** sdks/node
- **Package:** `@cognitum/sdk` (`sdks/node/package.json:2`)

## Context

`sdks/node/` ships an ESM+CJS dual package targeting Node 18+ that currently
covers the Cognitum Cloud control plane (`https://api.cognitum.one`). It
exposes seven resource modules: `catalog`, `orders`, `leads`, `contact`,
`devices` (cloud fleet ops), `mcp` (HTTP), `brain`, plus an `mcp-stdio`
bridge for Claude-like local MCP clients.

Existing source of truth:

- Entry point: `sdks/node/src/index.ts:22-49`
- HTTP client: `sdks/node/src/client.ts:10-168`
- Errors: `sdks/node/src/errors.ts:1-53`
- MCP over HTTP: `sdks/node/src/mcp.ts`
- MCP over stdio: `sdks/node/src/mcp-stdio.ts`
- Build: `sdks/node/tsup.config.ts` (tsup → ESM + CJS + `.d.ts`)
- Tests: `sdks/node/tests/client.test.ts` (vitest)

## Decision

### Transport

- HTTP via the global `fetch` (Node 18+). No `axios`, no `undici` direct
  dependency — keep dependency graph minimal.
- `AbortController` per attempt for timeouts
  (`sdks/node/src/client.ts:62-64`). Retain this pattern.
- Per ADR-0002, the Seed-direct module ships as a separate subpath export
  `@cognitum/sdk/seed` with its own default host `https://169.254.42.1:8443`
  and uses the same `fetch` under a dedicated `tls.Agent` that accepts the
  seed self-signed cert for the pinned host list only (ADR-0007).

### Auth

- `new Cognitum({ apiKey })` — cloud credential.
- `new SeedClient({ host, pairingToken?, clientCert? })` (future) — seed
  credentials. Separate class to avoid coupling cloud and seed lifetimes.
  <!-- ❌ failing 2026-04-22 (issue cognitum-one/sdks#2) — no SeedClient in 0.1.3. -->
- API key resolution: explicit → `process.env.COGNITUM_API_KEY` →
  `AuthError` at construction.
  <!-- ❌ failing 2026-04-22 (issue cognitum-one/sdks#7) — env fallback not wired; explicit arg required or constructor throws. -->
- See ADR-0003 for the canonical `X-API-Key` decision (Node is already
  compliant). <!-- ✅ verified 2026-04-22 against seed v0.20.0 (reports/node.json cross_cutting auth-header). -->

### Retry / rate-limit strategy

Per ADR-0005:

- `retries: 3`, `timeout: 30_000`, `rateLimitRetry: true` (retain current
  defaults — `client.ts:11-14`).
- Replace `backoff` base from `1s * 2^attempt` to `500ms * 2^attempt` with
  equal-jitter. Cap at 30 s (not 16 s).
  <!-- ❌ failing 2026-04-22 (issue cognitum-one/sdks#5) — 0.1.3 still base=1s, cap=16s, no jitter, no maxElapsedMs. -->
- Track `totalElapsedMs` and hard-stop at 60 s.
- Respect `Retry-After` header (already done, `client.ts:180-195`) AND the
  seed's `retry_after_us` JSON body (add in the seed module).
  <!-- ❌ failing 2026-04-22 (issue cognitum-one/sdks#6) — header parsed; retry_after_us / JSON body ignored. -->

### Type / schema strategy

- Hand-written `interface` types in `src/types.ts`. No runtime validation
  (keeps bundle tiny). Unknown fields are ignored by TypeScript and simply
  round-trip through the `object` spread.
- Response narrowing is the caller's job; `fetch` returns `unknown`, we cast
  via `response.json() as T`.
- For seed endpoints with snake_case payloads, define types in
  `src/seed/types.ts` preserving snake_case on the wire boundary, and
  expose camelCase getters when helpful (do NOT re-camelCase the payload
  eagerly — leave it verbatim to avoid runtime cost).

### Error model

Per ADR-0004:

- Keep existing `CognitumError`, `AuthError`, `RateLimitError`,
  `ValidationError`, `NotFoundError` classes.
- Add `NotImplementedError` (501), `ConflictError` (409),
  `ServiceUnavailableError` (503), `NetworkError`, `TimeoutError`,
  `ParseError`.
- Add `AuthError.reason` string enum (`'no_credentials' | 'invalid_credentials'
  | 'not_paired' | 'pairing_window_closed' | 'lockdown_mtls_required' |
  'trust_score_blocked'`).
- Expose `error.rawBody`, `error.correlationId`, `error.cause`.
- MUST use `Object.setPrototypeOf(this, new.target.prototype)` on every
  subclass for cross-realm `instanceof` (already done, `errors.ts:14`).

### Streaming & pagination

- SSE: Implement a `seed.sensor.streamReadings()` and
  `seed.delta.stream()` that return `AsyncIterable` over typed events,
  backed by `fetch(..., { headers: { Accept: 'text/event-stream' }})` +
  a custom line reader. Today both seed endpoints return 501, so the
  iterable MUST be constructable but `await for` SHOULD raise
  `NotImplementedError` on the first event.
  <!-- ❌ wire_mismatch 2026-04-22 (issue cognitum-one/seed#48) — /delta/stream returns 200 application/json snapshot, not 501 and not SSE. SDK 501→NotImplementedError mapping also missing (issue cognitum-one/sdks#3). -->
- Pagination: none; full payloads. Expose helpers like
  `seed.optimize.metrics()` that return arrays directly.

### Testing strategy

- `vitest` for unit + integration tests. Continue `tests/client.test.ts`
  pattern. Use [MSW](https://mswjs.io/) or a plain fetch-mock for HTTP
  mocking when we add one; do not pull the seed submodule into Node tests.
- A "virtual seed" integration test suite runs in CI against
  `seed/virtual-seed/` (future).
- Type tests: `tsc --noEmit` on all examples in `tests/typecheck/`.
- No bundled e2e harness that requires a physical seed; that test lives
  in `seed/tests/` and calls the Node SDK from CI.

### API surface shape

- Primary entry: `new Cognitum({ apiKey }).catalog | orders | leads |
  contact | devices | mcp | brain`. Lazy resource objects
  (`index.ts:42-48`) — retain.
- Add `new Cognitum({ apiKey }).seed(host)` → returns a `SeedClient` sharing
  the same HTTP client's user-agent and timeout config but with seed auth.
  Alternatively, a standalone `import { SeedClient } from
  '@cognitum/sdk/seed'` — PREFERRED because it lets Seed consumers avoid
  importing the cloud code entirely (tree-shakeable).
- CLI: `bin.cognitum` / `bin.cognitum-sdk` (`package.json:17-19`) points at
  `dist/cli.mjs`. CLI is deliberately thin — it calls the SDK, nothing
  more. It gains `seed status`, `seed pair`, `seed query` subcommands
  alongside the current cloud-only subcommands.
- Node stdio MCP bridge (`mcp-stdio.ts`) remains cloud-only for now; a
  future `seed-mcp` bridge is out of scope.

### Packaging

- `type: "module"` with CJS fallback via tsup two-format build
  (`tsup.config.ts:4-24`). Retain.
- `exports.` map adds `"./seed"` entry for the seed subpath export.
- `engines.node >= 18` — retain; `fetch` is global there.
- `dependencies: {}` — zero runtime deps today. Keep it that way; any new
  dep needs its own ADR.

## Consequences

### Positive

- Current cloud surface is already SemVer-0.1 compliant and well-tested.
- Zero-dep footprint keeps `npm install` fast for consumers.
- Seed module as a subpath export preserves tree-shaking.

### Negative

- `fetch`-based TLS pinning for self-signed is awkward in Node. The seed
  module will need a thin `undici.Agent` wrapper scoped to the pinned host.
- Stdio MCP bridge ships additional `readline` wiring that complicates the
  bundle. Move to its own entry point if bundle size regresses.

## Alternatives considered

| Option | Why rejected |
|--------|--------------|
| One `Cognitum` class for cloud + seed | Couples credential lifecycles; violates separation of concerns. |
| Auto-generate types from an OpenAPI spec | No spec exists yet. See ADR-0006 future work. |
| Use `axios` for retry primitives | Adds 33 kB to the minified bundle for no real gain. |

## Compliance

- `tsc --noEmit` clean.
- `npm pack --dry-run` shows `dist/` only; no source leakage.
- Bundle size budget: `dist/index.js` under 30 kB minified (current
  measurement baseline to be added).
- Conformance tests (ADR-0004, ADR-0005) green.

## References

- DDD model: `docs/adr/ddd/seed-domain.md`
- `sdks/node/src/client.ts`
- `sdks/node/src/errors.ts`
- `sdks/node/src/index.ts`
- `sdks/node/src/mcp.ts`, `mcp-stdio.ts`
- `sdks/node/tsup.config.ts`
- Related: ADRs 0002, 0003, 0004, 0005, 0006, 0007, 0011.
