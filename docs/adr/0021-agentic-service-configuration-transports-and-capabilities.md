# ADR 0021: Agentic Service Configuration, Transports, and Capabilities

- **Status:** Proposed
- **Date:** 2026-07-18
- **Deciders:** Cognitum SDK Working Group, product API owners, Security, SRE
- **Scope:** cross-cutting (`sdks/node`, `sdks/python`, `sdks/rust`)

## Context

The existing cloud clients use one base URL and one API key. Their low-level
transports generally return the decoded response body and discard headers. For
example, Node defaults to `https://api.cognitum.one`, injects `X-API-Key`, and
owns a single timeout/retry loop (`sdks/node/src/client.ts:10-17,38-89`). The
root Node facade constructs seven resources over that client
(`sdks/node/src/index.ts:22-48`). Equivalent single-origin assumptions exist in
Python and Rust.

The new products require at least four different transport and lifecycle
profiles:

1. Meta LLM is remote, streamed, billable, and has both inference and governance
   APIs.
2. Meta Proxy is local, authenticated, subsetted, and must bypass outbound proxy
   configuration.
3. MetaHarness is a child process with a protocol handshake, not HTTP.
4. HarnessaaS is remote and includes long-running jobs and large artifacts.

Reusing the existing cloud transport unchanged would lose routing, usage,
protocol, request, trace, retry, and evidence headers. Reusing its credential
configuration could send a production API key to a loopback service or child
process.

## Decision

Define product-scoped configuration and transport interfaces over shared bounded
primitives. Constructors resolve configuration but perform no I/O. Every
product negotiates explicit capabilities before unsupported, billable,
consent-bearing, mutating, or code-executing operations.

### D1. Configuration model

All HTTP product clients accept these common fields:

```text
base_url
credential_provider
connect_timeout
request_timeout
wait_timeout
retry_policy
tls_policy
transport
telemetry_sink
user_agent_suffix
preview_features
```

Fields are product-scoped configuration objects, not additions to the current
root `CognitumConfig`. One config object MUST NOT be accepted by two clients if
doing so could reuse a credential implicitly.

Configuration precedence is:

1. explicit constructor value;
2. product-specific environment variable;
3. contract-declared safe default;
4. a typed configuration error.

There is no fallback from a missing product credential to
`COGNITUM_API_KEY` unless that exact fallback is explicitly declared in the
product contract and enabled by the caller. Environment values are resolved
once at construction. Errors identify the missing setting but never include a
secret value.

### D2. Product-specific origin behavior

| Product | Default | Origin rule |
|---------|---------|-------------|
| Meta LLM | No invented production default; explicit value or `COGNITUM_META_LLM_URL` until the contract publishes one | HTTPS, except explicit loopback development mode |
| HarnessaaS | No invented production default; explicit value or `COGNITUM_HARNESSAAS_URL` until the contract publishes one | HTTPS, except explicit loopback development mode |
| Meta Proxy | `http://127.0.0.1:11435` | Literal loopback only by default; non-loopback requires an explicit dangerous opt-in |
| MetaHarness | Resolved executable, not URL | Exact executable and bridge protocol rules in ADR-0026 |

URL resolution MUST:

- reject embedded usernames and passwords;
- reject fragments;
- preserve an operator-supplied base path;
- join route paths without allowing `..` to escape that base path;
- normalize the origin once and use the normalized value for credential
  binding;
- disable cross-origin redirects;
- limit same-origin redirects to three and strip authorization on any origin
  change;
- reject HTTPS-to-HTTP downgrade redirects.

Meta Proxy transports MUST ignore ambient `HTTP_PROXY`, `HTTPS_PROXY`, and
`ALL_PROXY` settings. A loopback bearer token must never transit an outbound
corporate proxy. Remote transports may honor an explicitly configured proxy,
subject to the credential and TLS policies in ADR-0022.

### D3. HTTP transport boundary

The shared HTTP transport operates on wire requests and returns a complete
envelope:

```text
TransportRequest {
  product, operation, method, url, headers, body,
  request_context, response_mode
}

TransportResponse<T> {
  status, headers, body,
  request_id, correlation_id, protocol_version,
  received_at, elapsed
}
```

