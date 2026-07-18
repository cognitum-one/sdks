# ADR 0022: Agentic Authentication, Tenant, Budget, Secret, and Consent Isolation

- **Status:** Proposed
- **Date:** 2026-07-18
- **Deciders:** Cognitum SDK Working Group, Identity, Security, Privacy, FinOps, product owners
- **Scope:** cross-cutting (`sdks/node`, `sdks/python`, `sdks/rust`)

## Context

ADR-0003 establishes `X-API-Key` as the current Cognitum cloud convention, but
the new products cross different identity and trust boundaries:

- Meta LLM accepts `cog_` API keys on serving routes and supports Cognitum OAuth
  on a subset of operations. Operations carry different scopes such as
  completion tiers and pod actions
  (`cognitum-one/meta-llm@948bd31a:README.md:44-51,131-132,216-222`).
- Meta Proxy requires a local bearer token stored in
  `~/.ruflo/proxy-token`, currently created with mode `0600`
  (`cognitum-one/meta-proxy@43427e92:README.md:198,273`). It also manages local
  OAuth and provider-key state whose routing consequences differ from a cloud
  API key.
- Public MetaHarness is a local tool and should not receive a cloud credential.
- HarnessaaS current source uses Cognitum keys, while its stale gateway document
  still declares Google ID tokens. It also receives source repositories,
  commands, patches, and evidence, so credential leakage has code-execution
  consequences.

Current SDK parity is not sufficient for these risks. Node resolves an explicit
cloud key and then `COGNITUM_API_KEY`, Python requires a key directly, and Rust
has configuration structures whose derived `Debug` representation can include
the raw key. The new integration cannot compound those inconsistencies.

Budget and consent are also security boundaries. Meta LLM reserves and commits
spend and may escalate tiers; Meta Proxy has explicit sponsored and power-saver
planes; HarnessaaS performs expensive execution and may handle artifacts or
training contributions. An SDK retry, fallback, or convenience default MUST NOT
change payer, data residency, model tier, training use, or execution authority.

## Decision

Bind every credential, tenant identity, budget policy, and consent grant to one
product, normalized origin, and declared audience. Default to least privilege,
fail closed on ambiguous auth or consent, and make server-side tenant and budget
enforcement authoritative. Extend ADRs 0003 and 0007 with the rules below; where
there is conflict for agentic modules, this ADR is more specific.

### D1. Credential-provider contract

Product clients accept a credential provider, not an untyped reusable header
map:

```text
CredentialProvider {
  acquire(CredentialRequest) -> Credential
  identity() -> non-secret stable provider identity
  invalidate(reason)
}

CredentialRequest {
  product,
  normalized_origin,
  audience,
  required_scopes,
  operation,
  interactive_allowed
}

Credential {
  scheme,
  secret,
  expires_at,
  granted_scopes,
  audience,
  source
}
```

The provider MUST refuse an audience or origin mismatch. Credentials are
acquired after request validation and capability preconditions but before I/O.
Refresh may occur once after a verified authentication challenge; generic
retries do not repeatedly invoke an interactive login.

The `secret` is held in a redacting type:

- Node inspection, JSON serialization, error formatting, and structured clone
  MUST not reveal it;
- Python `repr`, `str`, dataclass conversion, pickle-by-default, and exception
  context MUST not reveal it;
- Rust `Debug`, `Display`, serde-by-default, clone diagnostics, and tracing fields
  MUST not reveal it.

Rust MUST remove or replace derived `Debug` on current cloud configuration
before any new client reuses the pattern.

### D2. Credential and header matrix

