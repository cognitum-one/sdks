# ADR 0024a: Meta LLM Serving Protocols and Streaming

- **Status:** Proposed
- **Date:** 2026-07-18
- **Deciders:** Cognitum SDK Working Group, Meta LLM owner, Identity, FinOps, Security, SRE, Developer Experience
- **Scope:** Meta LLM serving SDK integration (`sdks/node`, `sdks/python`, `sdks/rust`)

## Context

ADR-0019 makes Meta LLM a remote bounded context with its own client. It is not
the remote half of Meta Proxy, and Meta Proxy is not an interchangeable Meta LLM
base URL. ADRs 0020 through 0023 define the shared contract, transport,
credential, error, retry, cancellation, and time-budget rules. ADR-0024b defines
Meta LLM routing, usage, and platform resources. This ADR owns serving wire
protocols, streaming, errors, idempotency, and direct-client lifecycle.

The audit baseline is
`cognitum-one/meta-llm@948bd31a67a6daf3cf5888e06be64e732027be13`.
The private implementation package reports version `0.0.1`
(`package.json:3`). Its serving routes are registered at
`src/server.ts:72-78,119`:

| Surface | Current routes |
|---------|----------------|
| Discovery | `GET /v1/models`, `GET /v1/whoami`, four health aliases |
| OpenAI style | `POST /v1/chat/completions`, `POST /v1/completions`, `POST /v1/responses`, `POST /v1/embeddings` |
| Anthropic style | `POST /v1/messages`, `POST /v1/messages/count_tokens` |

These routes are compatible with selected OpenAI and Anthropic shapes, not all
features of either vendor. Chat currently accepts at most 512 messages, 128 KiB
per message, and `n = 1`. Messages and Responses add an approximately
eight-million-character aggregate prompt guard. Anthropic image and document
blocks are rejected. Responses accepts `previous_response_id` but does not
restore conversation state. `/v1/models` does not advertise every alias the
resolver accepts.

Streaming is protocol-specific. Chat and legacy completions use OpenAI `data:`
frames and `[DONE]`; Messages emits native Anthropic events; Responses emits
native Responses events. Their errors also have three different envelopes.
Flattening these protocols would erase ordering, tool-call, usage, partial
billing, and terminal-state semantics.

There is no current service-owned OpenAPI 3.1 contract. ADR-203 called for one,
but repository search finds only the plan. TypeScript interfaces and route
validators are as-built evidence, not the GA language-neutral contract required
by ADR-0020.

## Decision

Add a dedicated `MetaLlmClient` with protocol-specific serving facades. Preserve
native protocol semantics while sharing transport, request context, credential,
cancellation, and error primitives. All current operations enter preview until
the upstream GA gates in this ADR pass.

### D1. Construction and deployment ownership

```text
MetaLlmClientConfig {
  base_url,
  credential_provider,
  transport,
  default_request_context,
  default_routing_controls,
  default_safety_control,
  budget_policy,
  capabilities_snapshot,
  telemetry
}
```

Construction performs no I/O. A production URL becomes a default only after it
is published in the contract bundle. Custom deployments require explicit HTTPS
origins and origin-bound credentials under ADR-0022.

The SDK does not deploy, configure, restart, or scale Meta LLM. `close` or
`aclose` closes local connections and waits only; it does not cancel a remote
operation, stop a pod, release a reservation, or revoke a credential.

Health, identity, readiness, and capabilities are distinct:

```text
health()        process-level response only
whoami()        authenticated account and credential type
capabilities()  versioned behavior safe for this caller
ready(feature)  dependency readiness for a named feature, when published
```

The four current health aliases map to one SDK operation. The contract selects
one canonical route and marks the others server compatibility aliases.

### D2. Serving topology and maturity

```text
client.health
client.models
client.whoami
client.chat.completions
client.completions
client.messages
client.responses
client.embeddings
```

Target maturity after contract publication is:

| Group | Target | Conditions |
|-------|--------|------------|
| Health, models, whoami | Stable | Canonical route, auth, schema, limits and capability version published |
| Chat, legacy completions, Messages, count tokens, Responses | Stable | All stream grammars, errors, receipts and idempotency pass conformance |
| Embeddings | Stable | Input limits, dimensions, usage, errors and auth published |

Before the first accepted bundle, all require the explicit preview option or
Rust preview feature. Source registration alone never establishes stability.

### D3. Protocol-specific wire types and validation

The SDK does not invent a universal prompt object:

```text
ChatCompletionRequest / ChatCompletion
LegacyCompletionRequest / LegacyCompletion
AnthropicMessageRequest / AnthropicMessage
CountTokensRequest / CountTokensResult
ResponsesRequest / ResponsesResponse
EmbeddingRequest / EmbeddingResponse
```

Content blocks, tools, tool choices, finish reasons and usage remain in native
namespaces. Convenience builders may convert plain text and basic tools, but
conversion is explicit and fails when semantics would be lost.

The facade performs cheap deterministic validation before acquiring a
credential: required fields, collection count, string size, `n = 1`, unsupported
block and impossible routing bounds. Server validation remains authoritative,
and its request ID and native error are preserved.

Responses documents current stateless behavior: callers resend conversation
input. Until the server contracts stored state, `previous_response_id` is
preview and MUST NOT be described as recovery.

Routing controls use the product-specific types in ADR-0024b. A body field wins
over the corresponding `X-Cognitum-*` header in the audited server. The SDK emits
one canonical representation and rejects conflicting generic overrides.

### D4. Result and metadata envelope

```text
MetaLlmResult<T> {
  data: T,
  meta: MetaLlmResponseMeta
}

MetaLlmResponseMeta {
  request_id,
  protocol_version,
  http_status,
  retry_after,
  idempotent_replay,
  receipt: MetaLlmReceipt?,
  warnings,
  unknown_headers
}
```

`MetaLlmReceipt` is defined in ADR-0024b. A text-only convenience method MAY
exist, but the full result remains available without another request. Missing
metadata remains missing; the SDK does not derive verified cost or routing from
model text or token estimates.

When body and headers duplicate receipt fields, the SDK checks equality. A
mismatch in routing, tenant, safety, usage, billing, replay, or other
security-significant metadata returns `ProtocolError`, invalidates cached
capabilities, and emits content-free drift telemetry under ADR-0028. A mismatch
in an explicitly non-authoritative diagnostic field may remain a warning.

### D5. Streaming contract

Every streaming facade exposes:

1. a lossless typed event stream;
2. an optional text/tool accumulator over that stream.

```text
MetaLlmStreamEnvelope<E> {
  event: E,
  sequence,
  received_at,
  request_id,
  raw_event_name?,
  unknown_fields
}
```

OpenAI events preserve role, content delta, tool-call fragments, finish reason,
trailing usage, Cognitum receipt, terminal error, and `[DONE]`. Anthropic events
preserve message start, content-block start/delta/stop, message delta, message
stop, ping, and error. Responses events preserve their native discriminator,
output-item identity, deltas, completed response, and failure. Unknown valid
events become `UnknownStreamEvent`.

SSE parsing handles arbitrary byte fragmentation, CRLF and LF, comments,
multiple `data:` lines, split UTF-8, bounded unknown events, and close without a
terminal event. Parser size, depth, idle, and total time limits follow ADR-0023
and the contract bundle.

A stream succeeds only after its native terminal event. Close, cancellation,
timeout, or parse failure before that point returns partial state plus a typed
terminal error. Partial output may have incurred spend. The SDK neither labels
it rolled back nor synthesizes a terminal event.

No retry occurs after any response byte. Before the first byte, retry requires
ADR-0023 replay proof. Cancellation stops local reading and requests transport
cancellation; it does not claim provider generation or billing stopped.

### D6. Error mapping

```text
MetaLlmError {
  category,
  protocol: generic | openai | anthropic | responses,
  status,
  code,
  type,
  message,
  request_id,
  retry_after,
  partial,
  receipt,
  raw_redacted_body,
  unknown_fields
}
```

