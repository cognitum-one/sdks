# ADR 0004: Error Taxonomy

- **Status:** Accepted
- **Date:** 2026-04-22
- **Scope:** cross-cutting

## Context

Each SDK has diverged slightly in how it maps HTTP failures to exception /
result types:

| Concern | Node (`errors.ts`) | Python (`errors.py`) | Rust (`error.rs`) |
|---------|-------------------|----------------------|-------------------|
| Base type | `CognitumError extends Error` | `CognitumError(Exception)` | `enum Error` |
| Auth | `AuthError` (401/403) | `AuthError` (401/403) | `Error::Auth(String)` — UNAUTHORIZED only |
| Rate limit | `RateLimitError { retryAfterMs }` | `RateLimitError { retry_after_seconds }` | `Error::RateLimit { retry_after_ms }` |
| Validation | `ValidationError` (400/422) | `ValidationError` (400/422) | `Error::Validation(String)` |
| Not found | `NotFoundError` (404) | `NotFoundError` (404) | `Error::NotFound(String)` |
| Generic API | `CognitumError("SERVER_ERROR", status)` | `CognitumError("http_{status}")` | `Error::Api { code, message }` |
| Transport | `CognitumError("NETWORK_ERROR")` | `CognitumError("Transport error: …")` | `Error::Reqwest(reqwest::Error)` |
| Timeout | `CognitumError("TIMEOUT")` | (surfaced as transport) | (surfaced via reqwest) |

Gaps: Rust does not distinguish 403 from 401; no SDK defines a
`NotImplementedError` for the 501 seed streams (ADR-0002); no SDK distinguishes
a trust-score-blocked 403 from a permission-based 403.

## Decision

All three SDKs MUST expose the following closed taxonomy, named identically
modulo each language's conventions:

| SDK class / variant | HTTP trigger | Semantics |
|---------------------|--------------|-----------|
| `CognitumError` / `Error` (base) | — | Anything SDK-level. Always caught by `catch Error`. |
| `AuthError` / `Error::Auth { reason }` | 401, 403 "not paired", 403 pairing window closed | Caller must re-authenticate or re-pair. Carries a `reason` enum: `NoCredentials`, `InvalidCredentials`, `NotPaired`, `PairingWindowClosed`, `LockdownMTlsRequired`, `TrustScoreBlocked`. |
| `RateLimitError` / `Error::RateLimit { retry_after_ms, tier }` | 429 | `tier: "unpaired" \| "paired" \| "localhost" \| "lockdown"`; `retry_after_ms` always present (defaults 1000). |
| `ValidationError` / `Error::Validation { field?, message }` | 400, 405, 422 | Client-side issue. Optional `field` when the seed returns a structured body. |
| `NotFoundError` / `Error::NotFound { resource? }` | 404 | Unknown endpoint or missing resource. |
| `NotImplementedError` / `Error::NotImplemented { endpoint }` | 501 | SDK shim for SSE placeholder endpoints; carries the path. |
| `ConflictError` / `Error::Conflict` | 409 | Reserved (no seed endpoint uses it today, cloud orders will). |
| `ServiceUnavailableError` / `Error::Unavailable { retry_after_ms? }` | 503 | Transient; retriable per ADR-0005. |
| `ApiError` / `Error::Api { status, code?, message }` | any other 5xx / unknown 4xx | Generic pass-through with raw fields. |
| `NetworkError` / `Error::Network { cause }` | TCP / TLS / DNS / connection refused | Retriable per ADR-0005. |
| `TimeoutError` / `Error::Timeout { phase }` | Per-request timeout | `phase: "connect" \| "read" \| "total"`. Retriable. |
| `ParseError` / `Error::Parse { expected, got }` | JSON parse / schema mismatch | Never retriable. Always a bug on one side. |

`AuthError.reason` is a string enum so it crosses the wire
(logging, telemetry, CLI display) without language-specific reflection.

### Payload extraction rules

- Error message MUST be the seed's `{"error":"..."}` body when present,
  else the HTTP reason phrase, else the status code.
- Preserve the raw response body at `error.rawBody` / `.raw_body` for
  troubleshooting.
- Preserve the request-local `correlation_id` (the SDK generates a UUIDv4
  per request if the server does not echo one) at `error.correlationId`.

### Stacks and causes

- Node: `CognitumError` MUST set `cause` (ES2022) when wrapping another
  error, so `error.cause` is inspectable.
- Python: use `raise SDK_ERR from underlying_exc` (already done in
  `cognitum/_http.py:93`).
- Rust: use `#[source]` on the wrapped variant (Rust SDK uses `thiserror`).

### What is NOT a distinct error type

- 2xx-with-error-body: if a seed endpoint ever returns 200 with
  `{"error":"..."}`, that is a seed bug, not an SDK error type.
- Retry exhaustion: surface the last underlying error (e.g. `RateLimitError`
  or `NetworkError`), NOT a wrapper "retries exhausted". The call site can
  tell from the number of attempts via telemetry / logs.

## Consequences

### Positive

- Callers can write `catch RateLimitError` or `if let Error::RateLimit {..}`
  with identical semantics across languages.
- CLI and logging layers can render `auth.reason` uniformly.

### Negative

- Rust `Error` gains new variants — breaking for consumers in public crates.
  Mitigation: mark enum `#[non_exhaustive]` from day one.
- Node `AuthError` gains a `reason` field — non-breaking addition.

## Compliance

- Cross-SDK conformance test: "fetch `/does-not-exist`" must yield
  `NotFoundError` in all three SDKs.
- Cross-SDK conformance test: "hit an unpaired write" must yield
  `AuthError(reason=NotPaired)`.
- Lint: forbid `throw new Error(...)` / `raise Exception(...)` / `panic!`
  in `client.ts|_http.py|client.rs` — everything must use the taxonomy.

## References

- DDD model: `docs/adr/ddd/seed-domain.md`
- Node errors: `sdks/node/src/errors.ts:1-53`
- Python errors: `sdks/python/cognitum/errors.py:1-49`
- Rust errors: `sdks/rust/src/error.rs` (implied)
- Seed error shape: `seed/src/cognitum-agent/src/http.rs:136-137`
- Related ADRs: 0002 (wire), 0005 (retry), 0003 (auth).
