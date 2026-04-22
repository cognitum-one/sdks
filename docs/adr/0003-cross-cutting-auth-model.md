# ADR 0003: Authentication & Signing Model

- **Status:** Accepted (with open question OQ-1)
- **Date:** 2026-04-22
- **Scope:** cross-cutting

## Context

The SDKs speak to two endpoints:

1. **Cloud control plane** at `https://api.cognitum.one` (commerce, fleet,
   brain, MCP).
2. **Seed direct** at `https://<seed-host>:8443/api/v1/*`.

Each has a different auth model, and today the three SDKs disagree on how
to send the cloud key:

| SDK | File | Header used |
|-----|------|------------|
| Node | `sdks/node/src/client.ts:48` | `X-API-Key: <key>` |
| Python | `sdks/python/cognitum/_http.py:68` | `X-API-Key: <key>` |
| Rust | `sdks/rust/src/client.rs:161` | `Authorization: Bearer <key>` |

This is an inconsistency bug. This ADR locks the answer and specifies every
auth mode the SDKs MUST support.

## Decision

### Cloud auth: `X-API-Key`

`X-API-Key: <key>` is canonical because:

- Two of three SDKs already implement it.
- The cloud API is served by Firebase Cloud Functions, which conventionally
  read custom headers server-side and would treat `Authorization: Bearer`
  differently from a static API key.
- `X-API-Key` cannot be accidentally forwarded by an HTTP proxy that strips
  `Authorization` headers.

**Action**: Rust SDK MUST switch to `X-API-Key` (`sdks/rust/src/client.rs:161`).
Keep Bearer support behind a configuration flag for a deprecation window
(2 minor releases).

### Seed auth: pairing token, optionally mTLS

- **Unpaired read** — no auth header required for GET endpoints listed as
  public in ADR-0002.
- **Paired write** — `X-Pairing-Token: <token>`, obtained from
  `POST /api/v1/pair` inside a 30-second window.
- **Lockdown** — an mTLS client certificate is additionally required (the
  seed validates the CN, see `seed/src/cognitum-agent/src/http.rs:20-24`).
  The pairing token is still required on top of mTLS.

The SDK exposes three credential types:

| Credential | Carries | Required for |
|-----------|---------|--------------|
| `ApiKey(String)` | `X-API-Key` on cloud requests | cloud (all) |
| `PairingToken(String)` | `X-Pairing-Token` on seed requests | seed writes |
| `ClientCert { cert_pem, key_pem }` | TLS client auth | lockdown seed |

All three are opaque strings inside the SDK; we do not parse them.

#### WiFi-read allowlist (seed v0.20.0)

On a paired seed, the following endpoints are readable from WiFi **without**
a pairing token. SDKs MAY issue these from any network path without first
resolving credentials. Source:
`seed/src/cognitum-agent/src/api.rs:392-400`.

| Endpoint | Note |
|----------|------|
| `GET /api/v1/status` | Core health — always allowed |
| `GET /api/v1/identity` | Added in v0.10.15 (#39) |
| `GET /api/v1/pair/status` | Added in v0.10.15 (#39) |
| `GET /api/v1/witness/chain` | Read-only integrity log |
| `GET /api/v1/custody/epoch` | |
| `GET /api/v1/store/status` | Counters only, not contents |
| `GET /api/v1/apps` / `GET /api/v1/apps/available` | |
| `GET /api/v1/ota/config` / `GET /api/v1/ota/log` | |
| `GET /api/v1/network/mesh/status` | |

Any **write** (POST/PUT/DELETE) or any **read not on this list** still
requires the pairing token on WiFi.

#### `/pair/window` override (seed v0.20.0)

`POST /api/v1/pair/window` was historically restricted to trusted paths
(localhost, USB-Ethernet, Setup WiFi AP) or to LAN first-setup on unpaired
devices. v0.20.0 adds a third acceptance path: an **already-authed admin**
(valid bearer/pairing token or mTLS client cert) may open a new pairing
window from any network path, including regular WiFi. This lets a paired
client add another client without needing physical-layer access. Source:
`seed/src/cognitum-agent/src/api.rs:4452-4471`.

SDKs MUST NOT attempt to open a pairing window without either (a) being on
a trusted path or (b) presenting an existing admin credential. The seed's
403 error body distinguishes the two cases.

### Request signing (`X-Signature` / `X-Signed`)

The seed already allows these headers via CORS
(`seed/src/cognitum-agent/src/http.rs:148`) but does not enforce them.
Reserved for a future ADR. SDKs MUST NOT set them.

### Credential provisioning

SDKs MUST support the following resolution order for the cloud API key,
in this order:

1. Explicit `apiKey` / `api_key` / `ClientConfig.api_key` constructor arg.
2. `COGNITUM_API_KEY` environment variable.
3. Error (`AuthError` — see ADR-0004) before the first network call.

For pairing tokens, the resolution order is:

1. Explicit `pairing_token` / `pairingToken` constructor arg.
2. `COGNITUM_SEED_PAIRING_TOKEN` environment variable.
3. Pair at client-open time if `auto_pair = true` AND a fresh window is open.
   Otherwise leave `pairing_token = None` and let the first write fail with
   `AuthError` so the caller can initiate pairing explicitly.

SDKs MUST NOT persist tokens to disk unless the caller opts in via a
`TokenStore` interface.

### Redaction

Every log path in every SDK MUST redact:

- `X-API-Key`, `Authorization`, `X-Pairing-Token` header values.
- URL query parameters named `token`, `api_key`, `apiKey`.
- Response bodies that include `clientSecret` (Stripe, returned by
  `POST /orders`).

## Consequences

### Positive

- A single conformance test vector can verify cloud auth across SDKs.
- Lockdown-capable mTLS is explicit and opt-in.

### Negative

- Rust SDK needs a breaking (or deprecating) change.
- Implementing mTLS on Node requires `undici` agents; on Python, `httpx`
  supports it out of the box; on Rust, `reqwest` requires the
  `rustls-tls-manual-roots` or `native-tls` feature.

## Alternatives considered

| Option | Why rejected |
|--------|--------------|
| Standardise on `Authorization: Bearer` | Would require breaking Node + Python; cloud backend already reads `X-API-Key`. |
| Support both headers silently | Encourages drift; the ADR's job is to close it. |
| Derive a JWT per request | Cloud backend doesn't consume JWTs; out of scope. |

## Compliance

- Conformance test: call `/health` with each SDK and confirm the outbound
  request carries `X-API-Key`. Run in CI.
- Lint / grep rule: CI fails if `Authorization: Bearer` appears in SDK
  sources (with a narrow allow-list for deprecation path).

## References

- DDD model: `docs/adr/ddd/seed-domain.md` §1 (ubiquitous language),
  §2.5 (platform), §6 (anti-corruption).
- Node client: `sdks/node/src/client.ts:48`
- Python http: `sdks/python/cognitum/_http.py:68`
- Rust client: `sdks/rust/src/client.rs:161`
- Seed http: `seed/src/cognitum-agent/src/http.rs:18-24, 148`
- Related ADRs: 0002 (wire), 0004 (errors), 0007 (security).
