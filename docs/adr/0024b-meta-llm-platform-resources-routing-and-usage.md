# ADR 0024b: Meta LLM Platform Resources, Routing, and Usage

- **Status:** Proposed
- **Date:** 2026-07-18
- **Deciders:** Cognitum SDK Working Group, Meta LLM owner, Identity, FinOps, Security, SRE, Developer Experience
- **Scope:** Meta LLM platform SDK integration (`sdks/node`, `sdks/python`, `sdks/rust`)

## Context

ADR-0024a defines the direct Meta LLM serving protocols. This companion ADR
owns Cognitum routing, usage, safety, asynchronous inference, pods, callbacks,
webhooks, and governance resources. The bounded-context, contract, transport,
auth, retry, and telemetry rules come from ADRs 0019 through 0023 and ADR-0028.

The audit baseline is
`cognitum-one/meta-llm@948bd31a67a6daf3cf5888e06be64e732027be13`.
Beyond serving, `src/server.ts:79-122` currently registers:

| Group | Routes |
|-------|--------|
| Batches | create, retrieve, output |
| Pods | spawn, domains, retrieve, run, approve, conformance |
| Evaluation | bench evaluate |
| Accounting | usage |
| Guidance and collaboration | guidance, proposal approval, threads, community, stream |
| Evolution | evolve, learn, lineage, flywheel status, MicroLoRA, training-data deletion |
| Notifications | public key, webhook register/list/deliveries/delete |
| Governance and storage | flywheel gate, genome, brain, embeddings, vectors, conditional hosts |

The service performs difficulty routing, tier-scope enforcement, worst-case
budget reservation, response caching, safety scanning, fallback, metering, and
post-generation escalation. Its `x_cognitum` object and response headers are
routing and accounting evidence, not optional diagnostics. Account identity
comes from the credential. `sub_tenant_id` is only sanitized attribution
metadata and cannot select an account, budget, rate limit, or resource owner.

The platform surface is implementation-rich but contract-poor. Batch and pod
mutations lack general idempotency. Public webhook documentation claims durable
retry behavior that production wiring does not use. Pod callbacks and public
webhooks use different signature algorithms. These facts require deliberately
smaller stable groups than the route count suggests.

## Decision

Expose routing, usage, and platform resources through the same direct
`MetaLlmClient` as ADR-0024a, but keep them product-specific and maturity-gated.
Do not send them to Meta Proxy and do not normalize their evidence into generic
model responses.

### D1. Public topology and maturity

```text
client.usage

client.preview.batches
client.preview.pods
client.preview.bench
client.preview.guidance
client.preview.collaboration
client.preview.evolution
client.preview.micro_lora
client.preview.webhooks
client.preview.flywheel
client.preview.genome
client.preview.brain
client.preview.vectors
client.preview.hosts
```

| Group | Target maturity | Conditions |
|-------|-----------------|------------|
| Usage | Stable read-only | Query bounds, grouping, budget semantics, auth, and fixtures published |
| Batches | Preview | Create idempotency and cancellation are not registered |
| Pods, approval, conformance, bench | Preview | Mutations, callbacks, signed evidence, and replay rules remain evolving |
| Webhooks | Preview | Retry durability, key rotation, and canonicalization version are unresolved |
| All remaining governance groups | Preview | Stability, scopes, limits, and neutral schemas are unpublished |

Before the first accepted ADR-0020 contract bundle, every group remains
preview. Conditional or internal routes absent from the manifest have no public
binding.

### D2. Routing types and precedence

Routing is a Meta LLM product type:

```text
ModelTier = low | mid | high
ModelSelector = auto | tier(ModelTier) | contract_declared_alias(String)
FallbackPolicy = fail_fast | best_effort
EscalationStrategy = stream_oneshot | post_hoc | buffered | inflight
CacheMode = disabled | exact | semantic
SafetyMode = block | warn | redact

MetaLlmRoutingControls {
  model,
  min_tier,
  max_tier,
  fallback_policy,
  escalation,
  cache,
  safety,
  sub_tenant_id
}
```

