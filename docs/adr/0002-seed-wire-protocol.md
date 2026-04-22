# ADR 0002: Seed Wire Protocol (shared HTTP contract)

- **Status:** Accepted
- **Date:** 2026-04-22
- **Scope:** cross-cutting (sdks/node, sdks/python, sdks/rust)

## Context

All three SDKs need one canonical description of the HTTP contract exposed by
the Cognitum Seed so that the Node, Python, and Rust implementations stay in
lock-step. The seed code is the ground truth
(`seed/src/cognitum-agent/src/http.rs`,
`seed/src/cognitum-agent/src/rate_limit.rs`,
`seed/docs/seed/api-reference.md`), but nothing in the SDK tree currently
describes what the SDKs MUST implement.

As of today, **no SDK implements this protocol**. They implement the Cloud
control plane at `https://api.cognitum.one` (see ADR-0011). This ADR is the
target contract for the Seed-direct modules that each SDK MUST add.

## Decision

Every SDK that wants to talk to a Seed MUST conform to the protocol below
verbatim. Where the seed's behavior and its docs disagree, the seed wins;
where the seed's behavior and this ADR disagree, this ADR wins and the seed
is a bug.

### Transport

| Aspect | Value | Source |
|--------|-------|--------|
| Scheme | `https` (self-signed TLS on port 8443). A plain HTTP listener on port 80 also serves the same router but MUST NOT be used by SDKs. | `seed/docs/seed/api-reference.md:3-4`, live probe on 169.254.42.1 |
| Default host | `169.254.42.1` (USB gadget) or `cognitum.local` (mDNS) | `seed/docs/seed/sdk-guide.md:9-13` |
| TLS verification | Disabled by default for `169.254.42.1` / `cognitum.local`; MUST be enabled when a custom `trust_root` is supplied. | `seed/docs/seed/api-reference.md:544-547` |
| HTTP version | HTTP/1.1, keep-alive on by default | `seed/src/cognitum-agent/src/http.rs:102-108` |
| Max request body | 64 KB for most endpoints, 16 MB for `/firmware/*` and `/upgrade/*` | `seed/src/cognitum-agent/src/http.rs:82-83` |
| Compression | None on either direction | implicit in `http.rs` |

### URI structure

- Every Seed endpoint is under `/api/v1/`.
- Two free-form UIs are also served: `/` (device guide) and `/cog-store`.
  SDKs MUST NOT depend on the HTML pages.
- Path segments use snake_case for resources and lower-kebab for enums
  (`optimize`, `sensor`, `coherence`, `thermal`, `custody`, `witness`,
  `boundary`, `delivery`, `delta`, `pair`, `identity`, `status`).

### Methods

| Method | Usage |
|--------|-------|
| `GET` | All queries. Idempotent, safe, cacheable by `Cache-Control` only when the seed sets it (it does not today). |
| `POST` | Command + mutation. Writes. |
| `PUT` | Replace a named config document (e.g. `/sensor/embedding/config`, `/thermal/config`, `/coherence/config`). |
| `DELETE` | Unpair (`DELETE /api/v1/pair/{client_name}`). |
| `OPTIONS` | CORS preflight, returns the headers below. |

### Request headers

| Header | When | Value |
|--------|------|-------|
| `Content-Type` | Any body present | `application/json` (binary RVF only on `/store/sync` body) |
| `Accept` | Recommended | `application/json` |
| `X-Pairing-Token` | All writes and paired-tier reads | Opaque token returned by `POST /api/v1/pair`. `seed/docs/seed/api-reference.md:335` |
| `X-Signature` / `X-Signed` | Reserved for future request signing | Not used by any SDK today. Allowed by CORS at `seed/src/cognitum-agent/src/http.rs:148`. |
| Client cert | Lockdown only | mTLS; the seed matches on CN. `seed/src/cognitum-agent/src/http.rs:18-24` |

### Response headers (always present)

```
Content-Type: application/json
Connection: keep-alive | close
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-Signature, X-Signed
```

`seed/src/cognitum-agent/src/http.rs:145-153`

### Status codes (canonical mapping)

