# ADR 0015c: Node.js / TypeScript SDK Implementation — Streaming, MCP, Ops

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** SDK maintainers (Node)
- **Scope:** sdks/node
- **Companion:** ADR-0015a (package layout, public API, typed models),
  ADR-0015b (errors, transport, retry, auth)

## Phase 2 delivery (2026-04-23)

Mesh-observability + per-call override knobs landed on 2026-04-23, closing
the ADR-0016a §D8 / ADR-0016b §"Per-call knobs" conformance gap against
the Rust Phase 1.5 reference. Concrete deliverables relative to the Phase
1.5 snapshot below:

- `src/seed/models/mesh.ts` — new wire-shape models for the four mesh
  observability endpoints (ADR-0016a §D8): `MeshStatus`, `MeshPeers`,
  `SwarmStatus`, `ClusterHealth`, plus a shared `MeshPeerEntry`. All
  extend `Record<string, unknown>` so unknown seed-side fields stay
  forward-compatible per ADR-0006. Sample JSON captured against live
  seed v0.20.0 (2026-04-22) is committed inline as doctype in the file
  header.
- `src/seed/resources/mesh.ts` — new `MeshResource` with
  `status() / peers() / swarmStatus() / clusterHealth()`. All four are
  GETs, all four are on the seed's WiFi-read allowlist (no pairing
  token required —
  `seed/src/cognitum-agent/src/api.rs:392-400`), all four accept an
  optional trailing `CallOptions`. Factory `makeMeshResource(request)`
  mirrors the other resource factories so `SeedClient` and
  `SeedSession` bind identically.
- `src/seed/callOptions.ts` — new `CallOptions` type with fields
  `peer? / prefer? / consistency? / timeoutMs? / retries? / signal? /
  idempotent?` per ADR-0016b §"Per-call knobs". Threaded as the
  trailing argument of every resource method (`status(opts?)`,
  `identity(opts?)`, `pair.*(..., opts?)`, `witness.chain(opts?)`,
  `custody.epoch(opts?)`, `store.*(..., opts?)`, `ota.*(opts?)`,
  `mesh.*(opts?)`).
- `src/seed/client.ts` — `SeedClient.request` honours the per-call
  knobs. `opts.peer:` is validated via `PeerSet.findByKey` before
  dispatch (throws `ConfigError("peer not in mesh: <url>")` on miss)
  and disables mesh-cycling for that one call (caller asked for a
  specific peer). `opts.prefer:` drives a one-call ordered walk via
  the new `PeerSet.preferOrder(mode)` helper. `opts.consistency:
  "strong"` throws `UnsupportedError("consistency=strong")` per
  ADR-0016a §D4 before any network I/O. `opts.consistency: "eventual"`
  suppresses session-stickiness for this one call. `opts.retries:
  null` disables retry entirely; `opts.retries: N` overrides the
  client default. `opts.signal:` is chained into the per-attempt
  `AbortController` — a caller abort surfaces as `NetworkError`, NOT
  `TimeoutError`, and never cycles.
- `src/seed/client.ts` — new `SeedClient.mesh` resource accessor
  (ADR-0016a §D8) plus `SeedClient.rediscover()` — Phase 2 placeholder
  that resets every peer's `state / latencyEmaMs / consecutiveFailures`
  via the new `PeerSet.resetAll()`. mDNS discovery lands in a future
  phase; the method signature is fixed now so call sites compile
  across the transition.
- `src/seed/peers.ts` — two additive helpers: `PeerSet.resetAll()`
  (used by `rediscover()`) and `PeerSet.preferOrder(mode)` with modes
  `"closest" / "local-first" / "random" / "any"`. `"local-first"`
  prefers RFC-1918 / link-local / loopback hosts, which is the
  common desktop-laptop + LAN-seed topology.
- `src/errors.ts` — new `UnsupportedError` (code `UNSUPPORTED`). Not
  retryable; no peer cycling; no backoff. Carries a `feature: string`
  field so consumer telemetry can group by capability.
- `src/seed/session.ts` — `SeedSession.mesh` mirrors `SeedClient.mesh`
  and routes through the pinned peer. The session's inner request
  hook forwards any `CallOptions` the caller supplies (a session call
  can still override `peer:` / `prefer:` / `consistency:` / etc.
  individually).
- `src/seed/index.ts` — exports `CallOptions`, `CallPrefer`,
  `CallConsistency`, `MeshResource`, `MeshStatus`, `MeshPeers`,
  `MeshPeerEntry`, `SwarmStatus`, `ClusterHealth`, and
  `UnsupportedError`.
- `tests/seed/unit/mesh-resource.test.ts` (5 tests) — the four
  endpoints plus a per-call-options-forwarding assertion. Uses a
  `vi.fn()`-based request stub (no fetch mock needed — the resource
  factories are pure).