The facade normalizes categories without discarding native envelopes:

| Status | Category | Automatic retry |
|--------|----------|-----------------|
| 400 | Invalid request | Never |
| 401 | Authentication | At most one refresh after a verified challenge |
| 403 | Permission | Never |
| 404 | Resource or model not found | Never |
| 409 | State conflict or idempotency mismatch | Never |
| 402 | Budget or upgrade required | Never |
| 422 | Safety or semantic validation | Never |
| 429 | Rate limited | Honor bounded `Retry-After` only when replay-safe |
| 502, 503 | Upstream or dependency | Bounded retry only when replay-safe |

Error text is not parsed to discover hidden provider identity or alter retry.
Raw bodies are bounded and recursively redacted before caller hooks.

### D7. Idempotency and retry

The SDK generates a UUID idempotency key only for a direct nonstream call whose
accepted contract declares safe replay. It binds a caller key locally to
operation, normalized path, principal, tenant and delegated subtenant context,
contract major, and canonical request hash.

The current server stores successful nonstream results for 24 hours but keys
only by API-key hash and caller key. The shared store spans chat, completions,
Messages, and Responses without method, path, or body binding. Streams look up
records but do not store a completed stream. One reused key can therefore replay
the wrong protocol response.

The required identity is:

```text
IdempotencyBindingV1 {
  authenticated_principal,
  tenant_context,
  delegated_subtenant_context,
  http_method,
  normalized_route_identity,
  canonical_request_sha256,
  idempotency_key,
  contract_major
}
```

This is the exact ADR-0023 type and canonicalization algorithm, not a Meta
LLM-specific approximation.

A changed identity returns `409 idempotency_mismatch`. The SDK never hides a
mismatch with a new key because the caller may be reconciling uncertain spend.
GET reads use bounded ADR-0023 retry. Platform mutations follow ADR-0024b and
remain nonretrying until durable idempotency is published.

### D8. Authentication and tenant behavior

The compatibility table records current behavior:

- `cog_` API keys use preferred `X-API-Key` or bearer placement;
- Cognitum OAuth access tokens can authenticate completion-family routes and
  usage when the verifier is enabled;
- OAuth `inference` maps only to completion scopes;
- many platform routes require API keys directly;
- administrative revocation may lag by the current 45-second auth-cache TTL.

The SDK sends exactly one contracted placement, preflights known scopes, and
does not assume OAuth platform access. Account identity comes from the
credential. Foreign resources remain indistinguishable from absent resources.

`sub_tenant_id` is an opaque attribution label, not an account, budget, or
authorization override. Its product-specific type is `SubTenantAttribution`.

### D9. Serving GA gates

No serving operation becomes stable until applicable gates pass:

1. Publish the ADR-0020 OpenAPI 3.1 and JSON Schema bundle at an immutable
   release revision.
2. Publish exact OpenAI, Anthropic, and Responses SSE grammars, native error
   envelopes, limits, and golden fixtures.
3. Add authenticated capabilities with product and contract versions, maturity,
   auth methods, scopes, limits, and limitations.
4. Implement ADR-0023 `IdempotencyBindingV1` exactly, including principal,
   tenant/delegated subtenant, method, normalized route, canonical request hash,
   caller key, and contract major, with atomic replay and deterministic mismatch
   error.
5. Define streaming replay as unsupported or publish a durable resumable
   contract; lookup alone is not stream idempotency.
6. Reconcile `/v1/models` with accepted public aliases and identify internal
   aliases explicitly.
7. Contract `previous_response_id` as stateless or implement stored state.
8. Publish OAuth versus API-key support per operation.
9. Return protocol and request identifiers consistently on success, error, and
   terminal stream paths.
10. Pass partial-stream billing and terminal-error fixtures with a mock provider.

### D10. Migration

Migration is additive and does not modify the root `Cognitum` client:

1. pin the audited revision and preview compatibility entry;
2. land the ADR-0020 contract and lock;
3. implement metadata, errors, and the three lossless stream parsers;
4. release discovery and nonstream serving as preview;
5. add streams, embeddings, and receipt verification;
6. promote a target-stable group after two consecutive Meta LLM releases pass
   the same cross-language corpus.