| Code | Meaning | SDK error (see ADR-0004) |
|------|---------|--------------------------|
| 200 | Success | — (returns `T`) |
| 202 | Accepted (async op started) | — (returns `T` or `()`) |
| 204 | No content | — (returns `()`) |
| 400 | Bad request / malformed JSON | `ValidationError` |
| 403 | Forbidden: `"not paired"` or pairing required or mTLS missing | `AuthError` |
| 404 | Unknown endpoint or resource | `NotFoundError` |
| 405 | Method not allowed | `ValidationError` |
| 429 | Rate limited (paced by GCRA; `retry_after_us` in body) | `RateLimitError` |
| 500 | Internal | retry, then `ApiError` |
| 501 | Not implemented (SSE placeholders) | `NotImplementedError` (new) |
| 503 | Service unavailable (lockdown in progress) | retry, then `ApiError` |

`seed/docs/seed/api-reference.md:526-536`.

### Response envelope

There is **no** envelope. Successful responses are the resource JSON directly.
Error responses are always:

```json
{ "error": "short human-readable message" }
```

`seed/src/cognitum-agent/src/http.rs:136-137`.

### Authentication tiers

| Tier | How to reach | Rate | Notes |
|------|-------------|------|-------|
| Unpaired | No pairing token | 10 burst / 2 sustained req/s | GETs under `/status`, `/identity`, most read endpoints |
| Paired | `X-Pairing-Token` header valid | 100 burst / 20 sustained req/s | Unlocks all writes except those gated by lockdown |
| Localhost | Source IP in `127.0.0.0/8` or `::1` | 1000 burst / 200 sustained req/s | Only reachable from the seed itself |
| Lockdown + mTLS | Valid client cert under lockdown | Same as paired | Required in lockdown; supplements (not replaces) pairing |

`seed/src/cognitum-agent/src/rate_limit.rs:27-40`,
`seed/docs/seed/security-model.md:165-171`.

### Pairing flow

1. `GET /api/v1/pair/status` → `{paired, client_count, pairing_window_open, window_remaining_secs}`.
2. If not paired, `POST /api/v1/pair` with `{ "client_name": "..." }` within
   a 30-second window. Returns a token.
3. Subsequent writes send `X-Pairing-Token: <token>`.
4. `DELETE /api/v1/pair/{client_name}` to unpair.

`seed/docs/seed/api-reference.md:61-87`.

### Endpoint inventory (69 total — v0.20.0 stable surface)

> **Synced to seed v0.20.0** (`seed/src/cognitum-agent/Cargo.toml:3`, tag
> `v0.20.0`, commit `5cd1e65`). v0.20.0 adds `POST /api/v1/ota/check-now`
> and enumerates the previously undocumented OTA/Firmware group.

SDKs MUST expose typed helpers for the endpoints listed below. Grouped by
bounded context (see `docs/adr/ddd/seed-domain.md`).

#### Custody (8)
- `GET /api/v1/status` (cross-cutting; also surfaces optimizer/delivery stats)
- `GET /api/v1/identity`
- `GET /api/v1/witness/chain`
- `POST /api/v1/witness/verify`
- `GET /api/v1/custody/epoch`
- `POST /api/v1/custody/witness`
- `POST /api/v1/custody/sign`
- `POST /api/v1/custody/verify`
- `GET /api/v1/custody/attestation`

#### Optimizer — vector store (6)
- `GET /api/v1/store/status`
- `POST /api/v1/store/ingest`
- `POST /api/v1/store/query`
- `POST /api/v1/store/delete`
- `GET /api/v1/store/sync` (binary RVF)
- `POST /api/v1/store/sync` (binary RVF push)

#### Optimizer — analysis (5)
- `GET /api/v1/optimize/status`
- `POST /api/v1/optimize/trigger`
- `GET /api/v1/optimize/metrics`
- `GET /api/v1/boundary`
- `POST /api/v1/boundary/recompute`

#### Delivery (3)
- `GET /api/v1/delivery/image`
- `GET /api/v1/delta/stream` (501 today)
- `GET /api/v1/delta/history`

#### Pairing (3)
- `GET /api/v1/pair/status`
- `POST /api/v1/pair`
- `DELETE /api/v1/pair/{client_name}`

