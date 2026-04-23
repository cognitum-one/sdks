# ADR 0015b: Node.js / TypeScript SDK Implementation — Errors, Transport, Retry, Auth

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** SDK maintainers (Node)
- **Scope:** sdks/node
- **Companion:** ADR-0015a (layout, API, models),
  ADR-0015c (streaming, MCP, tests, CI, migration)

## Context

ADR-0015a locks the surface. This ADR locks how requests fail, how they
travel over TLS, how they back off under pressure, and how credentials
get into them without leaking into logs. It makes ADR-0004 (errors),
ADR-0005 (retry), ADR-0003 (auth), and ADR-0007 (security) concrete.

Existing gaps (all load-bearing for the bug fixes below):

| Bug | Current | ADR |
|-----|---------|-----|
| Retry base 1 s | `/home/ruvultra/projects/sdks/sdks/node/src/client.ts:172` | ADR-0005 (500 ms) |
| Retry cap 16 s | `/home/ruvultra/projects/sdks/sdks/node/src/client.ts:172` | ADR-0005 (30 s) |
| No jitter | `/home/ruvultra/projects/sdks/sdks/node/src/client.ts:171-173` | ADR-0005 (equal-jitter) |
| No `maxElapsedMs` ceiling | `/home/ruvultra/projects/sdks/sdks/node/src/client.ts:61-167` | ADR-0005 (60 s) |
| `AuthError` lacks `reason` | `/home/ruvultra/projects/sdks/sdks/node/src/errors.ts:19-24` | ADR-0004 |
| 501/409/503/Network/Timeout/Parse unclassified | `/home/ruvultra/projects/sdks/sdks/node/src/errors.ts:1-53` | ADR-0004 |
| No TLS pinning for seed self-signed | not implemented | ADR-0007 |
| No env-based token resolution | not implemented | ADR-0003 |
| Headers can appear in logs | grep-lint not enforced | ADR-0003, ADR-0007 |

## Decision

### 4. Error classes

> ✅ fixed 2026-04-22 (Phase 1) — `src/errors.ts` now ships
> `NotImplementedError` (with `.endpoint`), `ConflictError`,
> `ServiceUnavailableError` (with `.retryAfterMs`), `NetworkError` (with
> `cause`), `TimeoutError` (with `.phase: "connect"|"read"|"total"`),
> `ParseError` (with `.expected`), and `ConfigError`. 501 now maps to a
> typed `NotImplementedError(endpoint, message)` — see
> `tests/seed/unit/errors.test.ts` "maps 501 → NotImplementedError".
> Remaining deferred to Phase 1.5: `AuthError.reason` discriminator
> (still a plain `string` message); `RateLimitError.tier` enum. Those
> two require touching the cloud `HttpClient` surface, which is out of
> scope for the seed Phase 1 landing.

All variants from ADR-0004. Every class sets the prototype for
cross-realm `instanceof`, uses `Error.captureStackTrace` where
available, and forwards `cause` per ES2022.

