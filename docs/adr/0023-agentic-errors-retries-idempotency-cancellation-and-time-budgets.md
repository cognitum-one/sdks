# ADR 0023: Agentic Errors, Retries, Idempotency, Cancellation, and Time Budgets

- **Status:** Proposed
- **Date:** 2026-07-18
- **Deciders:** Cognitum SDK Working Group, Meta LLM owner, Meta Proxy owner, HarnessaaS owner, SRE, FinOps
- **Scope:** cross-cutting (`sdks/node`, `sdks/python`, `sdks/rust`)

## Context

ADR-0004 and ADR-0005 define a shared error and retry direction, but the three
current cloud implementations have drifted:

- Node has equal jitter, a 60-second retry budget, broader transient statuses,
  and caller-attested idempotency (`sdks/node/src/client.ts:14-29,82-217`).
- Python lacks the total retry budget and jitter and recognizes fewer retry-hint
  formats (`sdks/python/cognitum/_http.py:19-41,97-160`).
- Rust retries a narrower status set, can retry POST without an idempotency gate,
  has no total elapsed budget, and its public error enum is not future-proof
  (`sdks/rust/src/client.rs:297-365`; `sdks/rust/src/error.rs:5-54`).

The consequences become financial and operational for agentic products:

- Meta LLM inference can bill even when a client disconnects after partial
  streamed output.
- Meta LLM's current idempotency store is keyed only by API-key hash and the
  caller key. It is shared across inference protocols and is not bound to HTTP
  method, path, or request-body digest. Streams look up but do not store a final
  response (`cognitum-one/meta-llm@948bd31a:src/ratelimit/idempotency.ts`).
- Batch creation, pod mutations, and approvals do not yet have complete
  idempotency protection.
- Meta Proxy drops `Idempotency-Key` on current cloud paths and cannot safely
  replay sponsored streaming.
- HarnessaaS `POST /solve` is synchronous, long-running, and has no idempotency,
  status, cancellation, or resumable event contract.

An automatic retry can therefore duplicate spend, execute the same repository
twice, approve twice, or replay a response from the wrong protocol. Timeouts are
also ambiguous: stopping a local wait does not necessarily cancel server work.

## Decision

Adopt one language-neutral failure model and one retry classifier based on
operation semantics and proven server capabilities. A deadline, cancellation
request, transport abort, stream end, remote operation cancellation, and local
process termination are distinct states. Never retry or claim cancellation when
the required server/bridge guarantee is absent.

### D1. Public error model

All errors derive from a common `CognitumError` domain shape:

```text
CognitumError {
  kind,
  message,
  product,
  operation,
  status,
  code,
  request_id,
  correlation_id,
  protocol_version,
  retryable,
  retry_after,
  attempt_count,
  details,
  cause
}
```

`message`, `details`, and `cause` are redacted before exposure. The original
status, product code, safe response headers, and request identifiers are
preserved even when mapped to a common kind.

The agentic extension adds these categories to ADR-0004:

| Error kind | Typical source | Retry default |
|------------|----------------|---------------|
| `configuration` | Missing URL or invalid option | Never |
| `authentication` | 401 or invalid local proxy token | Once only after noninteractive refresh capability |
| `permission_denied` | 403 or missing scope | Never |
| `not_found` | 404, including foreign resource | Never |
| `validation` | 400 or schema failure | Never |
| `conflict` | 409 state or idempotency mismatch | Never automatically |
| `rate_limited` | 429 | Only for retry-safe operations and within budget |
| `budget_exceeded` | 402 or budget code | Never automatically |
| `safety_blocked` | 422 or safety code | Never |
| `consent_required` | Missing exact grant | Never; caller supplies consent |
| `unsupported_capability` | Required capability absent/unknown | Never |
| `protocol` | Wrong media type, schema, or protocol major | Never against the same deployment unless fresh negotiation resolves it |
| `integrity` | Digest/signature/lineage failure | Never |
| `isolation_unavailable` | Safe executor or sandbox absent | Never |
| `transport` | DNS, connect, reset before response | Classifier decides |
| `deadline_exceeded` | Local time budget expired | Never by itself |
| `cancelled` | Local caller cancellation | Never |
| `process_failed` | MetaHarness exit, signal, or bridge failure | Never automatically |
| `operation_failed` | Durable remote terminal failure | Never automatically |