#### Demo / profiles (4)
- `GET /api/v1/demo/coherence`
- `POST /api/v1/demo/ingest-sample`
- `GET /api/v1/profiles`
- `POST /api/v1/profiles`

#### Sensor (17) — ADR-041
- `GET /api/v1/sensor/list`
- `GET /api/v1/sensor/latest/{name}`
- `GET /api/v1/sensor/stream` (501 today)
- `GET /api/v1/sensor/store/status`
- `GET /api/v1/sensor/gpio/pins`
- `GET /api/v1/sensor/embedding/latest`
- `GET /api/v1/sensor/embedding/config`
- `PUT /api/v1/sensor/embedding/config` (paired)
- `GET /api/v1/sensor/drift/status`
- `GET /api/v1/sensor/drift/history`
- `GET /api/v1/sensor/actuators`
- `POST /api/v1/sensor/actuator/fire/{name}` (paired)
- `GET /api/v1/sensor/reflex/rules`
- `PUT /api/v1/sensor/reflex/rules` (paired)
- `GET /api/v1/sensor/coprocessor/status`
- `GET /api/v1/sensor/coprocessor/latest`
- plus device/channel probes not publicly catalogued yet

#### Temporal coherence (5) — ADR-042
- `GET /api/v1/coherence/profile`
- `GET /api/v1/coherence/profile/history`
- `GET /api/v1/coherence/phases`
- `GET /api/v1/coherence/orphans`
- `PUT /api/v1/coherence/config` (paired)

#### Thermal (13) — ADR-043
- `GET /api/v1/thermal/{state,governor,telemetry,silicon-profile,accuracy,dvfs-profile,turbo,coherence,config,stats}`
- `PUT /api/v1/thermal/config` (paired)
- `POST /api/v1/thermal/characterize` (paired)
- `POST /api/v1/thermal/boost` (paired)

#### OTA / Firmware (6) — v0.20.0
- `POST /api/v1/upgrade/apply` (paired; raw binary up to 16 MB)
- `GET  /api/v1/upgrade/check` (versions, capabilities, OTA config summary)
- `GET  /api/v1/ota/config`
- `POST /api/v1/ota/config` (paired; enable/disable, channel, interval)
- `POST /api/v1/ota/check-now` (paired; **new in v0.20.0**) — forces an
  immediate manifest fetch + apply check. Returns 200 immediately with
  `{triggered, message, check_interval_secs, channel}`. Returns 409 if
  `ota.config.enabled=false`. Runs asynchronously; poll
  `GET /api/v1/upgrade/check` for `last_check_epoch` / `last_update_version`.
  Ref: `seed/src/cognitum-agent/src/api.rs:4774-4804`.
- `GET  /api/v1/ota/log`

### Streaming

Two endpoints (`/api/v1/delta/stream`, `/api/v1/sensor/stream`) advertise
Server-Sent Events but return 501 today. SDKs MUST ship typed stream handles
that raise `NotImplementedError` when the seed returns 501, so the call site
doesn't change when the seed ships SSE (tracked as OQ-3).

### Pagination

None. Every list endpoint returns the full result. SDKs SHOULD document this
and NOT invent client-side paging.

## Consequences

### Positive

- One table per resource, one source of truth.
- SDKs can generate code from this document (future: OpenAPI).
- Cross-SDK parity auditable via a single test vector list.

### Negative

- Every new seed endpoint requires an update here and three SDK changes.
- The seed is allowed to evolve; this ADR needs a revision workflow.

## Alternatives considered

| Option | Why rejected |
|--------|--------------|
| Publish an OpenAPI spec in `seed/` | Out of scope for this work. Future ADR. |
| Let each SDK reverse-engineer the API | Guaranteed drift; already visible as Rust using Bearer while Node/Python use X-API-Key. |
| Generate SDKs from a single IDL | Good long-term, but premature. |

## References

- DDD model: `docs/adr/ddd/seed-domain.md`
- Seed docs: `seed/docs/seed/api-reference.md`
- HTTP implementation: `seed/src/cognitum-agent/src/http.rs:1-188`
- Rate limiter: `seed/src/cognitum-agent/src/rate_limit.rs:27-138`
- Related ADRs: 0003 (auth), 0004 (errors), 0005 (retry), 0007 (security).