- `tests/seed/unit/call-options.test.ts` (11 tests) — peer override,
  unknown-peer `ConfigError`, the four `prefer` modes (closest /
  local-first / random / any), `consistency: strong` →
  `UnsupportedError` (no dispatch), `consistency: eventual` bypasses
  session stickiness, `timeoutMs` override honoured, `retries: null`
  disables retry, `signal` cancels in-flight with `NetworkError`.
  Uses the same hand-rolled per-URL mock fetch as
  `tests/seed/integration/mesh.test.ts`.
- `tests/seed/unit/rediscover.test.ts` (2 tests) — state reset
  across multiple peers, idempotence of a second call.

Test totals (`npm test`, 2026-04-23): 184 passed (was 166 after
Phase 1.5), exactly +18 new tests. The single pre-existing
`tests/client.test.ts` cloud-`catalog.browse()` failure is
unchanged — unrelated to seed work, tracked separately.

Build: `npm run build` — ESM + CJS emit succeeds. The `dts` sub-build
still fails on the pre-existing `@types/node` DOM-lib gap (`fetch`,
`RequestInit`, `AbortController`, etc. — not introduced by Phase 2
work). Tracked separately; identical to the Phase 1.5 note below.

### Seed endpoints verified live (2026-04-22, seed v0.20.0 via mac-mini jump)

| Endpoint | Sample body |
|----------|-------------|
| `GET /api/v1/network/mesh/status` | `{"ap_active":true,"auto_mesh":false,"connected_to_seed":false,"device_id":"ad7d7e7b-56e7-4e03-b078-939209858144","has_mesh_password":false,"peer_count":0,"peers":[]}` |
| `GET /api/v1/peers` | `{"count":0,"discovery_active":true,"peers":[]}` |
| `GET /api/v1/swarm/status` | `{"device_id":"ad7d7e7b-56e7-4e03-b078-939209858144","discovery_active":true,"epoch":20564,"peer_count":0,"total_vectors":8460,"uptime_secs":23000}` |
| `GET /api/v1/cluster/health` | `{"auto_sync_interval_secs":60,"cluster_enabled":true,"discovery_active":true,"last_sync_attempt":1776906537,"peer_count":0,"peers":[]}` |

Every field is modelled as optional on the `Record<string, unknown>`
wire type so newer firmwares that add fields stay forward-compatible
without a code change.

### Not yet landed (explicit deferrals, tracked for Phase 3)

- Coherence / thermal read endpoints (§D8 "nice-to-have in 1.5").
  Seed-side surface is stable; adding them to the SDK is a mechanical
  follow-up that the current `mesh.*` shape already accommodates.
- Live-seed integration test for `client.mesh.*` — today's live-seed
  suite (`tests/seed/integration/live-seed.test.ts`) covers the Phase
  1 endpoints; extending it to mesh is a one-line addition but gated
  on the USB gadget being reliably present in CI.

## Phase 3 — mDNS discovery (2026-04-23)

ADR-0016a §D6 Phase 1.5 opt-in discovery landed against the Node tree
alongside Phase 2. Deliverables:

- `src/seed/discovery/types.ts` — `DiscoveryProvider` +
  `DiscoveredPeer` interfaces. `discover()` returns the current
  candidate endpoints; `close()` releases long-running resources.
  Stable public surface so callers can ship their own tailnet-aware
  / cloud-fleet providers without forking the SDK.
- `src/seed/discovery/explicit.ts` — `ExplicitDiscovery` wraps the
  legacy `string | string[]` form for internal uniformity.
- `src/seed/discovery/mdns.ts` — `MdnsDiscovery` (opt-in subpath).
  One-shot PTR query against `_cognitum._tcp.local` (configurable via
  `serviceType`), 500ms collection window by default, TXT-record
  parse into `{url, deviceId}`. Wire library (`multicast-dns@^7.2.5`)
  is declared as a **peerDependency** + `peerDependenciesMeta.optional`
  so the core install stays lean — callers opt in by importing
  `@cognitum/sdk/seed/discovery/mdns`.
- `src/seed/client.ts` — new async factory
  `SeedClient.create(options)` resolves a provider before
  construction; `SeedClient.rediscover()` now returns
  `void | Promise<void>` (sync state-reset when no provider is
  attached, async re-query + `PeerSet` rebuild when one is).
- `src/seed/index.ts` — re-exports `ExplicitDiscovery`,
  `DiscoveryProvider`, `DiscoveredPeer` from `./discovery/index.js`.
- `package.json` — adds the `"./seed/discovery/mdns"` subpath export
  and declares `multicast-dns` as an optional peer dependency.
- `tsup.config.ts` — new bundle entry for the mDNS subpath with
  `external: ["multicast-dns"]` so the wire lib isn't inlined.
- Tests: `tests/seed/unit/discovery-explicit.test.ts` (2 tests —
  single string, array + invalid input), `tests/seed/unit/discovery-mdns.test.ts`
  (3 tests — happy-path TXT parse, `SeedClient.create` + `rediscover`
  end-to-end, close/teardown + non-matching-record filtering). Stubbed
  `mdnsFactory` injected via the ctor option; no real multicast.