Unknown received values are preserved, but stable methods cannot send them
until capabilities declare support. Raw provider model IDs are not an escape
hatch. The audited resolver rejects them as `model_not_found`.

Body controls win over `X-Cognitum-*` headers. The SDK emits one representation
and forbids generic overrides of routing, safety, auth, request ID, idempotency,
trace, host, or content-length fields.

Auto routing computes difficulty within tier bounds and held scopes. Explicit
tier aliases require the matching scope. `fail_fast` rejects unavailable
capability; `best_effort` may cap and mark degradation. The SDK never changes
these choices during retry.

`SubTenantAttribution` is opaque and sanitized. It is included in operation and
idempotency metadata where contracted, but never treated as tenant authority.

### D3. Receipt, usage, and money types

```text
MetaLlmReceipt {
  request_id,
  resolved_tier,
  resolved_model,
  escalated,
  cap_degraded,
  routing_reason,
  price: Money?,
  cache_result,
  cache_savings: Money?,
  prompt_cache_savings: Money?,
  fallback_used,
  breaker_counts,
  sub_tenant_id,
  safety_summary,
  usage,
  costs: List<CostObservation>
}

UsageSummary {
  totals,
  tier_mix,
  escalation_rate,
  cache,
  fallback_rate,
  empty_billed_rate,
  by_model?,
  by_provider?,
  by_period?,
  budget
}

BudgetView {
  serving,
  hard_limit: Money?,
  committed: Money?,
  reserved: Money?,
  headroom: Money?,
  status,
  resets_at?
}
```

Wire fields such as current USD price values decode into ADR-0028 decimal
`Money`; they never enter the public domain model as binary floating point. The
contract labels fields authoritative, estimated, optional, and
telemetry-safe. Provider usage, estimate, reservation, committed cost, and
invoice amount remain distinct. Missing cost is not reconstructed from tokens.
Body/header overlap is checked as specified by ADR-0024a.

Usage is strictly authenticated-account scoped. Queries use the contract's
bounded `YYYY-MM` range and optional model, provider, or period grouping. An
empty result is not reinterpreted as global unattributed usage. OAuth/API-key
route parity must come from capabilities.

### D4. Budget, cache, and safety

The server reserves a ceiling-tier worst-case estimate before provider work,
then commits actual spend or releases a failed reservation. Account, agent, pod,
and step limits are independent. Client `BudgetPolicy` from ADR-0022 is an
additional guard, never accounting authority.

The SDK never raises tier, enables escalation, changes cache, selects best
effort, or changes payer during retry. `402` remains budget or upgrade failure;
plan degradation and reset information are preserved.

Safety is typed and capability/scope checked. Input block may occur before
provider work. Output block occurs after provider spend and metering, so a
content-free safety error may carry committed cost. Warn and redact expose only
contract-safe detector classes and counts. Prompts, matches, secrets, and
unredacted content are excluded from ordinary logs and telemetry.

Count-tokens is a server-side local estimate without provider reservation or
metering in the audited implementation. It returns `estimated_tokens`, not
billed usage.

### D5. Batch operations

Preview batches expose:

```text
BatchHandle { id, endpoint, status, counts, timestamps, sub_tenant_id? }
BatchStatus = validating | in_progress | completed | failed | expired
BatchItemStatus = queued | completed | failed
BatchOutputItem { custom_id, response?, error? }
```

Create accepts a contract envelope and unique `custom_id` values up to 256
characters. The ergonomic facade omits accepted-but-ignored `method` and `url`.
Streaming and `n != 1` fail locally. Submission returns an operation handle; a
terminal `completed` batch may still contain failed items.

The server reserves a discounted worst-case envelope. Create has no general
idempotency and is never automatically retried. Retrieve and output are
retryable reads. The poller uses caller deadline, bounded jitter, and terminal
states from ADR-0023. It does not invent cancellation because no cancel route is
registered.

### D6. Pods, approval, conformance, and bench

```text
PodState = spawned | executing | evaluating | escalating | idle | paused | awaiting_approval
PodRunResult = SynchronousPodRun | AcceptedPodRun
ApprovalVerdict = approve | reject
```