Raw OpenAI or Anthropic users migrate one method at a time. The guide maps
native fields without claiming unsupported vendor features. Failure never
automatically reroutes to Meta Proxy.

## Consequences

### Positive

- Native protocol behavior survives while Cognitum request and receipt metadata
  remains available.
- Node, Python, and Rust share one semantic fixture corpus.
- Partial streams and retries no longer imply false success or no charge.

### Negative and quantified trade-offs

- Three stream parsers require at least 12 success, 12 terminal-error, and 12
  arbitrary-fragmentation fixtures per language.
- Full metadata retains an estimated 1 to 3 KiB more per response than text-only
  APIs; callers may discard it after reconciliation.
- Capability discovery adds at most one authenticated request per origin and
  credential identity per five-minute cache window.
- Planning estimate is 10 to 15 engineering days for shared contracts and
  fixtures plus 6 to 10 days per language facade.
- Two passing upstream releases delay stable promotion by at least one release
  interval in exchange for drift evidence.

### Biggest failure mode and mitigation

The biggest failure is treating a partial or incorrectly replayed response as a
successful, unbilled, compatible result. It can double-charge, replay Messages
into Responses, lose tools, or hide safety and budget outcomes. Native streams,
receipt preservation, no retry after bytes, request-bound idempotency, and GA
gates mitigate it.

## Alternatives considered

| Option | Benefit | Rejected because |
|--------|---------|------------------|
| Official vendor client with changed base URL | Fast | Drops Cognitum controls, metadata, errors, and compatibility limits |
| Universal prompt and stream type | Small API | Erases content, tools, ordering, usage, and terminal semantics |
| Meta Proxy fallback | Apparent resilience | Violates product, consent, and lifecycle boundaries |
| Retry every inference failure | Availability | Can duplicate spend or replay the wrong protocol |
| Mark registered routes stable | Broad launch | Source presence is not a contract |

## Compliance and verification

CI MUST prove:

1. constructors and builders perform zero I/O;
2. each operation sends only declared auth and minimum scope;
3. generic headers cannot conflict with typed controls;
4. native success and error fixtures preserve request ID, unknown data, receipt,
   and retry metadata;
5. all stream parsers survive every byte and UTF-8 split, keepalive, unknown
   event, terminal error, and missing terminal;
6. cancellation after one byte performs no retry and returns partial state;
7. nonstream replay reuses its key and changed identity returns `409`;
8. `402`, `429`, cache hit, output safety block, and partial stream remain
   distinct accounting cases;
9. secret canaries never enter logs, traces, metrics, errors, or snapshots;
10. generated models regenerate offline with an empty diff.

### Executable acceptance test

```text
cd sdks/node   && npm test -- meta-llm-serving-conformance
cd sdks/python && pytest -m meta_llm_serving_conformance
cd sdks/rust   && cargo test --features meta-llm meta_llm_serving_conformance
```

Each command runs the same hostile local JSON and SSE fixtures, records every
request, and emits canonical results. The parity comparator fails on semantic
differences. Stable promotion also runs the real Meta LLM server with a mock
provider and proves one operation and charge per valid replay, mismatch
rejection, correct partial metering, and zero real spend.

## References

- ADR-0019: agentic platform bounded contexts and SDK topology
- ADR-0020: agentic contract source of truth and code generation
- ADR-0021: agentic service configuration, transports, and capabilities
- ADR-0022: agentic authentication, tenant, budget, secret, and consent isolation
- ADR-0023: agentic errors, retries, idempotency, cancellation, and time budgets
- ADR-0024b: Meta LLM platform resources, routing, and usage
- ADR-0025a: Meta Proxy client, routing, and consent
- ADR-0028: agentic telemetry, usage, cost receipts, lineage, and redaction
- ADR-0029: language packaging, features, and CLI boundaries
- ADR-0030a: conformance, CI, and release evidence
- ADR-0030b: migration, rollout, and publication