Rust error enums MUST be `#[non_exhaustive]` before release. Node exports all
public error classes from the product subpaths. Python populates request and
correlation fields in every HTTP mapper, not just its class definitions.

### D2. Protocol-specific error preservation

Meta LLM has distinct generic/OpenAI, Anthropic, and Responses error envelopes.
The SDK maps them to the common categories while retaining a typed
protocol-specific safe payload. It MUST NOT assume all errors are
`{error:{message}}`.

RFC 9457 `application/problem+json` is the target for new Cognitum platform
routes, including HarnessaaS v1. Unknown product error codes map to
`CognitumError(kind="unknown")`, retain the raw code and status, and default to
non-retryable unless the status and operation classifier prove safety.

HTML proxy pages, oversized bodies, invalid UTF-8, and wrong content types map to
`ProtocolError`; only a bounded redacted prefix is retained.

### D3. Operation retry classification

Each operation contract declares one of:

```text
safe_read
idempotent_mutation
idempotent_with_key
non_idempotent
streaming
local_process
```

The classifier is the conjunction of operation class, server capability,
attempt phase, response status, caller deadline, retry budget, and cancellation
state. A status code alone is never sufficient.

| Operation class | Before any response bytes | After headers or bytes | Required proof |
|-----------------|---------------------------|------------------------|----------------|
| Safe read | May retry transient failures | Only if no semantic body/event consumed | Contract marks safe and no side effect |
| Idempotent mutation | May retry | May retry only when full outcome is known absent or safely replayable | Contract and server guarantee |
| Idempotent with key | May retry using the same key and body fingerprint | May replay only if server returns the stored complete outcome | Server implements exact `IdempotencyBindingV1` and atomic complete-result replay |
| Non-idempotent | No automatic retry | Never | Caller starts a new logical operation explicitly |
| Streaming | At most before request acceptance when contract explicitly supports it | Never after first response byte | Resumable application event protocol, not inference byte replay |
| Local process | No automatic restart | Never | Caller invokes a new process run |

### D4. Default transient policy

For a retry-safe operation, default maximum attempts are four total: the first
attempt and up to three retries. The delay uses the same equal-jitter backoff
formula as ADR-0005 verbatim — this ADR does not narrow or override it, and
agentic modules MUST NOT diverge from it:

```text
delay_ms(attempt) = min(
    cap_ms,
    max(
        server_hint_ms,                     # Retry-After if present
        base_ms * 2 ** attempt + jitter
    )
)
```

- `base_ms = 500`
- `cap_ms = 30000` (30 s)
- `jitter = uniform(0, base_ms)` — equal-jitter
- `attempt` starts at 0

The default aggregate retry-sleep budget is 60 seconds and is independent of
the request's total deadline. The next attempt runs only if its scheduled delay
and minimum attempt allowance fit both budgets.

Eligible conditions are a connection failure before response bytes, 408, 429,
500, 502, 503, and 504. Product contracts may narrow this set. The SDK honors,
in precedence order:

1. a valid `Retry-After` delta or HTTP date;
2. a contract-defined response field such as milliseconds or microseconds;
3. the jitter calculation.

Hints are clamped to the remaining deadline and retry budget. Conflicting or
negative hints are ignored and recorded as safe telemetry. The SDK never sleeps
past a caller deadline to honor a server hint.

401 permits at most one credential invalidation and noninteractive refresh when
the provider and route support it. 400, 402, 403, 404, 409, and 422 are not
automatically retried. A product-specific code can further prohibit retry.

### D5. Idempotency key contract

A compliant server reuses this exact shared structure:

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

For `application/json`, the SDK first encodes the exact wire object, including
the contract's null-versus-omitted decisions, requires I-JSON values, serializes
with RFC 8785 JSON Canonicalization Scheme, UTF-8 encodes it, and hashes those
bytes with SHA-256. Empty bodies hash the empty byte string. Other contracted
media types hash their exact uncompressed entity bytes. Route identity is the
contract operation ID plus normalized path parameters and canonically sorted,
percent-encoded query pairs; scheme, host, fragments, and incidental client URL
formatting are excluded. All three SDK fixtures publish the canonical bytes and
digest, not only the resulting UUID or header.