```ts
// src/errors.ts
export type AuthReason =
  | "no_credentials"
  | "invalid_credentials"
  | "not_paired"
  | "pairing_window_closed"
  | "lockdown_mtls_required"
  | "trust_score_blocked";

export type RateLimitTier =
  | "unpaired" | "paired" | "localhost" | "lockdown";

export type TimeoutPhase = "connect" | "read" | "total";

interface BaseErrorInit {
  message?: string;
  statusCode?: number;
  rawBody?: string;
  correlationId?: string;
  cause?: unknown;
}

export class CognitumError extends Error {
  readonly code: string;
  readonly statusCode?: number;
  readonly rawBody?: string;
  readonly correlationId?: string;
  constructor(code: string, init: BaseErrorInit = {}) {
    super(init.message ?? code, { cause: init.cause });
    this.name = "CognitumError";
    this.code = code;
    this.statusCode = init.statusCode;
    this.rawBody = init.rawBody;
    this.correlationId = init.correlationId;
    Object.setPrototypeOf(this, new.target.prototype);
    if (typeof (Error as any).captureStackTrace === "function") {
      (Error as any).captureStackTrace(this, new.target);
    }
  }
}

export class AuthError extends CognitumError {
  readonly reason: AuthReason;
  constructor(reason: AuthReason, init?: BaseErrorInit) {
    super("AUTH_ERROR", { statusCode: 401, ...init });
    this.name = "AuthError";
    this.reason = reason;
  }
}

export class RateLimitError extends CognitumError {
  readonly retryAfterMs: number;
  readonly tier: RateLimitTier;
  constructor(retryAfterMs = 1000, tier: RateLimitTier = "unpaired", init?: BaseErrorInit) {
    super("RATE_LIMIT", { statusCode: 429, ...init });
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.tier = tier;
  }
}

// Remaining subclasses follow the same pattern: set `name`, call
// `super(code, { statusCode, ...init })`, and expose any taxonomy
// field as a readonly property. Full list with their extra fields:
//
//   ValidationError         { statusCode: 400, field?: string }
//   NotFoundError           { statusCode: 404, resource?: string }
//   ConflictError           { statusCode: 409 }
//   NotImplementedError     { statusCode: 501, endpoint: string }
//   ServiceUnavailableError { statusCode: 503, retryAfterMs?: number }
//   ApiError                { statusCode: <any>, (passthrough) }
//   NetworkError            { (no statusCode) }
//   TimeoutError            { phase: "connect" | "read" | "total" }
//   ParseError              { expected: string, got: string }
//
// Each has codes VALIDATION_ERROR, NOT_FOUND, CONFLICT,
// NOT_IMPLEMENTED, UNAVAILABLE, API_ERROR, NETWORK_ERROR, TIMEOUT,
// PARSE_ERROR respectively.
```

This is a **breaking change** vs the current
`/home/ruvultra/projects/sdks/sdks/node/src/errors.ts:1-53`
(constructors of `AuthError` and `RateLimitError` change). Handled by
the 0.1 → 0.2 version bump in ADR-0015c §15.

### 5. Transport