Punted to a future pass (tracked in ADR-0016a §D6 footnotes):

- Full DNS-SD PTR → SRV → A/AAAA chain lookup. Today we parse the
  TXT record attached to the instance name and synthesise the host
  from the DNS-SD label. Sufficient for the seed's emitter
  (`seed/src/cognitum-agent/src/discovery.rs:137-180`); more strict
  mDNS responders may need the chain walk.
- Python + Rust ports. This Phase 3 subsection is Node-only — the
  `DiscoveryProvider` interface is deliberately portable and the
  Python/Rust ADRs (0018c/0019c) will mirror it verbatim.

### fp= cert pinning (2026-04-23)

ADR-040 FINDING-28 + the commit `8e18963` "punt" item is now closed
for Node. The mDNS TXT-record `fp=sha256:<hex>` field is surfaced on
`DiscoveredPeer.tlsFingerprint` and threaded through the per-peer
TLS handshake so a seed impersonator with a different self-signed
cert is rejected at handshake time.

Deliverables (all under `sdks/node/`):

- `src/errors.ts` — new `TlsPinError` (code `TLS_PIN_ERROR`) carrying
  `peerKey`, `expectedFingerprint`, `actualFingerprint`. NOT retryable
  and does NOT fall back to `tls.insecure` — a fingerprint mismatch
  is a hard trust failure. Re-exported from `src/seed/errors.ts` and
  `src/seed/index.ts`.
- `src/seed/discovery/types.ts` — `DiscoveredPeer` gains
  `tlsFingerprint?: string` (hex, lowercase, no colons / no `sha256:`
  prefix).
- `src/seed/discovery/mdns.ts` — new `parseFingerprint()` helper
  accepts `sha256:<hex>`, bare `<hex>`, and colon-separated forms;
  normalises to canonical lowercase hex. Malformed values are ignored
  (the peer still surfaces without a pin) so one bad TXT never tanks
  a `discover()` batch.
- `src/seed/peers.ts` — `Peer` gains `readonly tlsFingerprint: string
  | undefined`; `PeerSet` constructor accepts an optional parallel
  `PeerOptions[]`. Propagated through `SeedClient.create()` and
  `rediscoverFromProvider()` so mesh rediscovery preserves pins.
- `src/seed/config.ts` — `ResolvedSeedConfig.peerOptions` carries
  per-peer options from the pre-resolved discovery provider;
  `SeedClientOptionsInternal._peerOptions` is the internal escape
  hatch.
- `src/seed/transport.ts` — new `buildPeerDispatcherFactory(tls)`
  returns a per-peer dispatcher factory with a private cache. When a
  peer has `tlsFingerprint`, the factory yields a pinned
  `undici.Agent` whose `connect.checkServerIdentity` asserts
  SHA-256(cert.raw) starts with the advertised hex prefix (the seed
  truncates to 16 hex chars per `discovery.rs:162`; the SDK accepts
  any byte-prefix so a future full-fingerprint firmware is
  forward-compatible). Precedence: explicit `tls.ca` wins → peer
  fingerprint pins → `tls.insecure` / system CA fall-through. New
  helpers `buildPinnedAgent`, `makePinCheckServerIdentity`,
  `classifyPinFailure` are exported for testability.
- `src/seed/client.ts` — `SeedClient` instantiates the per-peer
  dispatcher factory once at construction; `dispatchOnce` attaches
  `init.dispatcher` per-call when the peer has a pin. A fetch
  failure's cause chain is walked by `classifyPinFailure`; a hit
  surfaces a `TlsPinError` with `disposition: "surface"` — NO
  cycling, NO retry, NO insecure fallback.
- Agent cache strategy: keyed by `peer.key` (canonical URL). One
  `Agent` per pinned peer for the lifetime of the `SeedClient`, so
  five retry attempts against the same peer share one TLS session
  cache + keep-alive pool.

Tests (8 new, all green):

- `tests/seed/unit/discovery-mdns-fp.test.ts` (3) — `fp=sha256:...`
  parse into `tlsFingerprint`, malformed/empty `fp=` ignored, missing
  `fp=` → `undefined`.
- `tests/seed/unit/transport-fp-pin.test.ts` (4) — matching
  fingerprint accepts, mismatch rejects with `TLS_PIN_ERROR` marker
  that `classifyPinFailure` unwraps into a typed `TlsPinError`,
  insecure + no-fingerprint back-compat path, `tls.ca` precedence
  overrides per-peer pins, end-to-end `SeedClient.request`
  classification (no cycle, no retry, no insecure fallback).
- `tests/seed/unit/transport-agent-cache.test.ts` (1) — same peer
  yields the same `Agent` across 5 calls, distinct peers get
  distinct Agents, plain peers (no fingerprint) get `undefined`.

Not yet surfaced (intentional narrow scope):

- Python + Rust ports of `fp=` pinning. Today's change is Node-only;
  the wire contract is symmetric so the Python/Rust ADRs (0018c/0019c)
  will mirror it in a follow-up.