The same key and same binding returns the original complete result without
rebilling. The same key with a different binding returns
`409 idempotency_mismatch`. Records have a documented retention window and
concurrent first submissions collapse atomically.

For a method whose contract permits SDK-generated keys, the SDK creates a
cryptographically random UUID for one logical call and reuses it across its
attempts. It does not reuse it across methods, clients, or caller invocations.
A caller-provided key is validated and treated as correlation-sensitive data;
telemetry records a hash, not the raw key.

Until Meta LLM binds method/path/body and Meta Proxy forwards the key, the SDK
MUST NOT enable automatic POST replay through those paths in the stable surface.
Until HarnessaaS and Meta LLM batch/pod mutations implement atomic dedupe, those
mutations are non-idempotent even if the caller supplies a header.

### D6. Streams and resumability

Inference streams are not resumable by byte offset. After any response byte:

- a disconnect terminates with a stream error containing request ID and partial
  usage/receipt metadata when available;
- the SDK does not reconnect or resend;
- partial output remains explicitly marked partial;
- absence of a terminal receipt does not imply zero cost;
- the caller may start a new model request with a new logical ID.

Durable operation event streams, such as HarnessaaS jobs, MAY resume when the
contract supplies monotonic event IDs, retention, and `Last-Event-ID` behavior.
The SDK deduplicates the boundary event, detects gaps and regression, and falls
back to polling only when the capability declares equivalent source-of-truth
semantics. It never presents a reconnected event stream as one uninterrupted
model response.

### D7. Cancellation semantics

The SDK exposes three distinct actions:

| Action | Effect |
|--------|--------|
| Cancel local request/wait | Abort local network read or poll loop; remote work may continue |
| Cancel remote operation | Send the product's idempotent cancel operation and observe a terminal or race outcome |
| Terminate local process | Signal and reap the owned MetaHarness process tree |

Cancelling a wait MUST NOT call remote cancellation implicitly. Closing a client
behaves like cancelling local waits only. A remote cancel returns an operation
snapshot, including `already_terminal`, `cancellation_requested`, or
`cancelled`. A success racing with cancellation remains success and retains its
receipt.

MetaHarness termination sends the platform-appropriate graceful signal, waits a
bounded grace period, terminates the owned process group/tree, closes pipes, and
reaps the child. It never kills by unverified PID file or process name.

### D8. Time budget model

Timeouts are separate values:

```text
connect_timeout       time to establish a connection
first_byte_timeout    time to response headers/first event
idle_timeout          maximum silence between stream/events
request_deadline      total local HTTP call deadline
wait_deadline         total local wait/poll deadline
cancel_grace          bounded graceful process or operation-cancel wait
retry_sleep_budget    aggregate scheduled retry delay
```

Product defaults are declared in their contracts. The shared layer does not use
one 30-second timeout for streaming, inference, and ten-minute operations.
Caller context may shorten but not silently lengthen an organization policy
deadline.

Expiration of `wait_deadline` returns `DeadlineExceededError` with the latest
operation snapshot and handle so the caller can resume waiting. It does not mark
the server job failed or cancelled. A first-byte or idle timeout after possible
server acceptance includes `outcome_unknown=true` unless idempotent replay can
resolve it.

### D9. Durable operation behavior

Remote batches, pods, and HarnessaaS jobs use a common handle contract but keep
their native states:

```text
OperationHandle {
  id, product, origin_binding, tenant_binding, created_at
  get()
  wait(options)
  events(options)       # only when capable
  cancel()              # only when capable
  result()
}
```

`wait()` returns the latest snapshot, including a terminal failure, rather than
hiding it in a generic transport exception. `result()` returns the successful
result or raises `OperationFailedError` containing the terminal snapshot.
Approval-required is a state, not an exception. A batch can be terminal
`completed` while containing per-item failures; item outcomes remain a typed
list.

Polling uses the same bounded jitter policy, honors `Retry-After`, and is not
counted as retrying the operation itself. Poll transient failures consume a
separate wait transport budget. State regression, identity change, or a second
different terminal state is a `ProtocolError`.

### D10. No hidden fallback or circuit behavior

The SDK retry layer retries the same product, origin, operation, payer, routing
constraints, and consent. It never changes:

- Meta LLM tier, model bounds, fallback policy, safety mode, or cache policy;
- Meta Proxy plane, workload policy, provider credential, or sponsor mode;
- HarnessaaS executor, repository revision, test command, or vertical;
- region, tenant, or base URL.