`response_mode` is one of bounded JSON, bytes stream, SSE stream, or no body.
The transport does not know product auth scopes, routing policy, consent, or
domain errors. Product middleware performs those decisions and calls the common
bounded parser.

The public domain facade returns ergonomic response objects but MUST preserve
metadata through a `meta` field or an equivalent language-native accessor.
Convenience methods that return only text or a model MAY exist, but the full
response remains available without a second request.

Shared collection primitives are deliberately small:

```text
PageRequest { cursor?: OpaqueCursor, limit?: UInt32 }
Page<T> { items: List<T>, next_cursor?: OpaqueCursor, meta: ResponseMeta }
Sort { field: ContractField, direction: asc | desc }
```

An opaque cursor is never parsed as a URL, logged in full, or reused across
product, origin, principal, tenant, filter, or contract major. Limits are
clamped only when the contract explicitly permits clamping; otherwise an
out-of-range value fails locally. Filters and sortable fields remain typed in
the owning product facade rather than becoming an unvalidated string map.

### D4. Request context

Every operation accepts optional call-level context:

```text
RequestContext {
  request_id,
  correlation_id,
  idempotency_key,
  deadline,
  cancellation,
  trace_context,
  metadata
}
```

The SDK generates a UUIDv4 request ID if absent. It does not generate an
idempotency key unless the facade method explicitly documents automatic safe
generation. User metadata is local telemetry metadata and is not sent over the
wire unless a contract maps a named field. Deadlines use a monotonic clock for
elapsed time and an absolute timestamp only at the transport boundary.

### D5. Capability model

The shared capability type is:

```text
CapabilitySet {
  product,
  product_version,
  protocol,
  protocol_version,
  fetched_at,
  source,
  features: Map<String, Capability>,
  limitations: List<Limitation>,
  auth_methods,
  request_id
}

Capability {
  state: supported | unsupported | preview | degraded | unknown,
  schema_version,
  constraints,
  evidence
}
```

Feature names are namespaced and stable, for example:

```text
meta-llm.responses.streaming
meta-llm.batches.cancel
meta-proxy.sponsored.streaming
meta-proxy.routing.reason
metaharness.scaffold.atomic-create
metaharness.scaffold.exchange-replace
metaharness.scaffold.transactional-replace
metaharness.scaffold.durable-journal
harnessaas.executor.isolation
harnessaas.jobs.events.resume
harnessaas.lineage.signed-anchor
```

Boolean feature bags are insufficient because preview, degraded, constraints,
and evidence affect safe behavior.

The canonical registry is
`specs/agentic/capabilities.registry.json`. Each entry owns a unique feature
name, product, value schema, allowed states, constraint fields, comparison
operators, optional ordered enum, evidence owner, maximum age, and the
operations it gates. The SDK working group owns the registry; the applicable
product and Security owners approve security-sensitive changes. Adding a name
is additive. Reusing, renaming, weakening evidence, or changing comparison
semantics is a contract-major change.

Facade preconditions compile to this closed expression AST:

```text
CapabilityExpr =
  All(List<CapabilityExpr>)
  | Any(List<CapabilityExpr>)
  | Not(CapabilityExpr)
  | StateIn { feature, states }
  | Compare { feature, json_pointer, op: eq | in | gte | lte, value }
  | EvidenceAtLeast { feature, verification_level, max_age }
```

There is no implicit ordering among `supported`, `preview`, `degraded`,
`unsupported`, and `unknown`. A stable operation accepts `supported` only;
preview requires a named caller opt-in; degraded, unsupported, and unknown fail
closed for mutation, execution, spend, consent, or evidence claims. `gte` and
`lte` are legal only for a registry field with an explicit total order, such as
`process < container < microvm`; strings never compare lexically. Evidence
freshness is the lesser of the expression, registry, and contract maximum ages
and is evaluated against a monotonic elapsed clock after validating issued and
expiry timestamps.

### D6. Negotiation and caching

`capabilities()` is explicit and performs I/O unless a caller supplies a valid
snapshot. Clients MUST NOT probe in constructors.

The lookup order is:

1. authenticated runtime capabilities endpoint or bridge handshake;
2. exact product-version entry in the pinned compatibility table;
3. minimum-safe unknown set.

Capabilities may be cached for at most five minutes by default. The authority
cache key binds product, normalized origin or executable digest, protocol major,
authenticated principal, tenant and delegated subtenant, credential audience,
effective scopes and plan, and a credential-provider authority fingerprint.
Raw credentials and bare provider-object identity are not cache keys. If an
authority component is unavailable, the result is confined to that client
instance and cannot enter a shared cache. Credential refresh that changes an
authority component, a protocol error, upgrade response, reload, or changed
server version invalidates the entry. Security-sensitive operations may require
a freshly authenticated set.

Concurrent discovery for one complete authority key is single-flight. Waiters
share the immutable result, not credentials or mutable request context. One
waiter's cancellation does not cancel discovery for other waiters; the shared
request is aborted only after the last waiter leaves.

Callers may inject an offline snapshot for tests and air-gapped deployments. A
snapshot is accepted only if its product, origin binding, protocol major,
expiry, and optional signature validate.

### D7. Preconditions

Every facade method declares its capability expression. Examples:

```text
MetaLlm.responses.stream       requires meta-llm.responses.streaming
MetaProxy.sponsoredChatStream  requires meta-proxy.sponsored.streaming
MetaHarness.scaffold(create)   requires All(durable-journal, atomic-create)
MetaHarness.scaffold(replace)  requires All(durable-journal, transaction.recovery,
                                             exchange-replace)
HarnessAas.submit              requires harnessaas.executor.isolation >= container
```

`transactional-replace` is a separately opted-in preview substitute for
`exchange-replace`; it never satisfies the stable atomic-visibility expression.

The HarnessaaS threshold is a shorthand for ADR-0027b's accepted, fresh,
`supported` container or microVM profile with every required control true; a
process-only or degraded profile never satisfies stable submission.

Read-only, non-billable methods may proceed against an exact pinned static table.
Unknown support blocks:

- spend or resource reservation;
- sponsor/power-saver consent;
- local package or binary installation;
- repository mutation;
- untrusted command execution;
- approval, cancellation, deletion, or training-data contribution;
- signature or lineage claims.

Failure is `UnsupportedCapabilityError` with no request attempt. A caller cannot
override this with a generic `force` boolean. Any preview or dangerous override
is product-specific, named for the risk, and recorded in telemetry.

### D8. Health, readiness, and identity

These concepts remain distinct:

| Probe | Meaning | Credential behavior |
|-------|---------|---------------------|
| `health()` | Process responds | Uses product contract; may be unauthenticated |
| `ready()` | Dependencies required for the intended operation are ready | Authenticated when the product requires it |
| `whoami()` | Credential identity, tenant, and scopes | Always authenticated |
| `capabilities()` | Protocol behavior safe to invoke | Authenticated when capabilities vary by tenant or plan |
| `status()` | Product-specific runtime state | Never treated as proof of identity unless documented |

The SDK MUST NOT infer readiness from a TCP connection or health from a 401.
Meta Proxy status is authenticated and must not be probed without its local
token. A failed probe does not trigger another transport or product.

### D9. Runtime and browser support

Meta LLM and HarnessaaS HTTP clients SHOULD work in Node and supported browsers
when the caller provides a browser-safe credential strategy. Meta Proxy and
MetaHarness are server/desktop-only:

- browser exports MUST throw a build-time or immediate
  `UnsupportedRuntimeError` without attempting loopback requests;
- Node remote-only imports MUST not pull `child_process`, `fs`, or native sidecar
  management code;
- Python imports remain lazy;
- Rust local features remain optional.

Browser SDKs MUST NOT embed a long-lived `cog_` secret. Browser examples use a
short-lived delegated token once the corresponding product contract supports
it.

### D10. Concurrency, resource ownership, and shutdown

