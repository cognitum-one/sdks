# ADR 0005: Retry & Rate-Limit Backoff Policy

- **Status:** Accepted
- **Date:** 2026-04-22
- **Scope:** cross-cutting

## Context

The seed paces requests with GCRA
(`seed/src/cognitum-agent/src/rate_limit.rs:70-138`) and returns 429 with
`retry_after_us` in the body when the caller exceeds burst or sustained
rate. The cloud API uses a conventional `Retry-After` header.

Current SDK retry policies disagree in small but observable ways:

| SDK | Max retries | Base backoff | Jitter | Retry-After honoured? |
|-----|-------------|--------------|--------|-----------------------|
| Node | 3 | `1s * 2^attempt`, cap 16 s | no | yes (seconds or date, `client.ts:180-195`) |
| Python | 3 | `0.5s * 2^attempt`, cap 30 s | no | yes, `max(backoff, header)` (`_http.py:100-113`) |
| Rust | 3 | `500ms * 2^(attempt-1)` | no | yes, overrides backoff (`client.rs:197-215`) |

No SDK uses jitter, and the Node SDK's 1-second base will thunder-herd after
a brief outage.

## Decision

### Retriable outcomes

| Outcome | Retriable? | Notes |
|---------|-----------|-------|
| `NetworkError` (DNS/TCP/TLS) | yes | |
| `TimeoutError` on connect | yes | |
| `TimeoutError` on read after body bytes received | **no** for non-idempotent methods | see below |
| 429 `RateLimitError` | yes, bounded by budget | |
| 500, 502, 503, 504 | yes | |
| 501 `NotImplementedError` | no | |
| Any `AuthError`, `ValidationError`, `NotFoundError`, `ConflictError`, `ParseError` | no | |

### Idempotency rule

For `GET`, `HEAD`, `DELETE` and `PUT`, all failures above are retriable.
For `POST`, retry is allowed only when the failure occurred **before** the
request body was accepted (connection refused, TLS failure, write error) or
when the response is 429 or 503 with `Retry-After`. This matches Stripe's
idempotency philosophy and is the only safe default without idempotency keys.

### Caller-attested idempotency (opt-in)

Some `POST` endpoints are semantically idempotent even though they're
POSTs (e.g. `POST /api/v1/store/query` — a read with a body). SDKs MUST
expose a per-request opt-in for the caller to attest this:

| SDK | Surface |
|-----|---------|
| Node | `client.post(path, body, { idempotent: true })` |
| Python | `http.request("POST", path, json=..., idempotent=True)` |
| Rust | `RequestBuilder::idempotent(true)` (or resource method attests internally, e.g. `store.query`) |

When `idempotent=true`, the retry loop treats the call like a `PUT` for
retry eligibility. SDKs MUST NOT default `idempotent=true` on any endpoint
that mutates state. Resource implementations MAY set `idempotent=true`
internally for known-safe POSTs (e.g. `store.query`); they MUST NOT do so
for `store.ingest`, `store.delete`, `pair`, or any other mutating call.

Server-side `Idempotency-Key` headers are out of scope until the seed or
cloud honours them (tracked OQ-10; resolved 2026-04-22 — deferred).

### Backoff formula

```
delay_ms(attempt) = min(
    cap_ms,
    max(
        server_hint_ms,                     # Retry-After if present
        base_ms * 2 ** attempt + jitter
    )
)
```

- `base_ms = 500`
- `cap_ms = 30000` (30 s)
- `jitter = uniform(0, base_ms)` — equal-jitter
- `attempt` starts at 0

Rationale: 500 ms base + equal-jitter is AWS's standard recommendation; 30 s
cap matches Python's current behavior and is long enough to ride out a
lockdown activation but short enough to fail fast on real outages.

### Budget

| Knob | Default | Rationale |
|------|---------|-----------|
| `maxRetries` | 3 | Node, Python, Rust all converge on 3 |
| `maxElapsedMs` | 60_000 | Hard ceiling; independent of `maxRetries` |
| `timeoutMs` | 30_000 | Single attempt |

SDKs MUST track total elapsed time across retries and stop once
`maxElapsedMs` is exceeded, even if `maxRetries` remain.

### 429 handling (seed specific)

The seed returns JSON bodies on 429 containing either
`retry_after_us` (microseconds) or no hint; `Retry-After` header may or may
not be set. Resolution order for `server_hint_ms` (this is the canonical
contract; per-SDK ADRs MUST implement it verbatim — Node per ADR-0015b §6
`parseSeedRetryAfter`, Python per ADR-0013b §6 `parse_retry_after`, Rust
per ADR-0014b §6.3 `parse_retry_after_ms`):

1. `Retry-After` header in seconds (integer or float).
2. `Retry-After` header as HTTP-date — delta from now.
3. `retry_after_us / 1000` from JSON body.
4. Regex match `/retry after\s+([0-9]+(?:\.[0-9]+)?)\s*s/i` on JSON body's
   `error` field — captures the seed's english-language rate-limit message
   shape `"rate limited — retry after 1s"`.
5. Fall through to the computed exponential backoff.

Additionally, after 3 consecutive 429s on the same credential, the SDK
SHOULD surface a log-level warning: the seed is likely about to IP-block
the caller (see `seed/src/cognitum-agent/src/rate_limit.rs:140-178`).

### Cloud control-plane 429

Cloud responses always set `Retry-After`. Treat as above, dropping the
JSON-body path.

### Observability

Every retry MUST increment an internal counter and emit a log record at
`debug` level with: `attempt`, `next_delay_ms`, `reason`, `url`
(path only, never full URL because of query tokens).

## Consequences

### Positive

- Cross-SDK behavior becomes predictable under load.
- Equal-jitter prevents synchronised reconnect storms after an outage.
- Idempotency rule closes the "retry double-charged order" foot-gun.

### Negative

- Python SDK needs to widen its retriable set (currently only
  `{429, 500, 503}`, see `_http.py:18`); it should add 502 and 504.
- Node SDK needs to change base from 1 s to 500 ms.
- Rust SDK needs to add jitter.

## Alternatives considered

| Option | Why rejected |
|--------|--------------|
| Retry every POST unconditionally | Unsafe without idempotency keys on the server side. |
| Circuit breaker | Premature optimisation; SDK consumers rarely need it. |
| Full jitter (`uniform(0, backoff)`) | Saves no real traffic vs equal-jitter; marginally less predictable. |

## Compliance

- Unit test in each SDK: 10 parallel requests into a mock that returns 429
  must converge after bounded delay with variance consistent with
  equal-jitter.
- Conformance test: send an unauthenticated write to `/api/v1/store/ingest`
  and verify that no retries are attempted (AuthError is non-retriable).

## References

- Seed rate limiter: `seed/src/cognitum-agent/src/rate_limit.rs:70-178`
- Node: `sdks/node/src/client.ts:61-167`
- Python: `sdks/python/cognitum/_http.py:82-121`
- Rust: `sdks/rust/src/client.rs:146-215`
- Related ADRs: 0002 (wire), 0004 (errors), 0007 (security for trust score).
