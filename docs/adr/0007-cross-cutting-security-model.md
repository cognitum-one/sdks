# ADR 0007: Security Model (SDK side)

- **Status:** Accepted
- **Date:** 2026-04-22
- **Scope:** cross-cutting

## Context

The seed documents a sophisticated defense model
(`seed/docs/seed/security-model.md`): immutable squashfs root, DICE identity,
measured-boot witness chain, GCRA rate limiting with trust score,
two-mode operation (dev / lockdown), Ed25519 OTA signing, behavioral
attestation. None of this is reflected in the SDKs.

We need to specify what the SDKs do (and do NOT do) on the user's behalf to
avoid undermining the seed's model. This ADR is the SDK-side half of the
security contract; the seed-side half lives in
`seed/docs/seed/security-model.md`.

## Decision

### TLS

- Seed requests go over HTTPS to port 8443. The seed presents a self-signed
  cert today (`seed/docs/seed/api-reference.md:544-547`).
- SDKs MUST accept the self-signed cert for the **default** hosts
  `169.254.42.1`, `[fe80::...%*]`, `cognitum.local` and only those. For any
  other host, TLS verification MUST be on and the caller MUST supply a
  `trust_root: bytes | Path` of CA PEM material.
- "Just disable TLS verification" is NOT a public knob. A `dangerously_insecure`
  flag exists for local debugging and MUST log a warning on every request
  while active.
- mTLS is supported via `ClientCert { cert_pem, key_pem }` (see ADR-0003).

### Cloud TLS

The cloud plane uses a public CA, so no custom trust root is ever needed.
The SDK MUST NOT expose `dangerously_insecure` for `api.cognitum.one`.

### Credentials in memory

- API keys, pairing tokens, and private key PEM material live in process
  memory only.
- SDKs MUST NOT log or print credential values.
- On Python, use `str` (immutable) — avoid passing credentials through
  mutable `bytearray`. On Rust, the key is `String` but MUST be wrapped in
  a newtype implementing `Debug` as `"<redacted>"`. On Node, typed getters
  MUST NOT serialize credentials through `JSON.stringify`.

### Pairing flow safety

- The seed's pairing window is 30 seconds — the SDK MUST NOT attempt to hold
  the window open by polling.
- The SDK MUST NOT auto-pair without a caller-provided `client_name`.
- On successful pairing, the token MUST be handed back to the caller via the
  return value. SDKs MUST NOT persist it.
- When `TokenStore` is opt-in, it receives `set(client_name, token)` /
  `get(client_name)` / `delete(client_name)` and the user-chosen backend
  (OS keychain, file, memory) owns persistence.

### Signature verification (future)

The seed reserves `X-Signature` / `X-Signed` request headers
(`seed/src/cognitum-agent/src/http.rs:148`) but does not yet enforce them.
This ADR says:

- Today: SDKs do not sign requests.
- Future (out of scope): when the seed starts requiring request signing,
  SDKs will accept a `request_signer: fn(&Request) -> String` callback and
  attach `X-Signature` / `X-Signed`.

### Response verification

- `POST /api/v1/custody/sign` returns an Ed25519 signature. The caller
  typically passes this back to `POST /api/v1/custody/verify`. SDKs
  SHOULD NOT reimplement verification locally — the witness chain is
  cross-checkable against `GET /api/v1/witness/chain`.
- When the cloud plane issues a Stripe `clientSecret`, the SDK MUST treat
  it as `X-API-Key`-tier sensitive (redact, no log, no `Debug`).

### Lockdown awareness

- SDKs MAY call `GET /api/v1/status` on connect and expose
  `status.paired`, `status.roles` to the caller. There is no current
  `lockdown: bool` in `/status`; callers discover lockdown by the seed
  requiring mTLS on the next write.
- On failure with `AuthError(LockdownMTlsRequired)`, the SDK message MUST
  include the phrase "lockdown active" so users can search docs.

### Trust-score protection

The seed blocks an IP after 3 auth failures for 5 minutes
(`seed/src/cognitum-agent/src/rate_limit.rs:140-178`). SDKs MUST:

- NOT retry past 2 auth failures on the same credential.
- Raise `AuthError(TrustScoreBlocked)` on the third.
- Log a hint: "trust-score block imminent; stop retrying".

### What the SDK explicitly does NOT do

- Does not implement request signing (today).
- Does not verify the measured-boot chain locally.
- Does not validate OTA firmware bundles — that's the seed's job.
- Does not cache pairing tokens on disk.
- Does not trust `api.cognitum.one` to proxy to a seed — all seed-direct
  traffic is point-to-point.

## Consequences

### Positive

- One rule set auditable across SDKs.
- Default-deny TLS for non-default hosts prevents accidental open-world
  unverified TLS.

### Negative

- Supporting mTLS adds a per-language dependency footprint (see ADR-0010
  for Rust specifics).
- Telling callers "no disk persistence" irritates users who want
  drop-in tokens. `TokenStore` is the escape hatch.

## Compliance

- Grep rule in CI: `console.log(.*apiKey|api_key|token|signature)` and
  equivalents fail the build.
- Integration test: instantiate client with `host = "example.com"` and no
  `trust_root` → MUST raise a configuration error before the first request.

## References

- DDD model: `docs/adr/ddd/seed-domain.md` §2.5 Platform, §6 ACL.
- Seed security model: `seed/docs/seed/security-model.md`
- Rate limiter trust score: `seed/src/cognitum-agent/src/rate_limit.rs:140-178`
- TLS guidance: `seed/docs/seed/api-reference.md:544-547`
- Related ADRs: 0002, 0003, 0004, 0005.
