# ADR 0015a: Node.js / TypeScript SDK Implementation — Layout, API, Models

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** SDK maintainers (Node)
- **Scope:** sdks/node
- **Companion:** ADR-0015b (errors, transport, retry, auth),
  ADR-0015c (streaming, MCP, tests, CI, migration)

## Context

ADR-0008 accepts the Node/TypeScript architecture at a conceptual level.
This ADR (three parts: 0015a, 0015b, 0015c) makes it concrete enough
that a PR against `/home/ruvultra/projects/sdks/sdks/node/` can be
mechanically graded. Part 0015a pins the package layout, the public
TypeScript API, and the typed wire models.

Current state (verified):

| Concern | Current | Source |
|---------|---------|--------|
| Package name | `@cognitum/sdk` | `/home/ruvultra/projects/sdks/sdks/node/package.json:2` |
| Version | `0.1.3` | `/home/ruvultra/projects/sdks/sdks/node/package.json:3` |
| Engines | `>=18` | `/home/ruvultra/projects/sdks/sdks/node/package.json:37` |
| Exports map | single `.` entry | `/home/ruvultra/projects/sdks/sdks/node/package.json:9-15` |
| Cloud auth header | `X-API-Key` | `/home/ruvultra/projects/sdks/sdks/node/src/client.ts:48` |
| Retry cap | **16 s** (non-compliant, fixed in 0015b) | `/home/ruvultra/projects/sdks/sdks/node/src/client.ts:171-173` |
| Retry base | **1000 ms** (non-compliant, fixed in 0015b) | `/home/ruvultra/projects/sdks/sdks/node/src/client.ts:172` |
| Jitter | **none** (non-compliant, fixed in 0015b) | `/home/ruvultra/projects/sdks/sdks/node/src/client.ts:171-173` |
| Error classes | 5 — `Cognitum`, `Auth`, `RateLimit`, `Validation`, `NotFound` | `/home/ruvultra/projects/sdks/sdks/node/src/errors.ts:1-53` |
| `AuthError.reason` | missing | `/home/ruvultra/projects/sdks/sdks/node/src/errors.ts:19-24` |
| MCP transports | HTTP + stdio | `/home/ruvultra/projects/sdks/sdks/node/src/mcp.ts:1-49`, `/home/ruvultra/projects/sdks/sdks/node/src/mcp-stdio.ts:1-170` |
| Test runner | vitest | `/home/ruvultra/projects/sdks/sdks/node/package.json:42` |
| Seed client | **missing** | no `src/seed/*` |

Gaps this ADR closes (in 0015a): seed-direct subpath export, tree-shaken
layout, forward-compat response types, discriminated-union request types
for store ingest/query, an optional Zod runtime-validation flag.

