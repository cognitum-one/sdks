# ADR 0015c: Node.js / TypeScript SDK Implementation — Streaming, MCP, Ops

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** SDK maintainers (Node)
- **Scope:** sdks/node
- **Companion:** ADR-0015a (package layout, public API, typed models),
  ADR-0015b (errors, transport, retry, auth)

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