## Phase 1.5 delivery (2026-04-23)

Mesh routing landed on 2026-04-23, executing ADR-0017 against the Node
tree. Concrete deliverables relative to the Phase 1 snapshot below:

- `src/seed/peers.ts` — `PeerSet` extended to 1..N with per-peer
  `PeerState`, `latencyEmaMs`, `lastUsedAt`, `consecutiveFailures`.
  `pick` / `nextAfter` / `markSuccess` / `markFailure` per ADR-0016a
  §D2/§D3/§D7. The Phase 1 `singlePeer()` helper was replaced by the
  class-based `PeerSet`; one-element inputs still degenerate to the
  single-peer code path.
- `src/seed/tokenBook.ts` — new `TokenBook` interface +
  `InMemoryTokenBook` default (ADR-0016a §D5). `SecretString` wraps
  token values with `toString` / `toJSON` / `util.inspect.custom`
  hooks that return `<redacted>` so the raw token never leaks to logs
  or stack traces. `pairAll(peers, clientName, pairFn, book?)` helper
  iterates the mesh and populates the book.
- `src/seed/session.ts` — `SeedClient.session()` returns a peer-pinned
  `SeedSession` mirroring the resource accessors (§D9). The pin is
  enforced at dispatch time via a `pinnedPeerKey` option on
  `SeedClient.request`.
- `src/seed/health.ts` — opt-in active probe via
  `SeedClientOptions.healthInterval`. Uses `setInterval` with
  `.unref()` so the probe never keeps the Node event loop alive;
  in-flight probe requests are cancelled via `AbortSignal` when
  `SeedClient.close()` is called.
- `src/seed/client.ts` — `SeedClient.request` rewritten onto the new
  `PeerSet`. Failover state machine cycles on `NetworkError` /
  `TimeoutError` / `500` / `502` / `503` / `504`, pins on `429`,
  surfaces `AuthError` / `ValidationError` / `NotFoundError` /
  `501 NotImplementedError` immediately. ADR-0005 60 s total budget
  is respected across ALL peer attempts combined (invariant I10 —
  N peers × M retries is NOT allowed).
- `src/seed/config.ts` — accepts 1..N endpoints; adds `tokenBook`,
  `routing`, `failover`, `healthInterval` options. Default routing is
  now `"session"` (closest-first with session-stickiness) per §D2.
  `auth.pairingToken` accepts a string (single-identity fallback) or
  an inline `{ [clientName]: token }` map (legacy, exposed as
  `pairingTokenMap` on the resolved config). Explicit per-peer tokens
  should go through `tokenBook`.
- `src/seed/index.ts` — exports `SeedSession`, `PeerSet`,
  `InMemoryTokenBook`, `SecretString`, `pairAll`, `startHealthProbe`,
  and the new `Peer` / `PeerState` / `PeerErrorClass` / `TokenBook`
  types.
- `tests/seed/unit/mesh-peer-set.test.ts` (17 tests) — ordering,
  `nextAfter`, unhealthy-skip, `markSuccess` / `markFailure` state
  transitions.
- `tests/seed/unit/mesh-token-book.test.ts` (14 tests) — get/set/
  delete round-trip, trailing-slash normalisation, redaction
  assertions on `SecretString`, `pairAll` mesh iteration.
- `tests/seed/integration/mesh.test.ts` (7 tests) — all 7 ADR-0017
  §5 fixtures (`test_mesh_single_peer_behaves_like_single_mode`,
  `test_mesh_two_peers_round_robin_for_reads`,
  `test_mesh_cycles_on_5xx`, `test_mesh_pins_on_429`,
  `test_mesh_session_stickiness`, `test_mesh_token_book_per_peer`,
  `test_mesh_health_probe_degrades_unhealthy_peer`) green against a
  `vi.fn()`-based per-URL dispatcher. No new runtime dependency —
  `msw` / `undici.MockAgent` were evaluated and rejected (neither is
  in the package's `devDependencies` and the mock shape is thin
  enough to hand-roll).

Test totals (`npm test`, 2026-04-23): 116 passed, 1 pre-existing cloud
`catalog.browse()` failure unrelated to mesh work — covered by
`tests/client.test.ts:75-78` (`/listTemplates` URL assertion; the
underlying catalog endpoint migrated). Seed sub-tree: 91 unit + 7
mesh-integration + 8 live-seed = 106 green.

Build: `npm run build` emits ESM + CJS cleanly. The `dts` sub-build
still fails on the pre-existing `@types/node` DOM-lib gap (`fetch`,
`setTimeout`, `AbortController` not declared) — tracked separately
and NOT introduced by mesh work.

### Security hardening — token redaction

`SecretString` (from `src/seed/tokenBook.ts`) wraps every pairing
token stored in the `TokenBook`. It overrides `toString`, `toJSON`,
and Node's `util.inspect.custom` hook so `console.log`,
`JSON.stringify`, and stack traces print `<redacted>` instead of the
raw token. The client-wide `auth.pairingToken` fallback is seeded
into the default `InMemoryTokenBook` through `SecretString` too, so
no raw-string token survives outside the intentional `.reveal()`
call-sites on the request hot path. Regression tests in
`tests/seed/unit/mesh-token-book.test.ts` assert the sentinel token
never appears in `toString` / `JSON.stringify` output.