Spawn includes name, domain, host, template, cron, per-agent cap, shards, bench
configuration, room, approval policy, and optional run-now. Server clamps caps,
steps, and shards; the response reports effective values.

Run returns `200` synchronous or `202` accepted. Busy, paused, or
awaiting-approval conflicts remain typed `409` states. Approval preserves
reservation disposition and step cost. Conformance preserves signed Ed25519 QE
evidence, witness identity, replay/no-op disposition, and fail-closed witness
errors.

Spawn, run, approve, and conformance have no general replay guarantee and are
not retried automatically. Foreign pod IDs remain indistinguishable from
absent IDs. Bench results never become verified conformance unless the signed
evidence checks defined in ADR-0028 pass.

### D7. Pod callbacks and public webhooks

These are deliberately separate verifier modules:

| Contract | Algorithm | Signed representation | Key discovery |
|----------|-----------|-----------------------|---------------|
| Pod result callback | HMAC SHA256 | Flat scalar projection | Shared key selected by `maas-pod-results-hmac-v1` |
| Public webhook | Ed25519 | Recursively key-sorted JSON | Published SPKI public key |

Pod results contain summary/count telemetry only, stable `event_id`, timestamp,
signature, and signing key ID. The destination is a server-configured HTTPS
allowlisted AgentBBS origin. Network, timeout, and 5xx can retry; 4xx cannot;
redirects are rejected. SDK verification uses exact signed fields and event-ID
deduplication.

Public webhook events currently include flywheel generation promoted,
milestone, gate decision, evolve completion, and MicroLoRA completion.
Registration requires HTTPS SSRF controls and a maximum of 20 hooks per
account. Delivery verification checks signature, known canonicalization/key,
timestamp skew, and delivery-ID replay.

Production currently constructs public webhook delivery without the defined
retry policy, so it makes one attempt. The default policy's waits total 15
seconds, not the documented approximately 15 minutes. `deliveries` returns
dead-letter records, not every attempt. The SDK models those facts until the
server contract changes.

### D8. Remaining governance resources

Guidance, collaboration, evolution, MicroLoRA, flywheel, genome, brain, vectors,
and conditional hosts remain separate preview namespaces. Each operation needs
its own schema, scope, tenant rule, idempotency, limits, evidence level, and
terminal behavior before binding.

No generic `invoke(path, body)` escape hatch is added. Collaboration SSE uses
its own event contract and cannot reuse inference SSE solely because both use
`text/event-stream`. Brain replacement, promotion, rollback, vector mutation,
training-data deletion, and proposal approval are nonretrying mutations until
durable idempotency exists.

### D9. Observability and privacy

ADR-0028 owns shared telemetry. Meta LLM adds safe operation, protocol, request
ID, tier, resolved alias, escalation, cache, fallback, degradation, token count,
categorized cost, retry, operation state, and evidence-level attributes.

Prompt, output, tool arguments, safety matches, provider credentials, webhook
bodies, pod summaries not marked safe, and tenant content are excluded. W3C
trace context uses contract-approved headers. Receipt mismatch is a drift
metric, not permission to log raw payloads.

### D10. Platform GA gates

1. Publish all platform operations, scopes, tenant rules, maturity, limits,
   errors, idempotency, and schemas in the ADR-0020 bundle.
2. Add durable idempotency before any automatic retry of batch and pod
   mutations.
3. Publish usage, reservation, commit, cache, partial billing, and output-block
   reconciliation fixtures.
4. Reconcile OAuth and API-key support per resource.
5. Version public-webhook canonicalization and keys; publish current and previous
   verification keys.
6. Reconcile webhook delivery guarantee, retry timing, dead-letter retention,
   and telemetry endpoint semantics.
7. Publish pod callback signed-field schema, key rotation, timestamp, and replay
   requirements.
8. Publish capability and stability contracts for each remaining governance
   group; source registration is insufficient.
9. Make conditional hosts discoverable through capabilities and fail closed
   when disabled.
10. Prove tenant isolation and foreign/absent `404` parity for every resource.

### D11. Migration

1. Release routing receipt and usage read-only support after ADR-0024a serving.
2. Add batches and pods as separate preview groups with no mutation retry.
3. Add verifier helpers before webhook or conformance convenience APIs.
4. Add each governance namespace only with its pinned schema and negative
   fixtures.