| Product | Credential | Wire placement | SDK rule |
|---------|------------|----------------|----------|
| Existing Cognitum cloud | Cognitum API key | Canonical `X-API-Key` per ADR-0003 | Existing compatibility retained |
| Meta LLM | Product-declared `cog_` key or delegated OAuth token | Exact route contract: `X-API-Key` and/or bearer | Never send both; route scope and auth method are negotiated |
| Meta Proxy | Local proxy token | `Authorization: Bearer` to loopback only | Never substitute cloud/OAuth/provider tokens |
| MetaHarness | None for local bridge | No credential header; minimal subprocess environment | Cloud and proxy secrets excluded by default |
| HarnessaaS | Product-declared Cognitum key or future delegated token | Accepted contract placement | Google ID token is unsupported until the stale spec is reconciled |

Arbitrary caller headers cannot override `Authorization`, `X-API-Key`, host,
content length, protocol version, idempotency key, request ID, trace headers, or
SDK identification. Product facades expose typed overrides where safe.

### D3. Origin binding and redirects

Credential providers are bound to the normalized origin selected during client
construction. A redirect to another origin is not followed with credentials.
There is no wildcard origin, suffix matching, or trust based solely on a shared
DNS parent.

For remote products:

- TLS verification is on by default;
- custom trust roots are explicit configuration, not environment discovery by
  a child process;
- disabling verification is allowed only for loopback development, emits a
  local warning hook, and cannot be enabled through a generic environment
  variable in production builds;
- mutual TLS credentials use a separate provider and are not serialized;
- URLs containing credentials are rejected.

For Meta Proxy, the default origin must resolve to literal IPv4 or IPv6 loopback.
Hostname resolution to loopback is insufficient for the default-safe mode
because rebinding can change the destination.

### D4. Tenant authority

The authenticated service derives the account and tenant from the credential.
The SDK MUST NOT expose `tenant_id` or `account_id` as a generic request override.

If a contract supports delegated sub-tenants, the SDK exposes a typed
`SubTenantContext` only when the credential proves the required scope. It is
sent in the contract-defined field or header, is included in the idempotency
identity, and is recorded in metadata only as an opaque ID.

Foreign resources remain indistinguishable from missing resources. The SDK maps
both to `NotFoundError`; it does not retry with another tenant or reveal whether
the ID exists. List cursors and operation handles are tenant- and origin-bound
and cannot be reused by another client identity.

### D5. Scope preflight

The SDK contract manifest maps every operation to its required scopes. Before a
billable or mutating call, a provider with known granted scopes is checked
locally. Missing scope returns `PermissionDeniedError` before I/O. Unknown scope
sets are sent once and mapped from the server response; the SDK never guesses
that a broader-looking string implies permission.

Scopes are matched as exact contract tokens. Wildcard interpretation belongs to
the identity service, not the SDK. Examples in documentation use minimum
operation scopes, not administrator keys.

### D6. Budget policy

All billable clients accept an optional caller budget policy:

```text
BudgetPolicy {
  max_estimated_cost,
  max_committed_cost,
  currency,
  max_tier,
  allow_escalation,
  reservation_ttl,
  on_unknown_estimate: reject | allow_server_enforcement
}
```

This is a client-side guard, not an accounting authority. Server reservation and
commit values are authoritative and preserved in response metadata and
receipts. The SDK:

- blocks locally when a known estimate exceeds the caller cap;
- sends only contract-supported budget controls;
- maps HTTP 402 or the contract budget code to `BudgetExceededError`;
- never raises a tier, cap, or payer as a retry strategy;
- never changes from customer-funded to sponsored or vice versa;
- treats a reservation as pending spend until the server reports release or
  commit;
- labels estimates, provider usage, reservation, commit, and invoice amounts as
  distinct fields.

A response missing authoritative cost fields is not upgraded to a verified
receipt. HarnessaaS field `w` MUST remain a preview opaque input until server
conformance proves it affects routing/cost as documented; copying it into
lineage alone does not establish behavior.

### D7. Explicit consent grants

Consent is modeled as a narrow signed or locally recorded grant, not a generic
boolean:

```text
ConsentGrant {
  kind,
  product,
  origin,
  subject,
  scope,
  issued_at,
  expires_at,
  evidence_id
}
```

Kinds include, when supported:

- `sponsored_inference`;
- `power_saver_routing`;
- `cloud_fallback`;
- `source_upload`;
- `artifact_retention`;
- `training_data_contribution`;
- `external_webhook_delivery`.

The grant must match product, origin, subject, and action. Consent for sponsored
inference does not imply cloud fallback or training contribution. Consent is
never inferred from the presence of credentials, a previous operation on
another origin, environment variables, or a retry policy.

Headless SDKs return `ConsentRequiredError` with a machine-readable required
kind. They do not open a browser or prompt unless the caller explicitly supplies
an interactive consent handler. Meta Proxy sponsored calls use a distinct method
and require a matching grant on every new client session or a verifiable
unexpired persisted grant.

### D8. Subprocess secret boundary

MetaHarness receives an allowlisted environment built from a minimal process
baseline. The default deny list includes:

```text
COGNITUM_API_KEY
COGNITUM_META_LLM_API_KEY
COGNITUM_HARNESSAAS_API_KEY
ANTHROPIC_API_KEY
OPENAI_API_KEY
RUFLO_PROXY_TOKEN
AWS_*
AZURE_*
GOOGLE_*
GITHUB_TOKEN
SSH_AUTH_SOCK
```

The implementation applies allowlisting rather than relying only on these
names. A caller may deliberately pass named non-secret values. Passing a secret
requires a product-specific `SecretMount` or credential binding supported by
the bridge; it MUST not be placed in command-line arguments or inherited
wholesale.

### D9. Repository, webhook, and artifact boundaries

Remote repository URLs MUST reject embedded credentials and unsafe schemes.
Credentials use a short-lived server-supported reference, never a URL token
that can appear in lineage or logs. Local filesystem paths are not accepted by a
remote client unless the operation explicitly uploads a bounded archive with
source-upload consent.

Webhook destinations are registered only through explicit methods with SSRF
controls. The SDK validates URL syntax but does not claim to solve server-side
DNS rebinding, redirects, retry durability, or signing-key stability. Webhook
verification defaults to fail closed on unknown key ID, algorithm, timestamp
skew, replay, or body mismatch.

Artifact URLs are treated as untrusted. Downloads enforce expected digest,
declared media type, maximum size, expiry, and redirect/origin policy. The SDK
does not attach product credentials to pre-signed artifact URLs unless the
contract requires the same origin and audience.

### D10. Secret classification and redaction

At minimum, these are always secret or sensitive:

- API keys, OAuth tokens, refresh tokens, local proxy tokens, provider keys,
  cookies, client secrets, signing private keys, repository credentials, and
  pre-signed URLs;
- prompts, completions, messages, tool arguments/results, source files, patches,
  test output, environment values, and uploaded artifacts;
- raw tenant personal data and webhook bodies.

Default logs and telemetry may include operation name, opaque request and tenant
IDs, status, latency, retry count, declared tier/plane, token counts, cache flag,
cost categories, capability version, evidence IDs, and redacted error code.
Content capture requires a separate explicit diagnostic policy with a bounded
sink and retention statement; it is never activated by a debug log level alone.

Redaction applies recursively by schema classification and defensive key-name
matching. It runs before formatting and before invoking caller telemetry hooks.
If redaction itself fails, the event is dropped and a content-free diagnostic is
emitted.

### D11. Threat model

| Threat | Example | SDK control | Server/product control still required |
|--------|---------|-------------|---------------------------------------|
| Credential confused deputy | Cloud key sent to proxy or HaaS | Product/origin/audience binding | Audience-scoped tokens |
| Tenant enumeration | Reusing operation ID across accounts | Tenant-bound handles, foreign maps to not found | Uniform 404 and authorization |
| Spend amplification | Retry launches duplicate solve | Idempotency gate and budget policy | Atomic dedupe and reserve/commit |
| Silent data residency change | Proxy falls from local to cloud | Explicit plane/consent, no SDK fallback | Correct routing reason and enforcement |
| Supply-chain secret theft | Unpinned `npx` inherits environment | Exact version, minimal env, no shell | Signed package provenance |
| SSRF | Webhook or artifact redirects internally | Syntax/origin/redirect controls | DNS/IP revalidation and egress policy |
| Evidence forgery | Unsigned lineage called tamper-evident | Verification status and fail-closed API | Stable keys and signed anchors |
| Debug leakage | Rust derived `Debug` prints API key | Redacting wrappers and sentinel tests | None; SDK owns this |

