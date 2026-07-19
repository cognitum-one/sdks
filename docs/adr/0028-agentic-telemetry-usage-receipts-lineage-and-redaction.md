# ADR 0028: Agentic Telemetry, Usage, Cost Receipts, Lineage, and Redaction

- **Status:** Partially Implemented
- **Date:** 2026-07-18
- **Updated:** 2026-07-19 — §D13 redaction sentinel (`SentinelSecretRedactor`: fixed-format matchers, charset-scoped Shannon-entropy fallback, bounded-depth-8 DFS, cycle detection) is implemented (PR #82). `ExecutionReceipt`/`LineageReference` construction and §D5-D9 verification (shape/digest/cryptographic/anchored ladder, HMAC-SHA256, lineage-chain structural validation) are implemented (PR #84), including a cross-language canonical-JSON golden fixture (`sdks/fixtures/receipt-canonicalization/`) added after independent review found a real camelCase-vs-snake_case cross-SDK signature-verification break. §D1's `TelemetrySink`/`TelemetryEvent` interface (with a functional `NoopTelemetrySink` default) and §D3's `cognitum.*` attribute name constants are now frozen as type-only scaffolding across all three languages (M6 first pass, tracking issue #70): no product client (`meta_llm`/`meta_proxy`/`metaharness`/`harnessaas`) emits through this interface yet, and §D2 trace propagation, §D4's event/metric catalog, and §D10 diagnostic capture remain open — the broader shared telemetry pipeline (structured operation/protocol/tier/cache/escalation attributes flowing through a real observability backend) is not yet built.

## Context

The current SDKs do not expose a logger, tracer, metrics sink, request lifecycle
hook, or OpenTelemetry abstraction. Their transports commonly discard response
headers. That is insufficient for products whose value includes routing,
budgeting, usage, evidence, and conformance.

The reviewed dependency/configuration baselines are
`sdks/node/package.json:2-67`, `sdks/python/pyproject.toml:5-25`, and
`sdks/rust/Cargo.toml:1-73`; none declares an SDK telemetry surface or adapter.

Meta LLM returns an `x_cognitum` response object and related headers describing
the request ID, resolved tier and model, routing reason, escalation,
degradation, cache/fallback behavior, safety summary, and price. It also has a
tenant-scoped usage API. Streams can incur cost even when the client sees a
truncated terminal sequence.

Meta Proxy `/status` can report a selected plane and routing reason, but current
inference responses do not reliably carry that plane and some routes drop
upstream receipt headers. An SDK cannot reconstruct authoritative routing facts
from the configured plane alone.

HarnessaaS currently returns a cost receipt, lineage reference, and conformance
object, but the receipt lacks a schema version, currency/finality, signature,
and meter-source discriminator. Its per-tenant SHA-256 lineage chain has no
signed checkpoint or independently verifiable proof. MetaHarness local witness
verification can report structurally valid but cryptographically unverified
input. A single `verified: true` boolean would overstate all three cases.

Observability can itself become a data-exfiltration channel. Prompts,
completions, source code, patches, tool arguments, environment values, API keys,
and pre-signed artifact URLs must not enter normal logs, traces, or metric labels.

## Decision

Define a dependency-neutral telemetry event interface, common usage and money
types, and explicit evidence-verification levels. Preserve product-native
metadata and provenance; do not upgrade estimates or unsigned chains into
verified receipts. Default observability is content-free and low-cardinality.

### D1. Telemetry API boundary

The core SDK defines a small optional sink rather than taking a required
dependency on one observability vendor:

```text
TelemetrySink {
  emit(TelemetryEvent)
  flush(deadline)
}

TelemetryEvent {
  name,
  timestamp,
  severity,
  trace_context,
  attributes,
  measurements
}
```

Official optional adapters map this interface to OpenTelemetry in each language.
A no-op sink is the default. Sink failures, timeouts, and backpressure MUST NOT
fail or delay the product operation; the SDK counts dropped events and may emit
one content-free diagnostic through a fallback hook.

Caller sinks receive already-redacted events. They do not receive raw requests
or responses through this interface. A separate diagnostic-capture API is
defined in D10.

### D2. Trace propagation

Remote HTTP clients propagate W3C `traceparent` and `tracestate` when enabled and
when allowed by the product contract. They create spans using stable names:

```text
cognitum.meta_llm.<operation>
cognitum.meta_proxy.<operation>
cognitum.metaharness.<operation>
cognitum.harnessaas.<operation>
```

Trace context is generated or joined by the SDK but never used as an
authorization, tenant, idempotency, or evidence identity. Untrusted server or
subprocess trace values are validated before joining. Baggage is off by default
and a product allowlist controls any forwarded keys.

MetaHarness bridge messages carry trace IDs only after the bridge schema defines
them. They are not injected as arbitrary environment variables. HarnessaaS job
polls/events remain child spans of one logical submit trace when the caller
retains the operation handle.

### D3. Safe semantic attributes

Stable attributes use the `cognitum.*` namespace:

| Attribute | Example | Cardinality rule |
|-----------|---------|------------------|
| `cognitum.product` | `meta-llm` | Fixed set |
| `cognitum.operation` | `chat.completions.create` | Contract set |
| `cognitum.protocol` | `openai-chat` | Contract set |
| `cognitum.contract.version` | `1.2` | Low |
| `cognitum.request.id` | Opaque UUID | Trace/log only, never metric label |
| `cognitum.tenant.hash` | Truncated keyed hash | Trace/log only |
| `cognitum.model.alias` | `cognitum-auto` | Public aliases only; raw provider model optional and low-cardinality guarded |
| `cognitum.tier` | `low`, `mid`, `high` | Fixed set |
| `cognitum.routing.plane` | `local`, `cloud`, `passthrough`, `sponsored` | Fixed set; only server/proxy-reported |
| `cognitum.routing.reason` | Contract code | Bounded enum, not free text |
| `cognitum.cache.result` | `hit`, `miss`, `disabled` | Fixed set |
| `cognitum.operation.state` | Job/pod/batch state | Product contract set |
| `cognitum.error.kind` | Common error kind | Fixed set |
| `cognitum.retry.count` | Integer | Measurement |

URLs record a route template, never query values, repository URLs, artifact URLs,
or resource IDs. Error messages are not metric labels. Unknown enums use the
literal `unknown`, with raw values available only in a redacted debug record.

### D4. Telemetry events and metrics

The SDK emits, when a sink is configured:

```text
request.start
request.retry_scheduled
request.end
stream.first_event
stream.end
operation.state_changed
operation.wait_ended
capabilities.loaded
budget.reserved
budget.committed
budget.released
consent.required
process.started
process.ended
artifact.verified
evidence.verified
telemetry.dropped
```

Default metric instruments are:

- request and stream duration histograms;
- request, retry, error, and cancellation counters;
- first-event latency histogram;
- input, output, cache, and safety token counters when server-reported;
- reserved, committed, released, and reconciled cost counters by currency;
- operation state-transition counters;
- process exit and forced-termination counters;
- verification result counters.

Request IDs, tenant IDs, operation IDs, repository names, prompts, URLs, and raw
model IDs MUST NOT be metric dimensions. Money of different currencies is never
summed into one measurement.

### D5. Usage and money types

The common model is:

```text
TokenUsage {
  input_tokens,
  output_tokens,
  cached_input_tokens,
  safety_tokens,
  total_tokens,
  source
}

Money {
  amount_decimal,
  currency
}

CostObservation {
  kind: estimate | reservation | provider_usage | commit | release | invoice,
  amount,
  meter_source,
  finality,
  observed_at,
  ledger_reference
}
```

Money uses decimal strings or arbitrary-precision decimal types, never binary
floating point. Currency is an ISO 4217 code or an explicitly namespaced credit
unit. Unknown currency blocks aggregation but not receipt preservation.

`meter_source` is one of `ledger`, `provider`, `estimated`, `mock`, or
`unknown`. `finality` is `provisional`, `committed`, `reconciled`, `reversed`, or
`unknown`. An SDK never converts `estimated` to `provider` or `reconciled`
because a request succeeded.

### D6. Response metadata and routing receipts

Meta LLM full responses preserve:

- request and correlation IDs;
- selected public model alias, tier, and resolved provider model when policy
  permits disclosure;
- routing reason, tier caps, degradation, fallback, escalation, and breaker
  observations;
- cache and safety summaries;
- token usage and every cost observation;
- idempotent replay and truncation flags;
- protocol and capability versions.

The body `x_cognitum` and response headers are reconciled. If they disagree on a
security- or billing-significant field, the SDK returns the body and metadata as
untrusted with `ProtocolError`; it does not choose the more permissive value.

Meta Proxy response metadata MUST include the selected data plane and routing
reason from the proxy itself. Configured plane is not proof of selected plane.
Until the proxy emits and preserves these fields on every inference route, the
stable SDK marks routing evidence `unknown` and does not claim residency or
sponsor attribution.

### D7. Execution receipt v1

A verifiable common receipt envelope is:

```text
ExecutionReceiptV1 {
  schema: "cognitum.execution-receipt.v1",
  receipt_id,
  product,
  contract_version,
  subject: {request_id, operation_id, tenant_hash},
  started_at,
  completed_at,
  usage,
  costs: [CostObservation],
  outcome,
  artifact_digests,
  lineage_root,
  canonicalization,
  issuer,
  key_id,
  signature
}
```

Required properties:

- canonical bytes and canonicalization version are specified;
- issuer and key ID identify a discoverable, rotatable verification key;
- signature covers all receipt fields except the signature itself;
- receipt subject binds to the operation and tenant without exposing raw tenant
  credentials;
- cost currency, source, and finality are explicit;
- artifact and lineage references are content-addressed;
- mock and estimated receipts are visibly non-final.

Existing Meta LLM `x_cognitum` metadata may be a service-reported response
receipt but is not called cryptographically verified unless it adopts this
envelope. Current HarnessaaS receipts are parsed as `LegacyCostReceipt` in
preview and carry `verification=none` until the v1 fields exist.

### D8. Verification levels

Every artifact, witness, receipt, attestation, webhook, and lineage check returns
a tagged result:

```text
VerificationLevel = none | shape | digest | cryptographic | anchored

VerificationResult {
  level,
  valid,
  algorithm,
  key_id,
  checked_at,
  subject_digest,
  warnings,
  failure
}
```

Levels are ordered only by the guarantees explicitly defined:

- `shape`: schema validated, no authenticity claim;
- `digest`: bytes match an expected digest, issuer not proven;
- `cryptographic`: signature proves possession of a trusted key;
- `anchored`: signature plus an independently durable checkpoint/proof.

`valid=true` at `shape` MUST NOT satisfy a caller requirement for
`cryptographic`. The API accepts a minimum required level and fails closed if it
is not reached. MetaHarness's current shape-only fallback is therefore reported
as `shape`, never as generically verified.

### D9. Lineage proof

A lineage claim is independently verifiable only when the SDK receives:

```text
LineageProofV1 {
  schema,
  subject,
  leaf,
  ordered_chain_or_merkle_path,
  root,
  sequence,
  previous_checkpoint,
  checkpoint_time,
  canonicalization,
  issuer,
  key_id,
  signature
}
```

The verifier checks schema, canonical bytes, every digest link, subject binding,
sequence, trusted key, signature, checkpoint freshness, and optional previous
checkpoint continuity. A single database record and a server-returned hash are
not an independent proof. Current HarnessaaS lineage is exposed as an opaque
reference/legacy record until a signed proof endpoint exists.

### D10. Diagnostic capture

Content-bearing diagnostics are separate from telemetry and require an explicit
`DiagnosticPolicy` that states:

- included schema-classified fields;
- maximum bytes and duration;
- local sink path or callback;
- encryption and access expectations;
- retention/expiry;
- whether prompt, output, source, patch, tool, and environment categories are
  individually allowed.

The SDK previews a manifest of categories before capture. Credentials, signing
private keys, proxy tokens, cookies, repository credentials, and pre-signed URLs
are never capturable. Diagnostic bundles include a redaction report, SDK and
contract versions, and SHA-256 digest. Upload is a separate source-upload consent
operation; capture never uploads automatically.

### D11. Callback and webhook verification

Verifier APIs remain product and scheme specific:

- Meta LLM public webhooks use the published Ed25519 contract;
- Meta LLM pod callbacks use their HMAC contract and are not public-webhook
  aliases;
- HarnessaaS webhooks use their own Ed25519 headers and canonicalization;
- receipts and lineage use their declared issuers and key sets.

All verifiers require exact raw body bytes, algorithm, canonicalization version,
key ID, timestamp skew check, event/delivery ID replay check, and key-set refresh
policy. Unknown key, absent key ID, unstable process-local key, or unverifiable
canonicalization cannot produce `cryptographic`.

Delivery signatures establish authenticity, not exactly-once delivery. Polling
the durable operation/resource remains the source of truth until the product
advertises a durable outbox and replay guarantees.

### D12. Privacy and retention defaults

Default telemetry excludes:

- prompts, messages, completions, embeddings, tool arguments/results;
- source, repository URLs, patches, tests, command output, artifacts;
- credentials, environment values, webhook bodies, signed URLs;
- raw tenant/user identifiers and safety match content.

SDK in-memory buffers retain only what the operation API requires and release it
on completion/close. The SDK does not create disk logs or telemetry spools by
default. A configured adapter owns export retention and MUST receive the data
classification map in its documentation.

### D13. Redaction sentinel scanning

D1's guarantee that "callers receive already-redacted events" is enforced by a
recursive sentinel scan, not by the D3 allow-list alone. The allow-list
constrains which fixed attributes exist; D12 constrains which content
categories are excluded by convention; neither inspects the free-form values
inside `TelemetryEvent.attributes`, `TelemetryEvent.measurements`,
`ExecutionReceiptV1.artifact_digests`, diagnostic manifests (D10), OpenTelemetry
adapter exports (D1), or exception/dropped-event paths (`telemetry.dropped`),
where a secret could leak through a field, or a nested value inside one, that
is not itself named on the allow-list.

A **sentinel** is a compiled matcher set applied to every string leaf value it
visits:

- fixed-format matchers for known credential/token shapes (bearer tokens, JWTs,
  PEM `BEGIN ... PRIVATE KEY` blocks, cloud-provider access-key patterns,
  pre-signed URL query parameters);
- an entropy matcher: Shannon entropy >= 4.0 bits/char over any contiguous
  token of >= 20 characters, evaluated only after the fixed-format matchers, so
  a match is classified by pattern first and by entropy only as a fallback;
- a key-name check against the D12 category list (prompts, messages, tool
  arguments/results, source, repository URLs, patches, credentials,
  environment values, webhook bodies, signed URLs, raw tenant/user
  identifiers), since D3 and D12 constrain keys and categories but not nested
  values.

Traversal algorithm:

1. Depth-first walk starting at each of: `TelemetryEvent.attributes`,
   `TelemetryEvent.measurements`, `ExecutionReceiptV1.artifact_digests`, the
   diagnostic manifest payload defined by `DiagnosticPolicy` (D10), and the
   content-free diagnostic emitted through the D1 fallback hook for
   `telemetry.dropped`.
2. Every map/object value and every array/list element is visited; string
   leaves are tested against the matcher set above.
3. Traversal depth is bounded at 8. A value at depth 9 or deeper is replaced
   with a fixed `[max-depth-exceeded]` marker and never emitted; the
   truncation is recorded as a boolean flag, not the truncated content.
4. Cycles are broken by an object-identity visited-set; a detected cycle is
   replaced with `[cyclic-reference]` and flagged the same way as a depth
   violation.
5. Any leaf that matches a sentinel is replaced with a fixed
   `[redacted:<category>]` marker, where `<category>` is one of the D12
   categories, or `secret-pattern`/`high-entropy` for value-only matches; the
   original value is never retained, logged, or forwarded to a fallback hook.

Pipeline placement, relative to D1's "already-redacted" guarantee:

- for `TelemetrySink.emit()`, the scan completes and all matches are replaced
  before `emit()` is invoked on the caller's sink, and before an official
  OpenTelemetry adapter (D1) maps the event onto an OTel span or metric export
  call;
- for diagnostic bundles (D10), the scan runs before the redaction report is
  generated and before the bundle is written to the local sink path — the
  redaction report lists categories redacted and counts, never values;
- for the dropped-event fallback diagnostic (D1) and any exception path that
  surfaces `cognitum.error.kind` context, the same scan and marker substitution
  applies before the diagnostic reaches its caller-visible surface.

A sink or adapter MUST NOT receive an event, receipt, or diagnostic bundle that
has not completed this scan. Sink failure, timeout, or backpressure (D1) does
not exempt an event from scanning.

## Consequences

### Positive

- Operators can explain latency, cost, routing, cache, degradation, and job state
  consistently across languages and products.
- FinOps distinguishes estimates, reservations, provider reports, commits, and
  reconciled amounts instead of summing incomparable values.
- Verification levels prevent marketing or UI code from presenting a schema
  check as cryptographic or independently anchored proof.
- Optional adapters avoid forcing OpenTelemetry dependencies into every user.

### Negative and trade-offs

- Product services must publish stable metadata, key IDs, canonicalization, and
  evidence schemas before the strongest claims become available.
- Low-cardinality defaults omit some convenient debugging detail. Explicit local
  diagnostic capture is the controlled alternative.
- Decimal money and provenance-aware receipts are more verbose than a single
  floating-point `cost` field.

### Biggest failure mode and mitigation

The biggest failure mode is confidently reporting the wrong payer, routing
plane, final cost, or verification status while leaking customer content through
the observability path. The fix is source/finality labels, product-reported plane
evidence, tagged verification levels, strict canonical proof verification, and
redaction before any user hook runs.

## Alternatives considered

| Option | Pros | Cons | Why rejected |
|--------|------|------|--------------|
| Depend directly on OpenTelemetry core | Standard APIs | Adds dependencies and version coupling to all packages | Neutral sink plus official adapters retains interoperability |
| Log full requests in debug mode | Easy support | Leaks secrets, source, prompts, and personal data | Explicit diagnostic policy is safer and auditable |
| One numeric `cost` | Simple | Cannot distinguish currency, estimate, reserve, commit, or finality | FinOps requires provenance |
| One `verified` boolean | Simple UI | Shape, digest, signature, and anchored proof are different | Tagged levels prevent false assurance |
| Infer proxy plane from configuration | No server change | Runtime policy may select another plane | Selected plane must be response evidence |

## Compliance and verification

Required conformance checks:

1. safe telemetry schema parity and OpenTelemetry adapter mapping in all three
   languages;
2. zero high-cardinality identifiers in metric labels;
3. W3C propagation, invalid context rejection, and baggage default-off behavior;
4. arbitrary sink failure/backpressure does not affect operations and increments
   a bounded dropped counter;
5. decimal money arithmetic and currency separation fixtures;
6. response body/header metadata agreement and disagreement cases;
7. plane evidence remains unknown when Meta Proxy omits it;
8. receipt schema, canonicalization, key rotation, signature, subject, artifact,
   currency, source, and finality tests;
9. verification minimum-level enforcement, including MetaHarness shape-only
   fallback;
10. lineage link, root, sequence, checkpoint, subject, signature, and rewrite
    tamper cases;
11. public-webhook, pod-HMAC, and HarnessaaS-verifier separation;
12. diagnostic preview, byte limit, local-only default, digest, and forbidden
    secret categories;
13. recursive sentinel scanning (D13) of events, adapter exports, diagnostic
    manifests, exception paths, and dropped-event diagnostics, including
    max-depth truncation and cycle-detection fixtures.

### Acceptance test

Replay one golden direct-inference call, proxied call, MetaHarness process run,
and HarnessaaS job through every SDK. Assert equivalent safe traces and usage
values, no content or canary secrets, and no request IDs in metric labels.
Tamper independently with a receipt field, artifact, lineage link, checkpoint,
signature, key ID, and webhook timestamp; each must fail at the correct
verification level. A legacy unsigned receipt and shape-only witness must remain
usable as data but can never satisfy a cryptographic verification requirement.

## References

- ADR-0007: cross-cutting security model
- ADR-0019: agentic bounded contexts and SDK topology
- ADR-0020: contract source of truth and code generation
- ADR-0022: authentication, tenant, budget, secret, and consent isolation
- ADR-0023: errors, retries, idempotency, cancellation, and time budgets
- ADR-0024: Meta LLM dual-protocol inference and governance
- ADR-0025: Meta Proxy local control, routing, and failover
- ADR-0026: MetaHarness local process bridge and supply chain
- ADR-0027: HarnessaaS jobs, events, approvals, artifacts, and isolation
- Source: `sdks/node/package.json:2-67` — no declared SDK telemetry surface or
  adapter
- Source: `sdks/python/pyproject.toml:5-25` — no declared SDK telemetry surface
  or adapter
- Source: `sdks/rust/Cargo.toml:1-73` — no declared SDK telemetry surface or
  adapter