Not yet landed (explicitly out of Phase 1.5 scope, tracked for
Phase 2):

- mDNS discovery — ADR-0016a §D6 opt-in upgrade path.
- Mesh-observability resource (`client.mesh().status/peers/swarm/
  health`) — ADR-0016a §D8 Phase 1 surface addendum.
- Per-call override args (`peer:` / `prefer:` / `consistency:`) —
  requires a per-call options bag, tracked against ADR-0016b §"Per-
  call knobs".
- `client.rediscover()` explicit re-resolve helper.
- `undici.MockAgent` or `msw` dependency for richer integration
  fixtures (e.g. concurrent-cycling assertions); the hand-rolled
  `meshFetch` is sufficient for the §5 acceptance suite.

## Context

ADR-0015a pins layout and surface; ADR-0015b pins the request/response
core (errors, transport, retry, auth). This third part covers everything
that runs alongside requests: SSE streaming, MCP HTTP + stdio parity,
tests, packaging, CI, benchmarks, examples, the migration diff from the
current `/home/ruvultra/projects/sdks/sdks/node/` tree, and open
questions.

## Decision

### 8. Streaming (SSE)

Both `/api/v1/delta/stream` and `/api/v1/sensor/stream` advertise SSE but
return 501 today
(`/home/ruvultra/projects/sdks/seed/docs/seed/api-reference.md` per
ADR-0002 §Streaming). The SDK MUST ship the typed handle **now** so the
call site doesn't change when the seed enables SSE (OQ-3).

<!-- ❌ wire_mismatch 2026-04-22 against seed v0.20.0 — /api/v1/delta/stream returns 200 application/json JSON snapshot (not 501, not SSE). The `res.status === 501` branch below is unreachable against live seed. Issue cognitum-one/seed#48. The §8 streaming contract (SSE iterator, NotImplementedError on 501) remains `(assumed)` until seed behaviour is reconciled. -->

Contract:

```ts
// src/sse.ts
export interface SseEvent<T = unknown> {
  id?: string;
  event?: string;       // default "message"
  data: T;              // parsed as JSON when possible; else raw string
  retry?: number;
}

export interface StreamOptions {
  signal?: AbortSignal;
}

export function toEventStream<T = unknown>(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<SseEvent<T>>;
```

Seed binding:

```ts
// src/seed/client.ts (excerpt)
delta = {
  stream: (opts?: StreamOptions): AsyncIterable<SseEvent<DeltaEvent>> => {
    return this.#sse<DeltaEvent>("/api/v1/delta/stream", opts);
  },
  history: () => this.#get("/api/v1/delta/history"),
};

async *#sse<T>(path: string, opts?: StreamOptions): AsyncIterable<SseEvent<T>> {
  const url = `${this.baseUrl}${path}`;
  const res = await undiciFetch(url, {
    method: "GET",
    headers: { Accept: "text/event-stream", ...this.#authHeaders() },
    signal: opts?.signal,
    dispatcher: this.agent,
  });
  if (res.status === 501) {
    throw new NotImplementedError(path);
  }
  if (!res.ok || !res.body) {
    throw await this.#mapHttpError(res, path);
  }
  for await (const ev of toEventStream<T>(res.body)) yield ev;
}
```

Cancellation is via `AbortSignal`; closing the iterator via `break`
triggers the underlying `res.body.cancel()` and releases the undici socket.
The SSE parser handles `\n\n` event framing, multi-line `data:` folding
per the HTML5 SSE spec, and coerces `data:` payloads through
`JSON.parse` when they start with `{` or `[`.

Test: a mock SSE server emits `data: {"epoch": 1}\n\n` + close; the
iterator yields exactly one event and returns.

### 9. MCP parity

OQ-4 requires Python/Rust to match Node's two-transport surface. This
ADR locks the Node exports so the others can mirror.

```ts
// src/mcp/http.ts
export function createHttpTransport(opts: {
  baseUrl: string;            // e.g. "https://api.cognitum.one"
  apiKey?: string;            // resolved via auth.ts if absent
  fetch?: typeof fetch;
}): McpTransport;

export interface McpTransport {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<McpToolCallResult>;
  close(): Promise<void>;
}
```

```ts
// src/mcp/stdio.ts
export function createStdioTransport(
  cmd: string,
  args: string[] = [],
  opts?: { env?: Record<string, string>; cwd?: string },
): McpTransport;

/** Start a stdio MCP server that proxies to the cloud HTTP MCP endpoint. */
export function startStdioServer(opts: {
  apiKey?: string;
  baseUrl?: string;
}): Promise<void>;
```