## Consequences

### Positive

- A key can no longer migrate implicitly between cloud, local proxy, process,
  and execution service boundaries.
- Budget and consent decisions become inspectable domain objects instead of
  hidden fallback behavior.
- Tenant and scope rules are consistent across Node, Python, and Rust.
- Default telemetry is operationally useful without capturing customer content.

### Negative and trade-offs

- Credential providers and explicit consent add setup compared with raw strings.
- Browser usage requires delegated short-lived credentials rather than copied
  server keys.
- Strict artifact and webhook verification may reject currently permissive
  deployments; preview escape hatches must be risk-specific and cannot claim
  verified evidence.

### Biggest failure mode and mitigation

The biggest failure mode is unintended credential or proprietary-context egress
through origin confusion, silent routing fallback, subprocess inheritance, or
diagnostics. The mitigation is audience-bound providers, exact-origin checks,
explicit consent, minimal process environments, and sentinel-secret tests across
every representation and hook.

## Alternatives considered

| Option | Pros | Cons | Why rejected |
|--------|------|------|--------------|
| One Cognitum API key string for every client | Simple | No audience/origin/scope isolation | A leaked or misrouted key crosses all products |
| Generic header callback | Flexible | Can override security headers and leak secrets | Typed credential providers constrain authority |
| Let server enforce all budgets | Less client code | User intent can be exceeded before server or transport errors | Client guard plus server authority gives defense in depth |
| One `allow_fallback` boolean | Easy | Conflates payer, residency, sponsor, and training decisions | Consent must name the exact consequence |
| Log bodies at debug level | Helpful troubleshooting | Secrets and source leak through routine diagnostics | Content diagnostics require separate explicit policy |

## Compliance and verification

Required checks:

1. sentinel secrets do not appear in `toString`, inspect, `repr`, `Debug`,
   `Display`, JSON/serde, exception chains, logs, trace events, metrics labels,
   URLs, headers shown in diagnostics, or subprocess arguments;
2. a matrix of products and hostile origins proves credentials are accepted only
   by their bound product/origin/audience;
3. redirect tests cover cross-origin, downgrade, same-origin, user-info, and
   pre-signed artifact cases;
4. scope preflight blocks known-insufficient credentials before I/O;
5. tenant-bound operation handles fail locally when used by a different client;
6. budget tests distinguish estimate, reserve, commit, release, provider usage,
   and billed cost;
7. retries never change tier, payer, plane, residency, or consent;
8. process fixtures receive only the environment allowlist;
9. webhook and lineage verification reject unknown keys, bad signatures, replay,
   and expired timestamps;
10. Rust current cloud config has an explicit redacting `Debug` implementation
    before this series is released.

### Acceptance test

Seed every credential and sensitive content field with a unique canary, exercise
success, error, retry, redirect, stream cancellation, subprocess failure,
artifact download, webhook verification, and telemetry export in all three
SDKs, then scan every captured byte. The scan must find zero canaries. Separately
prove that changing a request from local to cloud, customer-funded to sponsored,
or non-training to training requires a new matching consent grant and cannot be
caused by retry or fallback.

## References

- ADR-0003: cross-cutting authentication model
- ADR-0007: cross-cutting security model
- ADR-0019: agentic bounded contexts and SDK topology
- ADR-0020: contract source of truth and code generation
- ADR-0021: service configuration, transports, and capabilities
- ADR-0023: errors, retries, idempotency, cancellation, and time budgets
- ADR-0028: telemetry, traces, usage, receipts, lineage, and redaction