> ✅ fixed 2026-04-22 (Phase 1) — `src/seed/client.ts` ships a dedicated
> `SeedClient` with `src/seed/transport.ts` providing a TLS-aware
> `fetch` wrapper. `tls.ca` accepts a PEM string/Buffer; `tls.insecure`
> is accepted (dev-only, logs a one-time warning) and falls back to a
> scoped `NODE_TLS_REJECT_UNAUTHORIZED` toggle when `undici` is not on
> the dep list. `undici.Agent` path is in place behind a runtime
> `require("undici")` so the full ADR-0015b §5 behaviour lights up the
> moment `undici` is added to `dependencies` (tracked for Phase 1.5 —
> changing `package.json` deps was deferred to avoid colliding with the
> cross-repo architect's ADR-0016 landing). Non-pinned-host / missing
> CA validation will land with Phase 1.5 mesh when the pinned-host set
> is expanded beyond the default single endpoint.
>
> ✅ hardened 2026-04-22 (issue cognitum-one/sdks#18 closed) — `undici`
> is now a hard `dependencies` entry (^6.0.0). `transport.ts` builds a
> per-client `Agent` at construction time (`buildDispatcher` in
> `src/seed/transport.ts:70-99`) and attaches it as the `dispatcher`
> option on every `fetch` call. The process-wide
> `NODE_TLS_REJECT_UNAUTHORIZED` fallback has been REMOVED — mutating
> that env var was racy under concurrency and leaked insecure TLS to
> unrelated fetches in the same Node process (the cloud `Cognitum`
> client, any user-code fetch, telemetry libraries, etc.). Regression
> test: `tests/seed/unit/transport-tls-isolation.test.ts` pins the
> invariant that `process.env.NODE_TLS_REJECT_UNAUTHORIZED` is
> untouched across 50 parallel dispatcher builds, and that the insecure
> dispatcher is a distinct `Agent` instance per client.
>
> ✅ perf pass 2026-04-22 (issue cognitum-one/sdks#24 closed) — the
> `require("undici")` call that previously deferred dispatcher
> construction to first request has already been a top-level
> `import { Agent } from "undici"` since the #18 landing above, so cold
> start no longer pays a ~10-15 ms dynamic-import penalty. The remaining
> hot-path allocation — a `{...(init ?? {})}` spread on every `fetch`
> call — was removed in `src/seed/transport.ts:49-71`: when no custom
> TLS is configured the wrapper now returns `globalThis.fetch` directly
> (zero wrap overhead), and when a dispatcher IS in play we mutate the
> caller's fresh `init` in place rather than cloning it. This is safe
> because `SeedClient.dispatchOnce` builds a new `init` for every
> attempt — there is no shared-state hazard. Measured p50 overhead vs
> raw `fetch()` dropped from **0.024 ms → 0.012 ms** (2x improvement)
> on the `bench/seed-status.ts` micro-bench.

Two layers; same `undici` dispatcher class, different constructor
arguments:

| Layer | What it does | Used by |
|-------|-------------|---------|
| `src/client.ts` (cloud) | `fetch(url, { signal, dispatcher: cloudAgent })` | Cognitum |
| `src/seed/transport.ts` (seed) | `fetch(url, { signal, dispatcher: seedAgent })` with pinned TLS | SeedClient |

Cloud agent:

```ts
// src/client.ts (excerpt)
import { Agent, fetch as undiciFetch } from "undici";
const cloudAgent = new Agent({
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 60_000,
  connections: 64,                   // pool size per origin
  allowH2: true,                     // cloud supports HTTP/2
});
```

See ADR-0002 §Transport posture
(`/home/ruvultra/projects/sdks/docs/adr/0002-seed-wire-protocol.md`) for
the cross-SDK HTTP/2, keep-alive, pooling, timeout, retry, and redirect
posture that `cloudAgent` above conforms to. The `allowH2: true` setting
here is the Node-specific realisation of the "HTTP/2 opt-in per-client"
row; seed transport sets `allowH2: false` per that same table.


Seed agent — TLS pinning per ADR-0007. The seed presents a self-signed
cert today
(`/home/ruvultra/projects/sdks/seed/docs/seed/api-reference.md:544-547`).
The SDK accepts it **only** for the pinned host set (`169.254.42.1`,
`[fe80::...%*]`, `cognitum.local`). For any other host the caller MUST
pass `trustRoot`.

```ts
// src/seed/transport.ts (excerpt)
import { Agent } from "undici";

const PINNED_HOSTS = new Set([
  "169.254.42.1",
  "cognitum.local",
]);
// Link-local IPv6 is matched by prefix: fe80::/10

export function createSeedAgent(opts: {
  host: string;
  trustRoot?: string | Uint8Array;
  clientCert?: { certPem: string; keyPem: string };
  dangerouslyInsecure?: boolean;
}): Agent {
  const isPinned =
    PINNED_HOSTS.has(opts.host) ||
    opts.host.toLowerCase().startsWith("fe80:");

  return new Agent({
    keepAliveTimeout: 10_000,
    connections: 16,
    allowH2: false,                  // seed is HTTP/1.1 only (ADR-0002)
    connect: {
      ca: opts.trustRoot,
      rejectUnauthorized:
        !opts.dangerouslyInsecure && !(isPinned && !opts.trustRoot),
      checkServerIdentity: () => {
        if (isPinned && !opts.trustRoot) return undefined;
        return undefined; // rely on Node's default when trustRoot supplied
      },
      cert: opts.clientCert?.certPem,
      key:  opts.clientCert?.keyPem,
    },
  });
}
```

Non-pinned host without `trustRoot` MUST throw at `SeedClient`
construction — NOT at first request — so misconfiguration fails fast
(ADR-0007 §Compliance):

```ts
if (!isPinned && !opts.trustRoot && !opts.dangerouslyInsecure) {
  throw new ValidationError("trustRoot", {
    message: `host=${opts.host} is not pinned; pass trustRoot: <CA PEM>`,
  });
}
```

`SeedClient.close()` MUST call `agent.close()` to release sockets.

Per-attempt timeouts remain `AbortController`-based, matching the
existing pattern at
`/home/ruvultra/projects/sdks/sdks/node/src/client.ts:62-64`: one
`AbortController` per attempt, `setTimeout(() => controller.abort(),
cfg.timeout)`, `clearTimeout` in the `finally` block.

### 6. Retry / rate-limit implementation

> ✅ fixed 2026-04-22 (Phase 1, seed path only) — `src/seed/retry.ts`
> implements ADR-0005 exactly: BASE_MS=500, CAP_MS=30_000,
> DEFAULT_MAX_ELAPSED_MS=60_000, equal-jitter
> (`Math.random() * BASE_MS`), and honours the seed-specific 429 body
> via `parseSeedRetryAfter({retry_after_us, error})`. POST-on-timeout
> is non-retryable unless the caller sets `idempotent: true`
> (`store.query` does; `store.ingest` and `pair.create` do not).
> Regression tests in `tests/seed/unit/retry.test.ts` cover all
> classify() branches + `parseSeedRetryAfter` with a
> `retry_after_us: 2_000_000` → `retryAfterMs === 2000` assertion.
>
> ✅ cloud path compliant 2026-04-23 (issue cognitum-one/sdks#5 closed
> for Node) — the cloud `HttpClient` in `src/client.ts` now implements
> ADR-0005 exactly: `BASE_MS=500`, `CAP_MS=30_000`,
> `DEFAULT_MAX_ELAPSED_MS=60_000`, equal-jitter
> (`BASE_MS * 2 ** attempt + Math.random() * BASE_MS`, clamped at
> `CAP_MS`), and the retry loop breaks early when
> `Date.now() - started >= maxElapsedMs`. Non-idempotent POSTs (default
> for `method === "POST"`) do NOT retry on 5xx or read/total timeouts
> — callers opt in per request with
> `client.request("POST", path, body, { idempotent: true })`. New
> `CognitumConfig.maxElapsedMs` option exposes the budget at construction
> time. Regression tests in `tests/client-retry.test.ts` (20 tests)
> cover: jitter non-zero + bounded to cap, attempt=0 samples in
> `[500, 1000] ms`, `maxElapsedMs=50` breaks early with `retries=9`,
> GET retries on 500 by default, POST does NOT retry on 500 without
> `idempotent:true`, POST with `idempotent:true` retries on both 500
> and AbortError timeouts, POST without the flag does NOT retry on
> AbortError. The old 1 s / 16 s constant is gone from the cloud tree
> (CI grep passes).
>
> ✅ perf pass 2026-04-22 (issue cognitum-one/sdks#23 Node portion
> closed) — the JSON body is now serialised ONCE per `request()` call
> and threaded into each `dispatchOnce` invocation via a new `bodyStr`
> parameter (`src/seed/client.ts:285-295, 453-472`). Before this fix
> the retry loop paid a full `JSON.stringify(opts.body)` on every
> attempt; on a 10-100 KB vector-ingest payload with 3 retries that's
> 30-300 KB of wasted string work per call. GET/HEAD short-circuit the
> serialiser entirely. Regression test:
> `tests/seed/unit/retry-body-serialize-once.test.ts` hooks
> `JSON.stringify` via a `vi.spyOn` wrapper and asserts the
> marker-tagged POST body is stringified at most once across a 4-peer
> dispatch + retry chain, while confirming GET requests never stringify
> their body at all. The Rust half of #23 is tracked separately in
> `/home/ruvultra/projects/sdks/sdks/rust/docs/adr/`.

Shared `src/retry.ts`. Fixes the 1 s base / 16 s cap / no-jitter bug in
`/home/ruvultra/projects/sdks/sdks/node/src/client.ts:171-173`.
Implements ADR-0005 exactly.

```ts
// src/retry.ts
import {
  CognitumError, RateLimitError, ServiceUnavailableError,
  NetworkError, TimeoutError, AuthError, ValidationError,
  NotFoundError, NotImplementedError, ConflictError, ParseError,
} from "./errors.js";

const BASE_MS = 500;
const CAP_MS  = 30_000;
const DEFAULT_MAX_ELAPSED_MS = 60_000;

export interface RetryConfig {
  retries: number;                   // attempt budget beyond the first
  maxElapsedMs: number;              // default DEFAULT_MAX_ELAPSED_MS
  rateLimitRetry: boolean;
  method: "GET" | "POST" | "PUT" | "DELETE" | "HEAD";
  logger?: { debug: (rec: RetryLog) => void };
}

export interface RetryLog {
  attempt: number;
  next_delay_ms: number;
  reason: string;
  url: string;                       // path only (no query, no host)
}

export async function runWithRetry<T>(
  op: (attempt: number) => Promise<T>,
  cfg: RetryConfig,
  pathForLog: string,
): Promise<T> {
  const started = Date.now();
  let attempt = 0;

  for (;;) {
    try {
      return await op(attempt);
    } catch (err) {
      const elapsed = Date.now() - started;
      const { retriable, hintMs } = classify(err, cfg);
      const over = attempt >= cfg.retries || elapsed >= cfg.maxElapsedMs;
      if (!retriable || over) throw err;

      const expo = BASE_MS * 2 ** attempt;
      const jitter = Math.random() * BASE_MS;               // equal-jitter
      const computed = Math.min(CAP_MS, expo + jitter);
      const delay = Math.max(computed, hintMs ?? 0);

      cfg.logger?.debug({
        attempt, next_delay_ms: delay,
        reason: (err as Error).name, url: pathForLog,
      });
      await sleep(Math.min(delay, cfg.maxElapsedMs - elapsed));
      attempt += 1;
    }
  }
}

function classify(err: unknown, cfg: RetryConfig): {
  retriable: boolean; hintMs?: number;
} {
  if (err instanceof RateLimitError)
    return { retriable: cfg.rateLimitRetry, hintMs: err.retryAfterMs };
  if (err instanceof ServiceUnavailableError)
    return { retriable: true, hintMs: err.retryAfterMs };
  if (err instanceof NetworkError) return { retriable: true };
  if (err instanceof TimeoutError) {
    // ADR-0005: read-timeout on non-idempotent POST is non-retriable.
    if (err.phase === "connect") return { retriable: true };
    return { retriable: cfg.method !== "POST" };
  }
  if (err instanceof CognitumError && err.statusCode
      && err.statusCode >= 500 && err.statusCode !== 501) {
    return { retriable: true };
  }
  if (err instanceof AuthError
   || err instanceof ValidationError
   || err instanceof NotFoundError
   || err instanceof ConflictError
   || err instanceof NotImplementedError
   || err instanceof ParseError) return { retriable: false };
  return { retriable: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
```

429 handling MUST also parse the seed JSON body
`{"error":"rate limited — retry after Ns"}` and any `retry_after_us`
field before falling through to the exponential curve. The canonical
resolution order lives in ADR-0005 §"429 handling (seed specific)"; the
Node realisation (`parseSeedRetryAfter`) implements that contract
verbatim — do not reorder the lookups here without updating ADR-0005.

> ✅ cloud path compliant 2026-04-23 (issue cognitum-one/sdks#6 closed
> for Node) — `src/client.ts` now reads the 429 body once (as text) and
> threads it through `resolveRetryAfter(response, body)`, which checks
> `retry_after_us` (µs → ms), then the `{error,message}` strings for
> `"retry after Ns"`, then falls through to a plain-text regex scan,
> and ONLY then to the `Retry-After` header. Body signals win over the
> header when both are present (some proxies strip `Retry-After`).
> Covered by `tests/client-retry.test.ts` §"#6 429 body parsing": 7
> tests including `retry_after_us: 2_500_000` → 2500 ms,
> `"rate limited — retry after 3s"` → 3000 ms, and header-overrides
> semantics.

```ts
// src/seed/client.ts (excerpt, 429 path)
const retryAfterMs = parseRetryAfter(res.headers)
  ?? parseSeedRetryAfter(await res.clone().json().catch(() => null))
  ?? 1000;
throw new RateLimitError(retryAfterMs, tierFromUrl(path));

function parseSeedRetryAfter(body: unknown): number | undefined {
  if (typeof body !== "object" || !body) return undefined;
  const us = (body as Record<string, unknown>).retry_after_us;
  if (typeof us === "number") return Math.round(us / 1000);
  const msg = (body as Record<string, unknown>).error;
  if (typeof msg === "string") {
    const m = /retry after (\d+)s/i.exec(msg);
    if (m) return Number(m[1]) * 1000;
  }
  return undefined;
}
```

Trust-score protection is cross-SDK MUST per ADR-0007 §"Trust-score
protection" (resolves OQ-9): on the third auth failure against the same
credential within one process, the SDK raises `AuthError("trust_score_blocked")`
and refuses to retry that credential until the caller resets it. State
lives on the client instance; no disk.

> ✅ implemented 2026-04-22 (issue cognitum-one/sdks#16 closed for Node)
> — `src/seed/client.ts:135-146` holds a per-client, per-peer
> `Map<peerKey, number>` counter. `src/seed/client.ts:297-351` checks
> the counter BEFORE dispatch (pre-gate on cached block) AND on the
> returned `AuthError` (post-increment). On the 3rd consecutive
> `AuthError` against the same peer, the request loop throws the new
> `TrustScoreBlockedError` from `src/errors.ts:134-178` (`code:
> "TRUST_SCORE_BLOCKED"`, `peerKey`, `consecutiveFailures: 3`,
> `retryableAfter: null`). The error is NOT in
> `shouldBackoffRetry`'s retry set, so the failover state machine does
> NOT cycle to another peer on it — cycling would burn the next peer's
> budget too. Any 2xx from the same peer resets the counter; call
> `client.resetTrustScore(peerKey?)` to clear manually after rotating
> the token. Per-peer isolation: 401 on peer-A does not count against
> peer-B. Non-auth errors (5xx / 429 / network / timeout) never
> increment the counter, so a transient upstream failure after an
> earlier 401 still cycles normally. Regression tests:
> `tests/seed/unit/trust-score.test.ts` (8 tests) — covers the 3-strike
> abort, counter reset on success, per-peer independence, the
> not-retryable failover invariant, and 5xx cycling after a prior 401.

### 7. Auth

> ✅ verified 2026-04-22 (partial) against seed v0.20.0 — SDK 0.1.3
> sends `X-API-Key` (not `Authorization: Bearer`), per client.ts:48.
> ✅ fixed 2026-04-22 (Phase 1, seed path) — `src/seed/config.ts`
> reads `COGNITUM_SEED_TOKEN` from env when no explicit token is
> provided, and `src/seed/client.ts` emits `X-Pairing-Token` on every
> seed request (unit-tested in
> `tests/seed/unit/errors.test.ts` "forwards the X-Pairing-Token
> header").
>
> ✅ cloud path compliant 2026-04-23 (issue cognitum-one/sdks#7 closed
> for Node) — `HttpClient` now resolves the cloud API key through an
> internal `resolveApiKey(explicit)` helper that checks
> `config.apiKey` → `process.env.COGNITUM_API_KEY` → throws
> `AuthError("apiKey is required — pass config.apiKey or set
> COGNITUM_API_KEY")`. The resolved key is never logged. Explicit arg
> wins over env. Covered by `tests/client-retry.test.ts` §"#7
> COGNITUM_API_KEY env fallback": throws when neither is provided,
> uses env silently when arg is omitted, and explicit arg overrides
> env.
>
> Still deferred to Phase 1.5: the dedicated `redactHeaders` /
> `redactValue` helpers — the seed client never logs headers at all
> today, so there's no exposure in the Phase 1 path.
>
> ✅ hardened 2026-04-22 (issue cognitum-one/sdks#15 closed) —
> `PairResource.create()` no longer returns the freshly-minted pairing
> token as a plain `string` field (`pairing_token`). The wire response
> is immediately promoted to a curated `PairCreateResponse` where
> `token: SecretString` redacts itself through `toJSON` /
> `util.inspect` / `toString`. Callers use `result.token.reveal()` at
> the single write site (typically `book.set(peerUrl, result.token)`).
> Regression test: `tests/seed/unit/pair-token-redaction.test.ts`
> asserts that `JSON.stringify(result)`, `util.inspect(result)`, and
> `String(result.token)` never contain the raw sentinel token. See
> `src/seed/resources/pair.ts:23-92` and
> `src/seed/tokenBook.ts:24-63` (`SecretString`).
>
> ✅ audited 2026-04-22 (issue cognitum-one/sdks#21 closed for Node) —
> full redaction coverage audit of `src/seed/**`. Outcome: the
> existing `SecretString` wrapping on per-peer `TokenBook` entries
> (#19) and `PairCreateResponse.token` (#15) already satisfy ADR-0007
> §"Cross-SDK redaction contract" for every log + error path in the
> seed tree. Audit findings: (1) the only `console.*` call is the
> one-time TLS-insecure warning in `src/seed/transport.ts:36` — a
> bounded message with no header / token / body content; (2) the
> `retry.ts:86` debug logger emits only
> `{attempt, next_delay_ms, reason, path}` — path is the URL path
> only (no host, no query); (3) all `throw new *Error(...)` messages
> in `dispatch.ts` / `client.ts` / `peers.ts` / `config.ts` are built
> from path-only strings, status codes, or the seed's own JSON error
> envelope (`rec.error` / `rec.message`) — never from request
> headers or client-supplied credentials; (4) no resource binding
> threads `token` / `api_key` / `apiKey` / `key` into the query
> string (verified in `buildUrl` at `client.ts:521-537`). No code
> changes required — conformance test added at
> `tests/seed/unit/redaction-conformance.test.ts` (8 tests) pumps a
> sentinel pairing token + api key through 401 / 403 / 429 / 500 /
> 503 / 422 status classes and asserts the sentinels never appear in
> `err.message`, `err.toString()`, `err.stack`, or
> `util.inspect(err)`. This is the regression guard against future
> drift; the dedicated `redactHeaders` / `redactValue` helpers listed
> below remain future work for when the seed client grows a verbose
> log mode.

Credential resolution order (ADR-0003 §Credential provisioning):

| Slot | Source | Error if missing |
|------|--------|------------------|
| Cloud API key | `config.apiKey` → `COGNITUM_API_KEY` | `AuthError("no_credentials")` at `new Cognitum(...)` |
| Seed token | `config.pairingToken` → `COGNITUM_SEED_TOKEN` | none at construction; first write fails with `AuthError("not_paired")` |
| Client cert | `config.clientCert` only | opt-in; no env |

```ts
// src/auth.ts
import { AuthError } from "./errors.js";

export function resolveCloudKey(explicit?: string): string {
  const k = explicit ?? process.env.COGNITUM_API_KEY ?? "";
  if (!k) throw new AuthError("no_credentials", {
    message: "apiKey is required (pass it or set COGNITUM_API_KEY)",
  });
  return k;
}

export function resolveSeedToken(explicit?: string): string | undefined {
  return explicit ?? process.env.COGNITUM_SEED_TOKEN ?? undefined;
}
```

Header injection (verified against
`/home/ruvultra/projects/sdks/sdks/node/src/client.ts:47-50`, which is
already correct for cloud):

```ts
// Cloud
headers["X-API-Key"] = this.apiKey;

// Seed — only when a token is held
if (this.pairingToken) headers["X-Pairing-Token"] = this.pairingToken;
```

Redaction — Node MUST satisfy the cross-SDK contract in ADR-0007
§"Cross-SDK redaction contract" (headers, query params, response bodies,
env-var echoes). The Node mechanism is a `redactHeaders()` helper plus a
recursive `redactValue()` walker; Python uses regex, Rust uses
`SecretString`. The contract is identical across all three.

```ts
// src/redact.ts
const SENSITIVE_HEADERS = new Set([
  "x-api-key", "authorization", "x-pairing-token",
  "x-signature", "x-signed", "cookie",
]);
const SENSITIVE_KEYS = new Set([
  "apiKey", "api_key", "token", "pairingToken", "pairing_token",
  "clientSecret", "client_secret",
]);

export function redactHeaders(
  h: Headers | Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = h instanceof Headers ? [...h.entries()] : Object.entries(h);
  for (const [k, v] of entries) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? "<redacted>" : v;
  }
  return out;
}

export function redactValue(v: unknown, keyHint?: string): unknown {
  if (keyHint && SENSITIVE_KEYS.has(keyHint)) return "<redacted>";
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, vv] of Object.entries(v)) out[k] = redactValue(vv, k);
    return out;
  }
  return v;
}
```

No SDK log path MAY call `JSON.stringify(headers)` or `String(headers)`
directly; every call site passes through `redactHeaders`. The CI grep
in ADR-0015c §12 enforces this.

Token stores (opt-in, no default to disk; ADR-0007 §"Pairing flow
safety"): `interface TokenStore { get(clientName): Promise<string|undefined>; set(clientName, token): Promise<void>; delete(clientName): Promise<void>; }`.
Reference implementations (keychain, fs, in-memory) live in user code;
the SDK only wires the interface.

## Consequences

### Positive

- Error handling aligns across the three SDKs for the first time.
- Retry behaviour becomes predictable under load (equal-jitter, bounded
  elapsed time, respects `Retry-After` and seed JSON body).
- TLS pinning is explicit: pinned hosts are whitelisted, everyone else
  needs a CA.
- Redaction is automatic; a reviewer can grep for bypasses.

### Negative / trade-offs

- `CognitumError`'s constructor signature changes — breaking for any
  consumer that threw custom `CognitumError` instances directly. Rare
  but possible; callout in ADR-0015c §15.
- `AuthError`'s new `reason` field is required, breaking current
  `new AuthError(message)` call sites inside the SDK itself.
- `undici.Agent` per `SeedClient` uses ~16 sockets per client. Not a
  concern for typical use; documented open question OQ-N1 in 0015c.

### Neutral

- Trust-score protection is entirely client-side; it prevents the SDK
  from tripping the seed's 3-strikes limit but doesn't replace it.

## Alternatives considered

| Option | Why rejected |
|--------|--------------|
| Rely on raw `fetch` for TLS pinning | Global `NODE_TLS_REJECT_UNAUTHORIZED=0` is the only knob; poisons every request. |
| Centralise timeout in `undici.Agent.connectTimeout` | Covers TCP only; doesn't catch slow-body attacks. |
| Full-jitter (`uniform(0, backoff)`) | ADR-0005 locks equal-jitter. |
| Sniff credentials from `~/.cognitum/credentials` | Silent persistence violates ADR-0007 §"no disk". |
| Promote `trust_score_blocked` to a specialised subclass of `AuthError` | `reason` already carries the discriminator; no second axis needed. |

## Compliance / verification

- CI grep: `Authorization:\s*Bearer` in `src/` fails the build
  (ADR-0003 §Compliance).
- CI grep:
  `console\.(log|info|warn|error)\(.*(apiKey|api_key|token|signature)`
  fails.
- CI grep: `JSON\.stringify\(.*headers` in `src/` fails (redact or
  don't log).
- Unit: `new Cognitum({})` without env throws
  `AuthError("no_credentials")`.
- Unit: 10 concurrent 429s produce delays with non-zero variance
  (equal-jitter sanity check).
- Unit: `retry_after_us: 2_000_000` on 429 body yields
  `RateLimitError.retryAfterMs === 2000` (guards the seed-specific
  parser).
- Regression: 1-s / 16-s backoff no longer appears anywhere in `src/`
  (grep for `16_000\)` / `16000\)` in `src/` fails).
- Regression: a forced 25-s server delay + `retries=3` yields elapsed
  time in `[25_000, 60_000]` ms, NEVER capped at 16 s.
- Integration: `host="example.com"` without `trustRoot` throws at
  construction (ADR-0007 §Compliance).

## References

- DDD model: `/home/ruvultra/projects/sdks/docs/adr/ddd/seed-domain.md`
- ADR-0003 (auth), ADR-0004 (errors), ADR-0005 (retry),
  ADR-0007 (security), ADR-0008 (node arch),
  ADR-0015a (layout/API), ADR-0015c (ops).
- Current Node SDK:
  `/home/ruvultra/projects/sdks/sdks/node/src/client.ts:10-208`,
  `/home/ruvultra/projects/sdks/sdks/node/src/errors.ts:1-53`.
- Seed references:
  `/home/ruvultra/projects/sdks/seed/src/cognitum-agent/src/http.rs:136-153`,
  `/home/ruvultra/projects/sdks/seed/src/cognitum-agent/src/rate_limit.rs:70-178`
  (rate limiter + trust score).