Provider fallback inside Meta LLM or routing inside Meta Proxy is server/product
behavior and must appear in response metadata. An optional SDK circuit breaker
may fail fast against one origin, but cannot select another origin. It is off by
default until separately specified.

## Consequences

### Positive

- Expensive operations cannot be duplicated merely because one language had a
  broader retry loop.
- Deadline and cancellation results accurately describe whether remote work may
  still be running.
- One error taxonomy supports all three protocols, local processes, integrity
  checks, and durable jobs without discarding native evidence.
- Resumable job events are possible without pretending inference streams are
  resumable.

### Negative and trade-offs

- Stable POST retries remain disabled until server idempotency blockers are
  fixed, reducing automatic recovery from ambiguous network failures.
- Full response metadata and operation snapshots make APIs larger than returning
  a bare body or throwing on every non-success state.
- Injected clocks and randomness are required for deterministic cross-language
  tests.

### Biggest failure mode and mitigation

The biggest failure mode is a timeout followed by an automatic replay that
creates duplicate spend or execution, or returns a cached response from another
protocol. The fix is semantic retry classification, method/path/body-bound
idempotency, no stream replay after bytes, and an explicit unknown-outcome state
when safety cannot be proven.

## Alternatives considered

| Option | Pros | Cons | Why rejected |
|--------|------|------|--------------|
| Retry all 5xx and network errors | Simple resilience story | Duplicates non-idempotent paid work | Operation semantics must gate retry |
| Never retry anything | Safest against duplication | Poor reliability for safe reads and proven dedupe | Bounded semantic retry is safe and useful |
| Treat timeout as cancellation | Simple mental model | Server work can continue and bill | Local and remote lifecycle must be distinct |
| Normalize every stream into text chunks | Easy consumption | Loses native events, errors, tools, usage, and receipts | Protocol-specific events plus convenience text are required |
| Throw whenever an operation is not successful | Familiar | Approval and partial batch outcomes are normal states | Snapshots preserve workflow state |

## Compliance and verification

The shared conformance suite MUST cover:

1. equivalent error mapping, request IDs, safe details, and retryability across
   Node, Python, and Rust;
2. Rust non-exhaustive errors and redacting debug behavior;
3. 408, 429, 500, 502, 503, 504, transport-before-bytes, transport-after-bytes,
   and invalid retry hints;
4. four total attempts, equal jitter, 30-second delay cap, 60-second sleep budget,
   and caller deadline with injected clock/randomness;
5. no POST retry without a proven idempotency capability;
6. same key/same body replay, concurrent collapse, different body/path 409, TTL,
   and tenant separation once servers implement the contract;
7. arbitrary stream byte fragmentation, partial output, terminal error, receipt,
   disconnect, and zero automatic replay;
8. durable event resume with duplicate boundary, gap, regression, expiry, and
   polling fallback;
9. local-wait cancel versus remote cancel versus process-tree termination;
10. wait deadline returning a resumable handle without changing remote state;
11. batch partial outcomes and approval-required as values;
12. proof that retry never changes origin, tier, plane, payer, consent, tenant,
    repository revision, or executor.

### Acceptance test

Run a fault-injecting fake service that records every logical operation and
charge. For each SDK, cut the connection before headers, after headers, after a
stream event, and after server commit but before the response. Safe reads may
retry within the same 60-second policy; non-idempotent calls must produce an
unknown outcome with exactly one server submission; an idempotent fixture must
produce one operation and one charge across four attempts; a changed body with
the same key must return 409; and cancelling a local wait must leave the remote
job retrievable.

## References

- ADR-0004: cross-cutting error taxonomy
- ADR-0005: cross-cutting retry and backoff
- ADR-0019: agentic bounded contexts and SDK topology
- ADR-0020: contract source of truth and code generation
- ADR-0021: service configuration, transports, and capabilities
- ADR-0022: authentication, tenant, budget, secret, and consent isolation
- ADR-0024a: Meta LLM serving protocols and streaming
- ADR-0024b: Meta LLM platform resources, routing, and usage
- ADR-0027a: HarnessaaS jobs, events, approvals, and artifacts
- ADR-0027b: HarnessaaS isolation, evidence, webhooks, and GA gates