`startStdioServer` is the existing bridge at
`/home/ruvultra/projects/sdks/sdks/node/src/mcp-stdio.ts:27-170`; it
moves from `src/mcp-stdio.ts` to `src/mcp/stdio.ts`. The
`createStdioTransport` function is NEW — it's the mirror half (a caller
that *launches* an external MCP process over pipes), giving Python and
Rust a reference surface to replicate (OQ-4).

Both transports share `McpTransport`; callers can swap them
transparently:

```ts
import { createHttpTransport }  from "@cognitum/sdk/mcp";
import { createStdioTransport } from "@cognitum/sdk/mcp/stdio";

const mcp = process.env.COGNITUM_MCP_STDIO
  ? createStdioTransport(process.env.COGNITUM_MCP_STDIO)
  : createHttpTransport({ baseUrl: "https://api.cognitum.one" });
```

### 10. Test strategy

Runner: **vitest** (retained from
`/home/ruvultra/projects/sdks/sdks/node/package.json:42`). HTTP mocking
via **MSW 2.x** (fetch-native). No physical seed required.

Layout:

```
tests/
  client.test.ts                  # existing cloud tests, migrated
  retry.test.ts                   # jitter + elapsed ceiling
  redact.test.ts                  # ensure no secrets in logs
  seed/
    status.test.ts
    pair.test.ts
    store.test.ts
    witness.test.ts
    sensor.test.ts
    thermal.test.ts
    sse.test.ts
    tls.test.ts                   # pinned hosts + trustRoot
  mcp/
    http.test.ts
    stdio.test.ts
  typecheck/
    cloud-smoke.ts
    seed-smoke.ts
  fixtures/
    seed/
      status.ok.json
      store.query.ok.json
      store.ingest.ok.json
      pair.ok.json
      witness.chain.ok.json
      rate-limit.429.json         # { "error": "rate limited — retry after 2s", "retry_after_us": 2000000 }
      lockdown.403.json           # { "error": "lockdown active: mTLS required" }
```

Per-endpoint × per-case matrix: `{ 200-ok, 400-bad, 403-not-paired,
403-lockdown, 404, 429-header, 429-body, 500, 501, 503 } × endpoint`.
Generated via a small table walker so new endpoints get coverage by
append-only.

Concrete test (pair flow + 429 body parser):

```ts
// tests/seed/store.test.ts
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SeedClient } from "../../src/seed/index.js";
import { RateLimitError } from "../../src/errors.js";

const server = setupServer(
  http.post("https://169.254.42.1:8443/api/v1/store/query", async ({ request }) => {
    expect(request.headers.get("X-Pairing-Token")).toBe("tok-abc");
    return HttpResponse.json(
      { error: "rate limited — retry after 2s", retry_after_us: 2_000_000 },
      { status: 429 },
    );
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

describe("SeedClient.store.query", () => {
  it("maps 429 JSON body retry_after_us into RateLimitError.retryAfterMs", async () => {
    const seed = new SeedClient({
      pairingToken: "tok-abc",
      retries: 0,           // no retry in this assertion
    });
    try {
      await seed.store.query({ vector: [0,0,0,0,0,0,0,0], k: 5 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(2000);
    } finally {
      await seed.close();
    }
  });
});
```

Type tests (`tests/typecheck/*.ts`) are compiled under
`tsc --noEmit --project tsconfig.typecheck.json` and never run. They
import every public symbol and assert call sites compile.

### 11. Packaging

`tsup.config.ts` (replaces
`/home/ruvultra/projects/sdks/sdks/node/tsup.config.ts:1-24`):

```ts
import { defineConfig } from "tsup";

const common = {
  format: ["esm", "cjs"] as const,
  dts: true,
  sourcemap: "inline" as const,
  target: "es2022",
  outDir: "dist",
  clean: true,
  splitting: false,
  treeshake: true,
};

export default defineConfig([
  { entry: ["src/index.ts"],        ...common },
  { entry: ["src/seed/index.ts"],   ...common, outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }) },
  { entry: ["src/mcp/http.ts"],     ...common },
  { entry: ["src/mcp/stdio.ts"],    ...common },
  {
    entry: ["src/cli.ts"], format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    banner: { js: "#!/usr/bin/env node" },
    clean: false, dts: false, sourcemap: false, target: "es2022",
    outDir: "dist",
  },
]);
```

Tree-shaking is verified by `attw` (Are The Types Wrong) run in CI and
by a size snapshot: `dist/index.js` ≤ 40 KB min + gzip,
`dist/seed/index.js` ≤ 30 KB min + gzip. A `tests/bundle-size.test.ts`
fails if the snapshot regresses.

`sideEffects: false` in `package.json` unblocks bundler-side
tree-shaking for downstream apps.

Inline source maps (`sourcemap: "inline"`) keep debugging ergonomic
without shipping `.map` sidecar files that tools sometimes miss.

### 12. CI

`.github/workflows/node-sdk.yml`:

```yaml
name: node-sdk
on:
  pull_request:
    paths: ["sdks/node/**", "docs/adr/**"]
  push:
    branches: [main]
    paths: ["sdks/node/**"]

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        node: ["20", "22", "24"]
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    defaults: { run: { working-directory: sdks/node } }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node }}, cache: "pnpm" }
      - run: pnpm install --frozen-lockfile
      - run: pnpm run typecheck
      - run: pnpm run lint
      - run: pnpm run format:check
      - run: pnpm run test -- --coverage
      - run: pnpm dlx @arethetypeswrong/cli --pack .
        if: matrix.os == 'ubuntu-latest' && matrix.node == '22'

  publish:
    needs: test
    if: startsWith(github.ref, 'refs/tags/node-v')
    runs-on: ubuntu-latest
    permissions:
      id-token: write           # npm provenance
      contents: write
    defaults: { run: { working-directory: sdks/node } }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22", registry-url: "https://registry.npmjs.org" }
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
      - run: pnpm dlx @changesets/cli publish --provenance
        env: { NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} }
```

Forbidden-pattern grep (runs under `pnpm run lint`):

```
rg -n "Authorization:\\s*Bearer"                 src/ && exit 1 || true
rg -n "console\\.log\\(.*(apiKey|api_key|token)" src/ && exit 1 || true
rg -n "JSON\\.stringify\\(.*headers"             src/ && exit 1 || true
```

Publishing: changesets-driven version bumps, npm provenance
(`--provenance`) on every tag.

### 13. Benchmarks

`tinybench` (peer only, dev dep), `tests/bench/` excluded from `vitest`
default globs. Targets:

| Scenario | Target p50 | Target p99 |
|----------|-----------|-----------|
| `seed.status()` warm | ≤ 15 ms | ≤ 60 ms |
| `seed.store.query({k:10})` warm | ≤ 50 ms | ≤ 200 ms |
| `seed.store.ingest(100 vecs)` | ≤ 120 ms | ≤ 400 ms |
| Cognitum token cost per request | 0 B heap growth | 0 B heap growth |

Numbers measured against the virtual-seed binary in `seed/virtual-seed/`
when present; otherwise a local MSW mock (measurement is indicative, not
authoritative). `tests/bench/*.bench.ts` emits Markdown, committed
under `sdks/node/BENCH.md` on release tags.

### 14. Examples

`sdks/node/examples/` (tsx-runnable, not shipped in `files`):

- `examples/cloud-tour.ts` — `new Cognitum({})` → `health()` →
  `catalog.browse()` → `orders.create({...})` → `mcp.listTools()`.
- `examples/seed-tour.ts` — `new SeedClient({})` → `status()` →
  `pair.status()` → `pair.create("my-laptop")` → `store.ingest(...)` →
  `store.query(...)` → `witness.chain()` → `delta.stream()` (expects
  `NotImplementedError` until seed ships SSE).
- `examples/mcp-stdio.ts` — spawn a local MCP server; exercise
  `createStdioTransport("npx", ["-y", "@cognitum/sdk-mcp"])`.
- `examples/mcp-http.ts` — `createHttpTransport({ baseUrl })`.

Each example is picked up by `pnpm run examples:typecheck` via
`tsx --no-cache --check`.

### 15. Migration from current code

Diff against `/home/ruvultra/projects/sdks/sdks/node/`:

| Change | Kind | Path(s) |
|--------|------|---------|
| Base URL default unchanged | no-op | `src/client.ts:10-11` |
| Retry base 1000 → 500 ms | semver-minor fix | `src/client.ts:172` |
| Retry cap 16_000 → 30_000 ms | semver-minor fix | `src/client.ts:172` |
| Add equal-jitter | semver-minor fix | `src/client.ts:171-173` |
| Add `maxElapsedMs` ceiling (60_000) | additive | `src/client.ts:41-45` |
| Retry loop lifted into `src/retry.ts` | move | new file |
| `CognitumError` constructor: `(code, init)` replaces `(message, code, statusCode)` | **breaking** | `src/errors.ts:8-15` |
| `AuthError` gains `reason` (required) | **breaking** | `src/errors.ts:19-24` |
| `RateLimitError` gains `tier` | additive | `src/errors.ts:27-36` |
| Add `NotImplementedError`, `ConflictError`, `ServiceUnavailableError`, `ApiError`, `NetworkError`, `TimeoutError`, `ParseError` | additive | `src/errors.ts:53+` |
| Split `mcp-stdio.ts` → `src/mcp/stdio.ts`; add `createStdioTransport` | **breaking import path** | `src/mcp-stdio.ts:1-170` → new path |
| Split `mcp.ts` → `src/mcp/http.ts`; add `createHttpTransport` | **breaking import path** | `src/mcp.ts:1-49` → new path |
| Add `src/seed/*`, `src/models/seed/*`, `src/sse.ts` | new | new files |
| `package.json` `exports` gains `./seed`, `./mcp`, `./mcp/stdio` | additive | `package.json:9-15` |
| `engines.node` `>=18` → `>=20.0.0` | **breaking** | `package.json:37` |
| `dependencies` gains `undici` | **breaking install** | `package.json:39-43` |
| Version 0.1.3 → 0.2.0 | semver-major (pre-1.0 relax per ADR-0006) | `package.json:3` |
| Tests moved into `tests/seed/`, `tests/mcp/` | move | `tests/client.test.ts:1-220` |