Public clients are safe for concurrent independent operations after
construction. Per-call request context, retries, stream parsers, idempotency
keys, and mutable pagination state are never stored in shared facade fields.
Credential and capability refresh use the single-flight rule in D6. Closing is
idempotent and enters a visible `closing` state: new operations fail locally,
in-flight HTTP reads are aborted according to caller cancellation, process
transactions follow their product recovery contract, and concurrent `close`
callers observe the same terminal outcome. No callback or telemetry hook runs
while an internal cache or lifecycle lock is held.

HTTP clients own their connection pools and expose `close`/`aclose` where the
language needs it. Closing a client:

- aborts local in-flight waits according to ADR-0023;
- does not cancel server-owned jobs;
- does not stop Meta Proxy;
- does not kill a MetaHarness process owned by another client;
- never revokes credentials implicitly.

Meta Proxy manager and MetaHarness process ownership are explicit in their
product ADRs.

## Consequences

### Positive

- Credentials, origins, and capabilities are visible and testable per product.
- Full response metadata enables routing, budget, receipt, and trace features
  without breaking public return types later.
- Static snapshots support deterministic tests and air-gapped deployments while
  runtime negotiation protects against drift.
- The remote SDK remains browser-capable and free of local process dependencies.

### Negative and trade-offs

- Response envelopes and product configs add types compared with the existing
  one-body transport.
- Five-minute capability caching can briefly retain degraded support. Critical
  operations can require a fresh set, and runtime protocol errors invalidate it.
- No guessed production URL makes first configuration more verbose until product
  owners publish stable origins.

### Biggest failure mode and mitigation

The biggest failure mode is credential or proprietary data egress through a
reused base URL, redirect, system proxy, or unsupported proxy route. The fix is
origin-bound credentials, separate transports, cross-origin redirect denial,
ambient-proxy bypass for loopback, and capability preconditions before I/O.

## Alternatives considered

| Option | Pros | Cons | Why rejected |
|--------|------|------|--------------|
| Extend current generic `HttpClient` only | Less code | It assumes one origin/key and discards metadata | Cannot express the new trust boundaries |
| Auto-discover every service on construction | Convenient happy path | Constructor I/O, startup latency, accidental auth and spend | Explicit probes are deterministic and reviewable |
| Use Meta Proxy as an HTTP proxy for all traffic | One transport | It is an application subset, not a transparent CONNECT proxy | Would route unsupported governance operations incorrectly |
| Cache capabilities for process lifetime | Fewer probes | Stale after reload/deploy/tenant change | Bounded cache plus invalidation balances safety and latency |
| Make capability checks caller responsibility | Smaller SDK | Security behavior becomes inconsistent | The SDK owns safe preconditions |

## Compliance and verification

Required tests include:

1. configuration precedence and missing-value errors for every product;
2. origin normalization, base-path retention, traversal rejection, and redirect
   credential stripping;
3. proxy-environment poisoning tests proving loopback requests remain direct;
4. response metadata preservation for success, error, JSON, bytes, and SSE;
5. no-I/O construction tests;
6. health/readiness/whoami/capabilities semantic separation;
7. cache partitioning by every authority-key component, freshness, invalidation,
   single-flight behavior, and offline-snapshot validation;
8. required-capability rejection before a fixture records any request;
9. browser bundle checks for remote clients and runtime rejection for local
   clients;
10. concurrent operation, refresh, callback reentrancy, and close races proving
    no deadlock, shared mutable request state, remote-job cancellation, or
    independently-owned process termination.

### Acceptance test

Run two hostile fake origins, a loopback fake proxy, and a fake capability
service. Configure different sentinel credentials for each. Assert each origin
receives only its own credential; an attempted cross-origin redirect receives
none; poisoned proxy environment variables do not observe the loopback token;
constructors perform zero I/O; response IDs and protocol metadata survive the
facade; and a missing executor-isolation capability prevents a HarnessaaS submit
before the fake server records a request.

## References

- ADR-0003: cross-cutting authentication model
- ADR-0005: cross-cutting retry and backoff
- ADR-0019: agentic bounded contexts and SDK topology
- ADR-0020: agentic contract source of truth and code generation
- ADR-0022: agentic authentication, tenant, budget, and consent isolation
- ADR-0023: agentic errors, retries, idempotency, cancellation, and time budgets
- ADR-0029: language packaging, features, and CLI
