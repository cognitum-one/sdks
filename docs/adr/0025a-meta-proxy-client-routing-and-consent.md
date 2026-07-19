# ADR 0025a: Meta Proxy Client, Routing, and Consent

- **Status:** Partially Implemented (Preview maturity)
- **Date:** 2026-07-18
- **Updated:** 2026-07-19 — `MetaProxyClient` construction, `status()`/`capabilities()` (§D1-D4, PR #91); routing intent types + non-streaming chat.completions forwarding with the §D5 rule-7 required-plane check, LocalBearerToken-only auth, and the §D7 header allowlist (PR #93 — required a post-merge fix, commit `eb553f7`, removing an ADR-violating auto-retry on 429/502/503 found by independent review); streaming chat.completions with a genuinely-raced `ProxyTimeBudget` (§D8, PR #95); consent gating for the `cognitum_cloud` routing plane and a Node browser-environment rejection guard (§D9/§D10 tractable slice, PR #96). NOT implemented: `WorkloadCapability` minting (blocked on ADR-0025b, not yet started), real sponsor budget/usage/operations (also blocked on ADR-0025b's lifecycle/state fixes), Messages forwarding (only chat.completions so far), and all §D11 GA gates.

## Context

ADR-0019 defines Meta Proxy as a local inference-routing bounded context. It is
not a transparent HTTP proxy or a complete Meta LLM deployment. ADRs 0020
through 0023 define shared contracts, transports, auth, retry, cancellation,
and time budgets. ADRs 0024a and 0024b define direct Meta LLM. ADR-0025b owns
Proxy installation, configuration integrity, and process lifecycle.

The audit baseline is
`cognitum-one/meta-proxy@43427e92ee0527413ca71744b538035537e0b6ef`.
The authoritative implementation is the private repository; public
`cognitum-one/meta-proxy-dist` is a signed release mirror.

The Rust foreground binary binds to `127.0.0.1:11435` by default and exposes
the routes registered at `src/lib.rs:31-49`:

| Route | Current behavior |
|-------|------------------|
| `POST /v1/chat/completions` | Cognitum cloud only when configured cloud; otherwise local backend |
| `POST /v1/sponsor/chat/completions` | Explicit sponsored Cognitum, nonstream implementation |
| `POST /v1/messages` | Local, Cognitum cloud, sponsored Cognitum, or direct Anthropic passthrough |
| `GET /v1/models` | Always Cognitum cloud discovery; requires cloud credential |
| `GET /v1/whoami` | Always Cognitum cloud identity; requires cloud credential |
| `GET /status` | Authenticated local runtime and routing state |
| `POST /internal/reload-config` | Internal exact-token operation |

It does not proxy Responses, legacy completions, embeddings, batches, pods,
usage, safety, webhooks, vectors, or governance. Changing a `MetaLlmClient` base
URL to loopback would therefore create unsafe false parity.

“Local proxy” describes process location, not inference or data residency. The
selected plane can be local, Cognitum cloud, sponsored Cognitum, or direct
Anthropic. Current route behavior and documentation have material drift:

- bare config defaults to `passthrough`; installer ADRs promise local-only;
- chat treats passthrough as local while Messages uses direct Anthropic;
- chat drops caller routing, safety, trace, and idempotency headers;
- Messages forwards only a small Anthropic allowlist;
- inference responses do not reliably identify selected plane;
- sponsored chat parses streaming SSE as JSON;
- sponsored upstream `402` and `429` collapse to local `503`;
- the local spend ledger races, is non-atomic, and resets to zero on corruption.

The as-built evidence is `src/config.rs:54-57,350` for default/fail-open config,
`src/routes/chat.rs:24-81` and `src/routes/messages.rs:58-68,150-286` for
route and header divergence, and `src/sponsored_budget.rs:56-127` for the
unlocked read/write ledger.

The SDK cannot hide these facts with retries or inferred routing metadata.

## Decision

Add `MetaProxyClient` for an already-running authenticated loopback process. It
is independent of `MetaProxyManager` in ADR-0025b. Construction never starts,
installs, authenticates, probes, or reconfigures a process.

### D1. Public topology and omissions

```text
client.status
client.capabilities
client.chat.completions
client.messages
client.models
client.whoami

client.preview.sponsored.chat.completions
client.preview.routing
```

There are deliberately no Proxy methods for any unsupported Meta LLM resource.
Such a call returns `UnsupportedCapabilityError` before HTTP I/O.
`/internal/reload-config` is not a general client method. It belongs only to an
owning manager with the exact local bearer and cannot use a workload
capability.

### D2. Maturity groups

All current methods begin preview until a complete contract bundle exists.

| Group | Target maturity | Conditions |
|-------|-----------------|------------|
| Status and capabilities | Stable | Versioned schema, plane evidence, limitations, and compatibility range published |
| Explicit local chat and Messages | Stable | Identical plane semantics, native streams/errors, no silent cloud egress |
| Explicit Cognitum-cloud chat and Messages | Stable | Header forwarding, receipts, consent, auth, and idempotency pass conformance |
| Models and whoami | Stable | Cloud-only behavior and no-credential failure are explicit |
| Direct Anthropic and automatic power saver | Preview | Disclosure, usage, and consent evidence remain incomplete |
| Sponsored inference | Preview | Stream, budget error, atomic spend, and reconciliation blockers remain |
| Non-loopback use | Dangerous preview | Separate TLS, authentication, CORS, and exposure contract required |
| Config mutation and reload | Internal | Owned manager operation only |

Unknown versions receive a minimum-safe set: known authenticated status only,
no inference, consent change, sponsor, or automatic failover.

### D3. Client configuration and result types

```text
MetaProxyClientConfig {
  origin,                       # literal loopback by default
  local_credential_provider,
  transport,
  default_request_context,
  expected_proxy_version?,
  capabilities_snapshot?,
  telemetry
}

MetaProxyResult<T> {
  data: T,
  meta: MetaProxyResponseMeta
}

MetaProxyResponseMeta {
  request_id,
  product_version,
  protocol_version,
  http_status,
  retry_after,
  routing_receipt?,
  upstream_receipt?,
  warnings,
  unknown_headers
}
```

The HTTP client never reads or rewrites Proxy configuration files. It receives
its local credential from the typed provider in ADR-0022. Closing it releases
connections only and never stops the sidecar.

### D4. Status, capabilities, and plane evidence

```text
MetaProxyStatus {
  product_version,
  protocol_version,
  compatible_sdk_range,
  process_state,
  bind,
  configured_plane,
  selected_plane,
  routing_reason,
  automatic_usage_state,
  utilization?,
  reset_at?,
  workload_policy,
  sponsored_available,
  cloud_credential_source,
  limitations,
  request_id
}

MetaProxyRoutingReceipt {
  request_id,
  configured_plane,
  selected_plane,
  routing_reason,
  automatic,
  workload_policy,
  consent_evidence_id?,
  upstream_receipt?,
  local_usage?,
  degraded,
  warnings
}
```

Current `proxy_token_valid: true` means only that auth succeeded. Status does
not return tokens, keys, OAuth data, unsafe paths, or full account identifiers.

Every inference must return selected-plane evidence in response or terminal
stream metadata. The SDK never infers plane from configured default, model,
latency, credential source, or status. A receipt contradicting caller intent is
a protocol error and content-free high-severity telemetry event.

`capabilities()` uses an authenticated endpoint when available. Until then it
uses exact tested `/status` schema plus ADR-0020's pinned compatibility table.
It never discovers support by sending a prompt.

### D5. Data-plane and policy model

```text
RoutingPlane = local | cognitum_cloud | anthropic_passthrough | sponsored_cognitum
WorkloadPolicy = critical | standard | economy

RoutingIntent {
  required_plane?,
  allowed_planes,
  workload_policy,
  max_utilization?,
  consent_grants,
  training_share,
  fail_if_unavailable
}
```

The SDK communicates supported intent and verifies the decision; it does not
implement another router. Normative rules are:

1. automatic planes require an advertised capability and matching unexpired
   consent;
2. retry never changes plane, payer, provider class, training use, or residency;
3. `critical` suppresses automatic failover;
4. sponsor requires its explicit facade or a contracted automatic rule;
5. local failure does not authorize cloud egress;
6. unknown policy or plane fails before content transmission;
7. `required_plane` mismatch is a protocol violation even if output succeeds.

Current economy and standard utilization thresholds are implementation data,
not SDK constants. Capabilities report them as constraints.

### D6. Authentication and workload capabilities

```text
ProxyCredential = LocalBearerToken | WorkloadCapability

WorkloadCapabilityClaims {
  version,
  policy,
  worktree_id,
  expires_at
}
```

The current format is `mh1.<payload>.<hmac>`, signed with the local proxy token,
with an expiry at most 12 hours ahead. The SDK may validate non-secret claims
but does not mint capabilities itself. Minting requires an injected
`MetaProxyLifecycleProvider` that advertises the exact scoped operation;
ADR-0025b defines the provider contract and ADR-0026a defines the official
MetaHarness-backed adapter.

The bearer is sent only to literal loopback through a direct transport. Ambient
HTTP proxy variables are ignored. Cross-origin redirects, rebinding hostnames,
embedded credentials, and downgrade redirects are rejected. Cloud, OAuth,
sponsor, or provider credentials are never substituted for the local bearer.

Internal reload requires the raw bearer and rejects workload capabilities.
Login and logout belong to ADR-0025b's manager. Logout of local state does not
claim upstream token revocation unless the contract proves it.

### D7. Inference and forwarding contract

Chat and Messages reuse only the wire types and stream events whose Proxy
capabilities agree with ADR-0024a. They remain Proxy methods and return a Proxy
routing receipt.

The target cloud forwarding allowlist includes, when supported:

```text
Idempotency-Key
X-Request-ID
traceparent
tracestate
X-Cognitum-Fallback-Policy
X-Cognitum-Min-Tier
X-Cognitum-Max-Tier
X-Cognitum-Escalation
X-Cognitum-Cache
X-Cognitum-Safety
X-Cognitum-Sub-Tenant
anthropic-version
anthropic-beta
```

Authorization, local bearer, host, content length, sponsor markers,
installation identity, and training consent are never caller-forwarded. The
Proxy derives them from validated local state.

Response metadata preserves Proxy plane/version, request and retry headers,
upstream request IDs, and Cognitum receipts. Unsupported required controls fail
before content leaves the machine. Direct Anthropic passthrough remains preview
because provider usage is not verified Cognitum billed cost.

### D8. Streaming, errors, cancellation, and retry

Chat and Messages use ADR-0024a's lossless protocol streams and add plane and
Proxy version metadata. A byte-forwarded stream still requires native terminal
event, terminal error, selected-plane receipt, and upstream usage.

```text
ProxyTimeBudget {
  connect_timeout,
  first_byte_timeout,
  idle_stream_timeout,
  overall_deadline
}
```

The process currently uses a 10-second connect timeout and no overall timeout.
The SDK supplies cancellation and an optional overall deadline. Timing out one
request never kills the Proxy.

No Proxy POST is automatically retried while it drops `Idempotency-Key`. A
pre-response disconnect may already have incurred work. Status, models, and
identity use bounded read retry only when capabilities declare them safe.

```text
MetaProxyError {
  category,
  status,
  code,
  message,
  request_id,
  configured_plane?,
  selected_plane?,
  upstream_status?,
  retry_after?,
  partial,
  raw_redacted_body,
  limitations
}
```

Local connection, process exit, local backend, cloud auth, sponsor budget,
provider rate limit, upstream failure, and protocol mismatch remain distinct.
Upstream `402`, `429`, `502`, and `503` cannot be collapsed. Sponsored
`stream = true` fails locally until an end-to-end stream capability exists.

### D9. Consent, sponsor budget, and usage

Separate ADR-0022 grants cover Cognitum cloud routing, sponsor, power saver,
direct Anthropic, and training contribution. Credential presence is not
consent. Headless clients return `ConsentRequiredError` rather than prompt.

Sponsored results distinguish caller cap, Proxy-local observed spend, and
authoritative server receipt. The server receipt wins. Hard-coded local price
tables never become verified cost.

Stable sponsor support requires the lifecycle/state fixes in ADR-0025b:
interprocess locking, atomic replace, fail-closed corruption, schema and pricing
version, server reconciliation, and crash/concurrency/date/clock tests.
Training share remains independent and must be reported without content.

### D10. Loopback and browser security

Literal loopback is the only stable origin. Hostnames resolving to loopback are
insufficient in default-safe mode. The transport bypasses corporate proxies,
rejects redirects, and sends no bearer until authenticated instance identity is
proven by ADR-0025b readiness.

Non-loopback use remains dangerous preview and requires a separate TLS, remote
identity, firewall, restricted CORS, and exposure contract. The current warning
and allow-any CORS behavior are not stable remote security.

Browser packages reject Meta Proxy at build time or immediately before reading
a credential or opening a loopback socket, consistent with ADR-0029.

### D11. Client GA gates and migration

Stable client promotion requires:

1. publish ADR-0020 route, status, config, stream, error, auth, maturity, and
   limitation schemas;
2. add protocol/SDK compatibility and feature constraints to authenticated
   status or capabilities;
3. make chat and Messages plane semantics identical or deliberately separate;
4. emit selected plane, reason, policy, and automatic/manual state on every
   response and terminal stream;
5. forward approved IDs, traces, idempotency, routing, safety, and subtenant
   controls and preserve receipts;
6. reject sponsor streaming or implement real SSE, metadata, and cancellation;
7. preserve budget and rate-limit categories;
8. contract models/identity cloud-only behavior;
9. prove `critical` and absent-consent fail closed;
10. pass ADR-0025b's paired version, config, ledger, and lifecycle gates;
11. for explicit Cognitum-cloud chat and Messages specifically: confirm that
    ADR-0024a's D9 serving GA gates (1-10) have passed for the exact Meta LLM
    protocol version being relayed, covering at minimum the published wire
    schema and SSE grammars (gate 2), the `IdempotencyBindingV1` implementation
    (gate 4), and consistent protocol/request identifiers on success, error,
    and terminal stream paths (gate 9) — the Proxy method may not reach Stable
    while the underlying serving operation it reuses (D7) is still Preview.

Rollout begins status-only, then explicit local chat/Messages, then explicit
Cognitum cloud after receipt/forwarding gates **and** after gate 11 above
confirms the corresponding ADR-0024a serving operation has itself reached
Stable. Passthrough, power saver, and sponsor remain preview. Two consecutive
paired releases must pass before stable promotion. Existing externally-started
Proxies may adopt the client without the manager. No migration changes a data
plane silently.

## Consequences

### Positive

- Local routing is usable without claiming full Meta LLM parity.
- Plane, payer, consent, and workload policy become inspectable result data.
- Strict POST retry avoids duplicate work while idempotency forwarding is absent.

### Negative and quantified trade-offs

- Managed users configure a manager and a client, adding one explicit readiness
  handoff but avoiding constructor side effects.
- One authenticated status request is required per readiness handoff; capability
  caching limits further probes to one per five-minute window.
- No automatic POST retry reduces apparent resilience but bounds duplicate-spend
  risk.
- The routing matrix contains 4 planes by 3 policies plus consent and
  availability variants; at least 48 core scenarios are required before stable.
- Planning estimate is 5 to 8 engineering days per language for HTTP facade,
  streams, plane evidence, and consent checks.

### Biggest failure mode and mitigation

The biggest failure is silent plane change: locally expected content leaves the
machine or changes payer through defaults, retry, or route drift. Explicit
intent, no SDK router, authenticated receipts, consent-bound transitions, no
unsafe POST retry, and a complete routing matrix mitigate it.

## Alternatives considered

| Option | Benefit | Rejected because |
|--------|---------|------------------|
| Point `MetaLlmClient` at loopback | One API | Unsupported routes and distinct trust semantics |
| Let SDK choose the plane | Central policy | Duplicates routing without live consent/usage state |
| Retry Proxy POSTs | Availability | Idempotency is dropped and spend can duplicate |
| Infer plane from model/status | No server change | Configured state is not per-request evidence |
| Ordinary remote base URL | Flexible deployment | Local bearer and current CORS are not remote security |

## Compliance and verification

CI MUST prove:

1. construction performs zero I/O and browser use fails before I/O;
2. ambient proxy poisoning never observes bearer or body;
3. raw bearer and capability are not interchangeable;
4. unsupported Meta LLM methods fail locally;
5. every plane, policy, consent, and availability combination matches contract;
6. `critical` never automatically selects cloud, passthrough, or sponsor;
7. protected headers are forwarded or rejected before content transmission;
8. streams preserve native terminal state, usage, and plane under fragmentation;
9. sponsor streaming rejects and no POST automatically retries;
10. budget, rate limit, local backend, auth, and process errors stay distinct;
11. secret and prompt canaries never enter diagnostics or telemetry;
12. exact Proxy version and capability evidence appear in canonical results.

### Executable acceptance test

```text
cd sdks/node   && npm test -- meta-proxy-client-conformance
cd sdks/python && pytest -m meta_proxy_client_conformance
cd sdks/rust   && cargo test --features meta-proxy,native-tls meta_proxy_client_conformance
```

Each command runs the same hostile loopback Proxy plus local and cloud backends,
captures all requests, and compares canonical results. Stable promotion also
runs the real Proxy with mock providers and proves explicit local/cloud routing,
critical fail-closed behavior, receipt preservation, stream cancellation, and
zero real provider spend.

**Current status (issue #94):** this is the target acceptance gate for §D11
stable promotion, not a suite that exists yet — none of §D1-D10's smaller
feature slices landed so far (see the "Updated" line above) attempt to
satisfy compliance items 1-12 end-to-end. `sdks/rust/tests/meta_proxy_client_conformance.rs`
carries one real, passing, intentionally-minimal placeholder test under this
exact name (construction-is-zero-I/O only, compliance item 1) so the Rust
command above no longer silently matches zero tests (`cargo test <filter>`
exits 0 on an empty match, which previously made the documented command a
false-green no-op). The Node/Python commands remain aspirational — no test
tagged/named `meta-proxy-client-conformance` / `meta_proxy_client_conformance`
exists in those SDKs yet; wiring those up is deferred to the same pass that
builds out the real cross-language conformance suite.

The Rust command additionally pins `native-tls` (not just `meta-proxy`):
`cargo build --features meta-proxy` (no `native-tls`) is exercised standalone
by CI's `rust-feature-matrix` job (`.github/workflows/ci.yml`), but that job
deliberately runs `cargo build` there, never `cargo test` — with only the
rustls-only default backend enabled, reqwest defers PEM validation to first
use, which makes the pre-existing, already-tracked `seed` client test
`builder_trust_root_pem_round_trips` fail (see the matrix job's inline
comment). That failure is unrelated to Meta Proxy; the fix is to always pair
`meta-proxy` with `native-tls` when running `cargo test` locally or in CI,
exactly as the primary `rust` CI job already does
(`cargo test --features "native-tls,seed,stream,blocking,mdns,meta-llm,meta-proxy,metaharness,harnessaas"`).

## References

- ADR-0019: agentic platform bounded contexts and SDK topology
- ADR-0020: agentic contract source of truth and code generation
- ADR-0021: agentic service configuration, transports, and capabilities
- ADR-0022: agentic authentication, tenant, budget, secret, and consent isolation
- ADR-0023: agentic errors, retries, idempotency, cancellation, and time budgets
- ADR-0024a: Meta LLM serving protocols and streaming
- ADR-0024b: Meta LLM platform resources, routing, and usage
- ADR-0025b: Meta Proxy lifecycle, integrity, and GA gates
- ADR-0026a: OSS MetaHarness identity, structured bridge, and public SDK API
- ADR-0026b: MetaHarness process, filesystem, and npm/npx supply chain
- ADR-0028: agentic telemetry, usage, cost receipts, lineage, and redaction
- ADR-0029: language packaging, features, and CLI boundaries
- ADR-0030a: conformance, CI, and release evidence
- ADR-0030b: migration, rollout, and publication