<!-- swarm-seed-validation 2026-04-22: ✅ fixed 2026-04-22 — §2 seed subpath export (`@cognitum/sdk/seed`, SeedClient, status/identity/pair/custody/store/ota) SHIPPED in Phase 1 (issue cognitum-one/sdks#2 closed). `./seed` subpath export added at `package.json:10-14`; tsup emits `dist/seed/index.{js,cjs,d.ts}`; SeedClient class at `src/seed/client.ts` wires 12 Phase 1 endpoints. Delta/stream endpoints deferred to Phase 1.5 (still tracked by seed#48). ✅ §2 cloud surface (Cognitum + catalog/orders/leads/contact/devices/mcp/brain) verified via `reports/node.json`. ✅ §3 typed models — seed responses now exposed through `interface ... extends Record<string, unknown>` for forward-compat; store.query body shape verified live as `{vector:number[], k:number}` (unit test in tests/seed/unit/errors.test.ts guards against regression to `{query, k}`). -->

## Phase 1 delivery (2026-04-22)

Ships the seed-direct subset of this ADR verbatim, minus streaming / MCP /
mesh. Everything landed at `sdks/node/src/seed/**` and
`sdks/node/tests/seed/**` on branch
`chore/adr-reorg-v0.20.0-and-sdk-validation` — closes issue
`cognitum-one/sdks#2`.

What landed:

| Layer | Files | Coverage |
|-------|-------|----------|
| Config + validation | `src/seed/config.ts`, `src/seed/peers.ts` | 16 unit tests (mesh/TokenBook/routing rejected with Phase-1.5 note) |
| TLS-aware transport | `src/seed/transport.ts` | Runtime `undici`-or-`https.Agent` fallback; `tls.insecure` emits a one-time warning |
| Retry loop (ADR-0005) | `src/seed/retry.ts` | 22 unit tests: classify all error types, `Retry-After` header + `retry_after_us` body parsing, equal-jitter, `maxElapsedMs` ceiling |
| Error taxonomy (ADR-0004) | `src/errors.ts` (extended) | 18 unit tests mapping 400/401/403/404/409/422/429/501/503/5xx + abort/parse/network |
| Resource bindings | `src/seed/resources/{status,identity,pair,witness,custody,store,ota}.ts` | All 12 Phase 1 endpoints wired |
| SeedClient | `src/seed/client.ts` + `src/seed/index.ts` | Integration test exercises 7 endpoints against live seed via `localhost:18443` SSH tunnel |
| Build | `tsup.config.ts`, `package.json` `exports[./seed]` | `dist/seed/index.{js,cjs,d.ts}` emitted; `npm run build` succeeds |

Phase 1 endpoints — integration-verified against seed v0.20.0 on the
Pi Zero 2 W (`ad7d7e7b-56e7-4e03-b078-939209858144`):

- `GET /api/v1/status` → `client.status()`
- `GET /api/v1/identity` → `client.identity()`
- `GET /api/v1/pair/status` → `client.pair.status()`
- `POST /api/v1/pair` → `client.pair.create({ clientName })`
- `DELETE /api/v1/pair/{name}` → `client.pair.delete(name)`
- `GET /api/v1/witness/chain` → `client.witness.chain()`
- `GET /api/v1/custody/epoch` → `client.custody.epoch()`
- `GET /api/v1/store/status` → `client.store.status()`
- `POST /api/v1/store/query` → `client.store.query({ vector, k })` — **body shape `{vector, k}` verified, not `{query, k}`**
- `POST /api/v1/store/ingest` → `client.store.ingest({ vectors })`
- `GET /api/v1/ota/config` → `client.ota.config()`
- `POST /api/v1/ota/checkNow` → `client.ota.checkNow()`

Mesh-mode API shape is locked (see §"Expected mesh config shape" in the
Phase 1 spec handoff); the Phase 1 client throws `ConfigError("mesh mode
lands in Phase 1.5")` when given more than one endpoint or a non-`pinned`
routing strategy. Tracking issue for Phase 1.5 mesh work: TBD.

Known gaps (Phase 1.5):
- SSE streaming (`/delta/stream`, `/sensor/stream`) — blocked by
  seed#48 (returns 200 JSON snapshot today, not 501).
- `createStdioTransport` MCP parity — ADR-0015c §9.
- `AuthError.reason` discriminator + `RateLimitError.tier` — requires
  cloud-path refactor beyond the seed subpath.
- `undici.Agent`-first TLS pinning — waiting on a dependency bump.
- Full `redactHeaders`/`redactValue` — seed client never logs headers
  today, so no exposure to fix.

## Decision

### 1. Package layout

Every path below is relative to
`/home/ruvultra/projects/sdks/sdks/node/`.

```
package.json
tsconfig.json
tsup.config.ts
src/
  index.ts                 # cloud entry — re-exports Cognitum, types, errors
  client.ts                # HttpClient (cloud defaults)
  auth.ts                  # credential resolution + redact() helper
  retry.ts                 # equal-jitter backoff loop (shared cloud + seed)
  errors.ts                # full ADR-0004 taxonomy (see 0015b)
  sse.ts                   # ReadableStream<Uint8Array> → AsyncIterable<Event>
  redact.ts                # logging redactor
  models/
    cloud.ts               # catalog, orders, leads, contact, devices, brain
    seed/
      index.ts             # re-exports
      common.ts            # Epoch, DeviceId, Vector, DistanceMetric, …
      status.ts
      pair.ts
      store.ts             # ingest/query/delete/status (discriminated)
      witness.ts
      custody.ts
      optimize.ts
      boundary.ts
      coherence.ts
      sensor.ts
      thermal.ts
      delivery.ts
  seed/
    index.ts               # exports SeedClient, default host constants
    client.ts              # SeedClient (uses shared retry.ts + own HTTP layer)
    transport.ts           # undici.Agent pinned to 169.254.42.1 & cognitum.local
    pairing.ts             # pair()/unpair()/status() helpers
  mcp/
    http.ts                # createHttpTransport(url)
    stdio.ts               # createStdioTransport(cmd, args) / startStdioServer()
  catalog.ts orders.ts leads.ts contact.ts devices.ts brain.ts  # resource shims
  cli.ts                   # thin CLI (seed + cloud subcommands)
tests/
  client.test.ts           # cloud
  seed/*.test.ts           # one file per seed resource
  fixtures/seed/*.json     # golden fixtures keyed by endpoint
  typecheck/*.ts           # tsc --noEmit smoke tests
```

`package.json` MUST declare this `exports` map:

```json
{
  "name": "@cognitum/sdk",
  "version": "0.2.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./seed": {
      "types": "./dist/seed/index.d.ts",
      "import": "./dist/seed/index.js",
      "require": "./dist/seed/index.cjs"
    },
    "./mcp": {
      "types": "./dist/mcp/http.d.ts",
      "import": "./dist/mcp/http.js",
      "require": "./dist/mcp/http.cjs"
    },
    "./mcp/stdio": {
      "types": "./dist/mcp/stdio.d.ts",
      "import": "./dist/mcp/stdio.js",
      "require": "./dist/mcp/stdio.cjs"
    }
  },
  "engines": { "node": ">=20.0.0" },
  "files": ["dist", "README.md", "LICENSE"],
  "sideEffects": false,
  "dependencies": {
    "undici": "^6.19.0"
  },
  "optionalDependencies": {
    "zod": "^3.23.0"
  }
}
```

Node `>=20.0.0` is required for native `fetch` with `undici.Agent`
dispatcher support and `ReadableStream.from` on the streaming path; Node
18 ships an older undici that lacks `Agent.prototype.connect` with
`checkServerIdentity`. Supersedes `engines.node: ">=18"` at
`/home/ruvultra/projects/sdks/sdks/node/package.json:37`.

Zod is OPTIONAL — only loaded when the caller passes
`validateResponses: true`. Consumers pay zero bundle cost otherwise.

### 2. Public API surface

```ts
// src/index.ts
export class Cognitum {
  constructor(config: CognitumConfig);
  readonly catalog:  CatalogResource;
  readonly orders:   OrdersResource;
  readonly leads:    LeadsResource;
  readonly contact:  ContactResource;
  readonly devices:  DevicesResource;
  readonly mcp:      McpResource;
  readonly brain:    BrainResource;
  health(): Promise<HealthResponse>;
}

export interface CognitumConfig {
  apiKey?: string;                    // else COGNITUM_API_KEY
  baseUrl?: string;                   // default https://api.cognitum.one
  timeout?: number;                   // ms, single attempt, default 30_000
  retries?: number;                   // default 3
  maxElapsedMs?: number;              // default 60_000 (ADR-0005)
  rateLimitRetry?: boolean;           // default true
  validateResponses?: boolean;        // default false; requires zod installed
  userAgent?: string;                 // appended to "cognitum-sdk-node/<ver>"
  fetch?: typeof fetch;               // injection for tests
  logger?: Logger;                    // receives redacted records
}
```

```ts
// src/seed/index.ts
export class SeedClient {
  constructor(config: SeedClientConfig);

  // Custody
  status():   Promise<SeedStatus>;
  identity(): Promise<Identity>;
  witness: WitnessApi;
  custody: CustodyApi;

  // Pairing
  pair:  PairingApi;

  // Optimizer
  store:    StoreApi;
  optimize: OptimizeApi;
  boundary: BoundaryApi;
  coherence: CoherenceApi;

  // Sensing
  sensor: SensorApi;

  // Delivery
  delivery: DeliveryApi;
  delta:    DeltaApi;

  // Platform
  thermal: ThermalApi;

  // Misc
  demo:     DemoApi;
  profiles: ProfilesApi;

  close(): Promise<void>; // releases undici.Agent
}

export interface SeedClientConfig {
  host?: string;                      // default 169.254.42.1
  port?: number;                      // default 8443
  pairingToken?: string;              // else COGNITUM_SEED_TOKEN
  clientCert?: { certPem: string; keyPem: string };
  trustRoot?: string | Uint8Array;    // custom CA for non-default hosts
  dangerouslyInsecure?: boolean;      // dev only; logs warning each request
  timeout?: number;
  retries?: number;
  maxElapsedMs?: number;
  autoPair?: false;                   // MUST remain false; ADR-0007 §"Pairing flow safety"
  tokenStore?: TokenStore;            // opt-in; never defaults to disk
  logger?: Logger;
}
```

StoreApi signatures — discriminated unions where the wire uses oneOf:

```ts
export interface StoreApi {
  status(): Promise<StoreStatus>;
  ingest(req: StoreIngestRequest): Promise<StoreIngestResponse>;
  query(req:  StoreQueryRequest):  Promise<StoreQueryResponse>;
  delete(req: StoreDeleteRequest): Promise<void>;
  /** Binary RVF pull; returns raw bytes. */
  syncPull(): Promise<Uint8Array>;
  /** Binary RVF push; body must be a valid RVF1 container. */
  syncPush(body: Uint8Array): Promise<void>;
}

// Ingest supports two shapes: with user IDs or without.
export type StoreIngestRequest =
  | { vectors: Array<{ id: string;  values: number[]; metadata?: Meta }> }
  | { vectors: Array<{           values: number[]; metadata?: Meta }> };

// Query supports single-vector and batch.
export type StoreQueryRequest =
  | { vector:  number[]; k: number; metric?: DistanceMetric }
  | { vectors: number[][]; k: number; metric?: DistanceMetric };
```

PairingApi (matches seed wire at
`/home/ruvultra/projects/sdks/seed/docs/seed/api-reference.md:61-87`):

```ts
export interface PairingApi {
  status(): Promise<PairStatus>;
  create(clientName: string): Promise<PairCreateResponse>; // POST /api/v1/pair
  unpair(clientName: string): Promise<void>;               // DELETE
}
```

WitnessApi + CustodyApi:

```ts
export interface WitnessApi {
  chain(): Promise<WitnessChain>;
  verify(): Promise<{ valid: boolean; details?: string }>;
}
export interface CustodyApi {
  epoch():         Promise<{ epoch: Epoch }>;
  witness(action: string):                       Promise<WitnessEntry>;
  sign(payload: string | Uint8Array):            Promise<{ signature: string }>;
  verify(payload: string | Uint8Array, sig: string): Promise<{ valid: boolean }>;
  attestation():   Promise<AttestationChain>;
}
```

Remaining API shapes follow the same pattern (one method per endpoint in
ADR-0002 §"Endpoint inventory"); they are bound to their models in
`src/models/seed/*.ts` and enumerated in ADR-0015c §"Endpoint binding
table".

### 3. Typed models

Rule: **responses are open, requests are closed.** Wire shapes stay
snake_case for seed payloads and camelCase for cloud. Match
`/home/ruvultra/projects/sdks/docs/adr/ddd/seed-domain.md` §1 for names.

```ts
// src/models/seed/common.ts
export type Epoch = number & { readonly __epoch: unique symbol };
export type DeviceId = string & { readonly __deviceId: unique symbol };
export type DistanceMetric = "cosine" | "euclidean" | "dot";

// Unknown-field tolerance per ADR-0006: responses only.
export type Forward<T> = T & { readonly [k: string]: unknown };

// src/models/seed/status.ts
export type SeedStatus = Forward<{
  device_id: DeviceId;
  uptime_secs: number;
  epoch: Epoch;
  total_vectors: number;
  deleted_vectors: number;
  file_size_bytes: number;
  dimension: number;
  paired: boolean;
  roles: Array<"custody" | "optimizer" | "delivery" | string>;
}>;
// Wire-verified against
// /home/ruvultra/projects/sdks/seed/docs/seed/api-reference.md:32-42

// src/models/seed/store.ts
export interface QueryResult {
  id: number;                 // numeric content-hash id (DDD §5.4)
  distance: number;
  metadata: Record<string, unknown>;
}
export type StoreQueryResponse = Forward<{
  results: QueryResult[];
  query_ms: number;
}>;
// Wire-verified against api-reference.md:120-128

export type StoreIngestResponse = Forward<{
  ingested: number;
  witness_chain_length: number;
  epoch: Epoch;
}>;

export type StoreStatus = Forward<{
  total_vectors: number;
  deleted_vectors: number;
  dimension: number;
  file_size_bytes: number;
  epoch: Epoch;
}>;

// src/models/seed/pair.ts
export type PairStatus = Forward<{
  paired: boolean;
  client_count: number;
  pairing_window_open: boolean;
  window_remaining_secs: number;
}>;
export type PairCreateResponse = Forward<{
  client_name: string;
  pairing_token: string;
  expires_at: string;         // ISO 8601
}>;
// Wire-verified against api-reference.md:61-87
```

Optional runtime validation — lazy-loaded only if `validateResponses:
true`:

```ts
// src/seed/client.ts (excerpt)
let zod: typeof import("zod") | undefined;
async function validate<T>(schema: ZodType<T>, value: unknown): Promise<T> {
  if (!zod) zod = await import("zod");
  return schema.parse(value);
}
```

If `zod` is not installed when `validateResponses` is `true`, the SDK
throws `ValidationError("zod is required for validateResponses")` at
construction — fail fast, never at request time.

Snake-case is preserved on the wire; the SDK does NOT re-camelCase
payloads eagerly (ADR-0008 §"Type / schema strategy"). Callers who want
camelCase apply their own mapping on the way out.

## Consequences

### Positive

- Seed-direct usage is tree-shakeable via the `./seed` subpath; cloud
  and seed code paths never load the other half.
- Discriminated unions (`StoreIngestRequest`, `StoreQueryRequest`) make
  illegal states unrepresentable at the type level.
- `Forward<T>` pattern gives cross-release survivability for free — a
  seed that adds a new status field does not break `tsc`.

### Negative / trade-offs

- `undici` enters `dependencies` (was zero). Needed for the transport in
  ADR-0015b; called out here because it shows up in `package.json`.
- Node 20 minimum drops Node 18 users. Node 18 hits EOL 2025-04; the
  window is open.
- Subpath exports need tsup to emit four entry trees, slowing the build
  a few seconds.

### Neutral

- `zod` is optional; bundle cost stays zero for consumers who don't opt
  in.

## Alternatives considered

| Option | Why rejected |
|--------|--------------|
| Single `Cognitum` class that carries seed state too | Couples credential lifecycles; violates ADR-0008. |
| No subpath exports; gate seed via runtime check | Forces tree-shaking to trace through the cloud module. |
| Auto-generate types from an OpenAPI spec | No spec exists yet (ADR-0006 future work). |
| Require zod unconditionally | Penalises cloud-only users with 50 KB they never use. |
| Re-camelCase the wire in the SDK | Runtime cost with no type win; ADR-0008 rejects. |

## Compliance / verification

- `tsc --noEmit` clean with `"strict": true` (retain from
  `/home/ruvultra/projects/sdks/sdks/node/tsconfig.json:7`).
- `pnpm pack --dry-run` shows four entry-point `.d.ts`/`.js`/`.cjs`
  trees in `dist/`.
- `attw` (Are The Types Wrong) passes for ESM + CJS consumers of each
  subpath.
- Type-only test: `const x: SeedStatus = await seed.status(); x.device_id;`
  compiles; `x.unknown_future_field` is `unknown` (not an error).

## References

- DDD model: `/home/ruvultra/projects/sdks/docs/adr/ddd/seed-domain.md`
- ADR-0002 (wire), ADR-0006 (versioning / forward-compat),
  ADR-0008 (node arch), ADR-0011 (scope),
  ADR-0015b (errors/transport/retry/auth), ADR-0015c (ops).
- Current Node SDK:
  `/home/ruvultra/projects/sdks/sdks/node/package.json:1-44`,
  `/home/ruvultra/projects/sdks/sdks/node/tsconfig.json:1-25`,
  `/home/ruvultra/projects/sdks/sdks/node/tsup.config.ts:1-24`,
  `/home/ruvultra/projects/sdks/sdks/node/src/index.ts:1-99`,
  `/home/ruvultra/projects/sdks/sdks/node/src/types.ts:1-199`.
- Seed wire shapes:
  `/home/ruvultra/projects/sdks/seed/docs/seed/api-reference.md:22-128`.
