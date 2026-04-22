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

#### Common TLS-pinning interface (all SDKs)

Each SDK MUST expose a constructor surface that accepts the following five
inputs, named per language convention but semantically equivalent. The
mechanism (rustls verifier, undici `Agent.connect`, httpx `verify=` /
`SSLContext`) is per-SDK; the contract below is shared:

| Input | Type | Required when | Effect |
|-------|------|---------------|--------|
| `host` | string | always | Used to decide default-host-pinning. |
| `trust_root` | PEM bytes or path | non-default host | Builds a CA store for standard verification. |
| `client_cert` | `{cert_pem, key_pem}` | lockdown / mTLS | Attaches TLS client auth. |
| `pinned_sha256` (optional) | 32 bytes | caller pins a specific self-signed leaf | Enforced post-handshake via fingerprint comparison. |
| `dangerously_insecure` | bool | local debug only | Disables verification; MUST log a warning per request. |

**Fail-fast rule**: the SDK MUST refuse to build a client for a non-default
host with no `trust_root` and no `dangerously_insecure=true`. Failure MUST
surface as `ValidationError` / `ConfigError` at construction, NEVER at first
request. This preserves the "open-world unverified TLS can't happen by
accident" invariant.

Node-specific shape: `undici.Agent({ connect: { ca, checkServerIdentity, cert, key } })`.
Python-specific shape: `SeedPinnedVerifier(host, ca_bundle, pinned_sha256)`
feeding `httpx.Client(verify=...)`.
Rust-specific shape: custom `rustls::client::ServerCertVerifier`
(`PinnedSeedVerifier`) + `reqwest::Client::builder().use_preconfigured_tls(...)`.
See ADR-0015b §5, ADR-0013b §5.1, ADR-0014d §5.2–5.3 for the realisations.

### Cloud TLS

The cloud plane uses a public CA, so no custom trust root is ever needed.
The SDK MUST NOT expose `dangerously_insecure` for `api.cognitum.one`.

### Credentials in memory

- API keys, pairing tokens, and private key PEM material live in process
  memory only.
- SDKs MUST NOT log or print credential values.
- On Python, use `str` (immutable) — avoid passing credentials through
  mutable `bytearray`. On Rust, the key is `String` but MUST be wrapped in
  a newtype implementing `Debug` as `"<redacted>"` (e.g. `secrecy::SecretString`).
  On Node, typed getters MUST NOT serialize credentials through `JSON.stringify`.

#### Cross-SDK redaction contract

Every SDK MUST scrub the following from any log path, any `Error::Display` /
`Error.toString()`, any `Debug` / `repr()`:

1. Headers: `X-API-Key`, `Authorization`, `X-Pairing-Token`, `X-Signature`,
   `X-Signed`, `Cookie` — replace value with `<redacted>` (case-insensitive).
2. URL query params named `token`, `api_key`, `apiKey` — replace value.
3. Response-body keys: `clientSecret`, `client_secret` — replace value.
4. Any user-named env var ending in `_TOKEN`, `_KEY`, `_SECRET` that the SDK
   echoes during error surfacing.

Mechanism is per-SDK (Python uses regex, Node uses a `redactHeaders()`
helper + `Object.entries` walker, Rust uses `SecretString` + manual `Debug`
impls). A CI grep rule in each SDK MUST fail the build if any of these
fields escape unredacted via `console.log` / `print()` / `println!()` /
`JSON.stringify`. See ADR-0015b §7 (Node), ADR-0013b §7.1 (Python),
ADR-0014b §7 (Rust) for the realisations.

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
(`seed/src/cognitum-agent/src/rate_limit.rs:140-178`). All three SDKs MUST:

- NOT retry past 2 auth failures on the same credential.
- Raise `AuthError(TrustScoreBlocked)` on the third.
- Log a hint: "trust-score block imminent; stop retrying".

State lives on the client instance (per-credential counter); the SDK MUST NOT
persist it across processes. Tracked OQ-9 — resolved 2026-04-22, closing; all
three SDKs MUST implement before 1.0 (ADR-0006 §"1.0 criteria").

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
