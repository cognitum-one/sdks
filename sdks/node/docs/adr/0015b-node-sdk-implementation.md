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

> ❌ failing against seed v0.20.0 2026-04-22 — 0.1.3/src/errors.ts ships
> only `CognitumError`, `AuthError`, `RateLimitError`, `ValidationError`,
> `NotFoundError`. Missing per ADR-0004: `NotImplementedError`,
> `ConflictError`, `ServiceUnavailableError`, `NetworkError`,
> `TimeoutError`, `ParseError`, and the `reason`/`phase`/`tier`/`field`
> taxonomy fields. Observed: 501 falls into the default branch as
> `CognitumError("SERVER_ERROR", 501)` — no typed `NotImplementedError`.
> Auth header is correct (`X-API-Key`, no `Authorization: Bearer`).
> Coord to file issue.

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

> ❌ failing against seed v0.20.0 2026-04-22 — shipped 0.1.3 ships no
> `SeedClient`, no `src/seed/transport.ts`, no TLS pinning, and no
> `ca`/`trustRoot` config. All seed validation used the cloud
> `HttpClient` with a `baseUrl` override + process-wide
> `NODE_TLS_REJECT_UNAUTHORIZED=0`. With that env unset and no CA:
> `CognitumError(NETWORK_ERROR, "fetch failed")`. Coord to file issue.

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

> ❌ failing against seed v0.20.0 2026-04-22 — 0.1.3/src/client.ts:171-195
> still has base=1s, cap=16s (not 30s per ADR-0005), no jitter, no
> `maxElapsedMs`, and no `retry_after_us` / JSON-body parsing for 429s.
> Observed elapsed with `retries=3` against unreachable host = ~7s
> (1+2+4s exponential). 5 rapid GETs to `/api/v1/status` did not trigger
> 429 (paired tier tolerates >5 req/s), so SDK 429 retry path remains
> unexercised. Coord to file issue.

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

### 7. Auth

> ✅ verified 2026-04-22 (partial) against seed v0.20.0 — SDK 0.1.3
> sends `X-API-Key` (not `Authorization: Bearer`), per client.ts:48.
> ❌ `COGNITUM_API_KEY` env fallback NOT implemented: client.ts:24-27
> throws `AuthError` if `config.apiKey` is missing. No
> `COGNITUM_SEED_TOKEN`, no `X-Pairing-Token` header, no redaction helpers.
> Coord to file issue.

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