5. Promote usage only after two consecutive releases reconcile mock-provider
   ledger, reservation, and receipt totals.

No platform method is sent through Meta Proxy. Existing users may adopt usage
and routing metadata without enabling preview governance resources.

## Consequences

### Positive

- Routing and cost evidence becomes first-class without flattening governance
  resources into inference.
- Preview boundaries permit incremental delivery while protecting stable APIs.
- Separate signature helpers prevent false verification across callback types.

### Negative and quantified trade-offs

- The route inventory produces more than ten preview resource groups rather
  than one generic platform client.
- Each stable operation needs at least one success, auth, validation,
  capability-missing, unknown-field, redaction, and idempotency fixture where
  applicable, as required by ADR-0030a.
- A poller retains one operation handle and performs bounded GETs; at a five
  second interval, a 24-hour batch can make up to 17,280 reads, so defaults must
  back off and honor server hints.
- Planning estimate for batches, pods, usage, callbacks, and verifier facades is
  8 to 12 shared engineering days plus 4 to 7 days per language. Other
  governance groups are estimated individually.

### Biggest failure mode and mitigation

The largest failure is treating routing, cost, approval, or signature-shaped
data as verified authority when it is merely estimated, preview, or from the
wrong contract. Product-specific types, evidence levels, distinct verifiers,
server-authoritative accounting, and maturity gates mitigate it.

## Alternatives considered

| Option | Benefit | Rejected because |
|--------|---------|------------------|
| One generic platform resource | Small surface | Erases scopes, state, evidence, and retry semantics |
| Mark all registered routes stable | Broad coverage | No neutral stability contract exists |
| Share webhook verifier with pods | Less code | Algorithms and signed representations differ |
| Poll every second | Fast completion detection | Creates avoidable load and ignores long-running behavior |
| Client-side accounting authority | Immediate totals | Cannot know provider, reservation, partial stream, or invoice truth |

## Compliance and verification

CI MUST prove:

1. routing body/header precedence and receipt parity;
2. subtenant attribution cannot alter tenant, budget, rate limit, or ownership;
3. usage queries remain account scoped and reconcile receipt totals;
4. retries never change tier, payer, cache, safety, escalation, or consent;
5. batch partial success, terminal state, duplicate ID, and no-create-retry;
6. pod synchronous/accepted runs, conflicts, approval disposition, signed
   conformance, replay, and foreign-resource isolation;
7. callback HMAC and webhook Ed25519 cannot cross-verify;
8. webhook SSRF, timestamp, replay, key rotation, dead-letter, and retry fixtures;
9. every unknown preview capability blocks before spend or mutation;
10. all content and secret canaries are absent from telemetry and diagnostics.

### Executable acceptance test

```text
cd sdks/node   && npm test -- meta-llm-platform-conformance
cd sdks/python && pytest -m meta_llm_platform_conformance
cd sdks/rust   && cargo test --features meta-llm meta_llm_platform_conformance
```

The same local fixtures exercise routing, ledger reconciliation, batches, pods,
callbacks, webhooks, and capability-negative governance calls. Canonical result
comparison must match across languages. Stable promotion runs the real server
with Firestore fakes and a mock provider, proving zero cross-tenant disclosure,
one reservation disposition per operation, exact usage reconciliation, and zero
real spend.

## References

- ADR-0019: agentic platform bounded contexts and SDK topology
- ADR-0020: agentic contract source of truth and code generation
- ADR-0021: agentic service configuration, transports, and capabilities
- ADR-0022: agentic authentication, tenant, budget, secret, and consent isolation
- ADR-0023: agentic errors, retries, idempotency, cancellation, and time budgets
- ADR-0024a: Meta LLM serving protocols and streaming
- ADR-0025a: Meta Proxy client, routing, and consent
- ADR-0028: agentic telemetry, usage, cost receipts, lineage, and redaction
- ADR-0029: language packaging, features, and CLI boundaries
- ADR-0030a: conformance, CI, and release evidence
- ADR-0030b: migration, rollout, and publication