Migration guide ships in `sdks/node/MIGRATION-0.2.md` with concrete
before/after snippets for every breaking row above.

### 16. Open questions

| ID | Question | Owner | Default |
|----|----------|-------|---------|
| OQ-3 (carried) | SSE endpoints return 501 today. Keep throwing `NotImplementedError` or return an empty closed iterator? | ADR-0002 | throw; surface path |
| OQ-4 (carried) | Python/Rust to mirror `createStdioTransport`? | ADRs 0009/0010 | yes |
| OQ-5 (carried) | When seed enforces `X-Signature`, expose `requestSigner` callback or move to subclass? | ADR-0003 | callback |
| OQ-N1 | One `undici.Agent` per `SeedClient` or one global? | this ADR | **per client** — matches isolated credential lifetime; pay the 16-socket pool per client. Revisit if users run dozens of seed clients per process. |
| OQ-N2 | Test runner: keep `vitest` or move to `node:test`? | this ADR | **vitest** — existing setup, MSW integration, UI, coverage. `node:test` is attractive but has no official fetch-mock story. |
| OQ-N3 | `tsx` vs `tsup --watch` for example dev loop | this ADR | **tsx** — smaller foot-print, no bundler artefacts. |
| OQ-N4 | Include a CommonJS-only consumer test? | this ADR | yes, in the `attw` CI step. |
| OQ-N5 | Should `SeedClient.close()` auto-unpair? | ADR-0007 | **no** — pairing persists across processes; the caller owns the lifetime. |

## Consequences

### Positive

- SSE and MCP surfaces locked now — downstream SDKs (Python, Rust)
  have a concrete target to mirror.
- CI catches the two historical footguns (`Authorization: Bearer`,
  `console.log(apiKey)`) automatically.
- Migration diff is mechanical; a reviewer can grade each row.

### Negative / trade-offs

- Changing `CognitumError`'s constructor breaks any consumer that
  constructed it directly. Rare but possible; called out in
  `MIGRATION-0.2.md`.
- Moving `mcp.ts` / `mcp-stdio.ts` paths invalidates deep imports.
  Mitigated by the `./mcp` and `./mcp/stdio` exports.

### Neutral

- Benchmarks are indicative, not gating. No CI regression threshold
  until virtual-seed is stable in CI (tracked separately).

## Alternatives considered

| Option | Why rejected |
|--------|--------------|
| Keep SSE out of 0.2 and ship when seed returns 200 | Call-site drift risk; callers would rewrite when 501→200 lands. |
| Adopt `node:test` now | No actively maintained fetch-mock with the MSW feature set. |
| Ship benchmarks in the published tarball | Inflates npm package; devs who want them run them locally. |
| One `undici.Agent` global | Couples credential lifetimes; violates ADR-0008 separation. |

## Compliance / verification

- `pnpm run test:coverage` ≥ 90 % lines for `src/retry.ts`,
  `src/errors.ts`, `src/auth.ts`, `src/redact.ts`.
- `attw` passes (no "Are The Types Wrong" warnings for ESM/CJS
  dual-publish).
- `pnpm pack --dry-run` shows exactly `dist/` + `README.md` + `LICENSE`.
- Lint forbidden patterns green (see §12 grep list).
- Conformance (shared with Python/Rust):
  - `GET /does-not-exist` → `NotFoundError`.
  - Unpaired `POST /store/ingest` → `AuthError("not_paired")`.
  - 429 with `retry_after_us: 2_000_000` → `RateLimitError` with
    `retryAfterMs === 2000`.

## References

- DDD model: `/home/ruvultra/projects/sdks/docs/adr/ddd/seed-domain.md`
- ADR-0002, ADR-0003, ADR-0004, ADR-0005, ADR-0006, ADR-0007, ADR-0008,
  ADR-0011, ADR-0015a, ADR-0015b.
- Current Node SDK sources (see ADR-0015a §References for full list);
  specifically for this half:
  `/home/ruvultra/projects/sdks/sdks/node/src/mcp.ts:1-49`,
  `/home/ruvultra/projects/sdks/sdks/node/src/mcp-stdio.ts:1-170`,
  `/home/ruvultra/projects/sdks/sdks/node/tsup.config.ts:1-24`,
  `/home/ruvultra/projects/sdks/sdks/node/tests/client.test.ts:1-220`,
  `/home/ruvultra/projects/sdks/sdks/node/package.json:1-44`.
- Seed endpoints referenced:
  `/home/ruvultra/projects/sdks/seed/docs/seed/api-reference.md:22-128`
  (status/pair/store/query shapes),
  `/home/ruvultra/projects/sdks/seed/src/cognitum-agent/src/http.rs:136-153`
  (error envelope + CORS headers).
