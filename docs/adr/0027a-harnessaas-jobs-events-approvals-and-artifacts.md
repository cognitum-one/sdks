# ADR 0027a: HarnessaaS Jobs, Events, Approvals, and Artifacts

- **Status:** Proposed
- **Date:** 2026-07-18
- **Deciders:** Cognitum SDK Working Group, HarnessaaS owner, Meta LLM owner, SRE, FinOps, Security
- **Scope:** cross-cutting (`sdks/node`, `sdks/python`, `sdks/rust`); remote HTTP/event client

## Context

HarnessaaS is the remote governed-execution bounded context from ADR-0019. It
is not OSS `npx metaharness`, the private Cognitum MetaHarness CLI, Meta LLM,
or Meta Proxy. Its service accepts untrusted repository content and a test
command, runs a base/mid/frontier repair cascade, grades the result, and returns
a patch with cost, lineage, and conformance evidence.

Its private Node 22 package is not an SDK dependency; SDKs integrate HTTP.

At `cognitum-one/harnessaas@908e4a99:src/types.ts:557-568,786-870`, the public
shapes are:

~~~text
SolveRequest {
  repo, test_command, issue, w?, vertical?, vertical-specific fields?
}
SolveResponse {
  request_id, patch, resolved, cost_receipt, lineage_ref, conformance
}
~~~

`POST /solve` is synchronous. `src/orchestrator.ts` keeps the lifecycle internal:
prepare, open conformance window, run cascade, close, grade, attest, build
receipt, and append lineage. There is no public durable job, status,
cancellation, progress, resume, or idempotency contract. The repository's
Cloud Tasks design notes estimate full solves at 10–30 minutes and call an
asynchronous dispatcher/worker/status/webhook model mandatory, but that model
is not implemented.

`config/api-gateway.openapi.yaml:16-37,66-85` is stale Swagger 2. It covers only
health, solve, and lineage, declares Google ID-token authentication, and has a
placeholder backend. Current source instead implements the synchronous
authenticated `/solve` dispatch at `src/server.ts:367-408` and matches the
lineage read at `src/server.ts:510`. It has no versioned job route, runtime
schema, uniform problem response, or safe POST retry contract.

Request `w` is described as cost/quality control, but `src/cascade.ts` does not
read it; escalation occurs only on empty artifact. A typed no-op would
mislead callers about cost and quality.

The documented `harnessaas-63rzcdswba-uc.a.run.app` runs an older recorded
commit; only black-box conformance proves deployed behavior.

ADR-0027b defines isolation/evidence/webhook gates; this ADR defines job API.

**2026-07-19 reconciliation audit (issue #67):** re-cloned `cognitum-one/harnessaas`
and re-verified this entire Context section against the live upstream `HEAD`.
`908e4a99332617fd321d6f23a1d5a70e07413ffa` is CONFIRMED to still be `HEAD`
(87 commits, none newer than 2026-07-09) — the citations above are current, not
stale. The sync-vs-async framing above is RECONFIRMED exactly as written: `POST
/solve` (`src/server.ts:367-501` at current HEAD) is genuinely one-shot —
request in, full `SolveResponse` out, no job/status/cancel/resume/SSE contract
anywhere in the running service. This is the single most important finding of
the audit: **this ADR's "Decision" (an async job resource) is a proposal to
build something that does not exist yet, not a description of current
behavior** — bindings generated against the D2 `/v1/solves/*` surface below
would not correspond to any deployed route until this ADR ships. One gap this
audit surfaces that the Context section above does not: the live service now
also exposes a MicroLoRA flywheel API (`POST /microlora/run`, `GET
/microlora/status`, `GET /microlora/lineage/:id` — ADR-0032,
`src/server.ts:503-508`), which is synchronous like `/solve` and is not
mentioned anywhere in this ADR's D2 route table or D1 client surface. Before
implementation starts, decide explicitly whether MicroLoRA folds into the same
async job model this ADR proposes for `/solve`, or stays a separate synchronous
flywheel-loop client surface — leaving it undecided risks the same
contract-vs-reality drift this audit was asked to close for `/solve` itself.

## Decision

Replace one-shot solve semantics with an asynchronous, tenant-bound HarnessaaS
job resource. Submission returns in under one second with an idempotent handle.
Status is polled or observed through resumable SSE. Cancellation, approvals,
and artifacts are explicit resources. The SDK never hides these states behind
an inference-style completion call.

The existing synchronous `/solve` is supported only as a pinned preview
compatibility operation with no automatic retry.

### D1. Public client surface

The public domain facade is:

~~~text
HarnessAasClient
  capabilities(), health(), ready(), whoami()
  submitSolve(request, context) -> SolveHandle
  resumeSolve(jobRef, context?) -> SolveHandle
  getSolve(jobRef, context?) -> SolveJob
  listSolves(filter?, page?, context?) -> Page<SolveJob>
  listApprovals(...), getApproval(...) -> ApprovalRequirement(s)
  approve(...), deny(...) -> ApprovalRequirement
  listArtifacts(...), downloadArtifact(...) -> descriptors/content
  listReceipts(...), getReceipt(...), getAttestation(...), getLineageProof(...)
  getEvidenceKeys(...) -> EvidenceKeySet
  webhooks.create/list/delete/listDeliveries(...)
  legacy.solve(...) -> LegacySolveResponse       # preview only
  close()

HarnessAasVerifier(trustPolicy): verifyReceipt/Attestation/Lineage(...)
HarnessAasWebhookVerifier(trustPolicy, replayStore): verifyWebhook(raw, headers, now)
~~~

`SolveHandle` implements ADR-0023 `OperationHandle<SolveJob,SolveOutcomeV1,
SolveEvent>`; all handle methods retain HarnessaaS-native states.

`solveAndWait` MAY call `submitSolve` then handle `wait/result`. Cancelling a
local wait does not cancel the job; only explicit handle `cancel` requests it.

Every `JobRef` binds product, normalized origin, authenticated tenant/provider
identity, contract major, and job ID. Reusing it with another client identity
fails locally. Foreign resources map to the same `NotFoundError` as absent
resources.

### D2. HTTP v1 resources

The upstream OpenAPI 3.1 bundle from ADR-0020 must define at least:

| Method and path | Meaning | Normal success |
|-----------------|---------|----------------|
| `GET /health` | Process health, public | 200 |
| `GET /ready` | Queue/worker readiness, public | 200/503 |
| `GET /v1/whoami` | Credential tenant/scopes | 200 |
| `GET /v1/capabilities` | Auth-aware protocol/features/limits | 200 |
| `POST /v1/solves` | Submit one logical solve | 202, `Location`, `Retry-After` |
| `GET /v1/solves/{job_id}` | Authoritative snapshot | 200 with `ETag` |
| `GET /v1/solves` | Tenant-scoped bounded list | 200 |
| `POST /v1/solves/{job_id}/cancel` | Idempotent cancel request | 200 or 202 |
| `GET /v1/solves/{job_id}/events` | Resumable SSE | 200 `text/event-stream` |
| `GET /v1/solves/{job_id}/approvals[/{id}]` | Approval list/snapshot | 200 |
| `POST .../approvals/{id}/approve; .../deny` | Decide exact action | 200 |
| `GET /v1/solves/{job_id}/artifacts` | Artifact descriptors | 200 |
| `GET /v1/artifacts/{artifact_id}/content` | Bounded content stream | 200/206 |
| `GET /v1/solves/{job_id}/receipts` | Immutable receipt history | 200 |
| `GET /v1/receipts/{receipt_id}` | Exact receipt revision | 200 |
| `GET /v1/solves/{job_id}/attestation` | Conformance evidence | 200 |
| `GET /v1/solves/{job_id}/lineage-proof` | Verifiable lineage proof | 200 |
| `GET /v1/evidence/keys` | Signed evidence keyset | 200 |
| `GET and POST /v1/webhooks` | List/create subscriptions | 200/201 |
| `DELETE /v1/webhooks/{id}` | Delete subscription | 204 |
| `GET /v1/webhooks/{id}/deliveries` | Delivery history | 200 |

Probe schemas are `HealthV1{status,build_digest}` and
`ReadinessV1{ready,dependencies,build_digest}`; identity carries subject/tenant/scopes/auth method.

Responses return request/protocol IDs. RFC 9457 errors retain code/retryability/
field path; unknown codes are non-retryable unless ADR-0023 proves safety.

Current 5,000,000-character cap is replaced by endpoint byte/decompression limits.

Core routes do not use the existing broad `/api/v1/*` relay namespace. The SDK
does not code-generate from the stale Swagger 2 file.

### D3. Solve request and job types

The stable request is:

~~~text
SolveSubmissionV1 {
  schema: "cognitum.harnessaas.solve-request.v1"
  source: GitSource, issue: IssueSpecification
  test: CommandSpec
  vertical?: code_repair | security_remediation |
             dependency_migration | test_generation
  routing_policy?, budget_policy?, retention_policy?
  client_metadata?: bounded non-content map
}

GitSource { url, resolved_commit_sha, credential_reference? }
UploadedSource { upload_id, sha256, bytes, media_type }   # preview only
CommandSpec { argv: List<String>, cwd?, env_references?, timeout? }

SolveJob {
  schema, id, revision, state, phase, created_at, updated_at
  source_digest, request_digest, capability_snapshot
  worker_attempt?, lease_generation?
  approval_refs, artifact_refs, cost_summary, outcome?, failure?, expires_at?, meta
}

SolveOutcomeV1 {
  resolved, patch_artifact_ref, test_report_ref?
  receipt_ref, attestation_ref?, lineage_proof_ref
}

SolveTerminalFailure {
  code, failed_phase, retryable=false, diagnostic_artifact_ref?
  receipt_ref, lineage_proof_ref
}
~~~

A remote client never sends a local path. Git is stable v1. Upload remains
preview until upload resources are contracted; it requires ADR-0022 consent,
bounded archive/digest, and server upload ID. Git URLs reject embedded secrets.

`CommandSpec.argv` is an array, not a shell. Legacy `test_command` remains
preview and is never interpolated. Future shell mode must be named,
capability-gated, recorded in lineage, and cannot weaken ADR-0027b isolation.

`w` is absent from stable requests until tests map it to routing/cost.
Preview may preserve `experimental_weight` with `effect=unknown`; copying it
into lineage alone is not conformance.

`handle.wait` returns a snapshot/wait outcome, including nonterminal approval
state. `handle.result` returns `SolveOutcomeV1` only after `succeeded`; other
terminals raise ADR-0023 `OperationFailedError` with failure/final snapshot.

### D4. Job state machine

Normative states are:

~~~text
accepted | queued | preparing | running_base | awaiting_approval
running_mid | running_frontier | grading
succeeded | failed | cancelled | expired
~~~

`succeeded`, `failed`, `cancelled`, and `expired` are terminal. A job has
exactly one terminal transition. Escalation states may be skipped. Entering
`awaiting_approval` records `resume_state` and an approval ID; resolution
returns only to that allowed successor. Each transition increments `revision`
and emits one durable `job.state_changed` event.

Allowed forward paths are:

~~~text
accepted -> queued -> preparing -> running_base
running_base -> running_mid | awaiting_approval | grading
running_mid -> running_frontier | awaiting_approval | grading
running_frontier -> awaiting_approval | grading
awaiting_approval -> declared resume_state | grading
grading -> succeeded | failed
any nonterminal -> failed | cancelled | expired
~~~

There is no transition out of terminal. A cancellation race that loses to
success remains `succeeded` and preserves its receipt. State snapshot and event
history disagreement is `ProtocolError`; the SDK does not manufacture a
plausible sequence.

`phase` may provide finer progress but cannot redefine `state`. Progress is
non-authoritative, bounded, and may repeat. No SDK ETA is presented as a server
guarantee.

### D5. Submission and idempotency

`POST /v1/solves` must return 202 within one second at p95 before repository
clone, model call, or test execution. It returns a durable job ID, `Location`,
snapshot, and polling hint.

Submission requires `Idempotency-Key`. The server atomically binds it under
ADR-0023 to principal, tenant/subtenant, method, normalized route, contract
major, and canonical request SHA-256. Requirements:

- identical submissions collapse to one logical job/reservation;
- at-least-once queue deliveries acquire a lease by CAS generation/fencing
  token; stale attempts cannot clone, call models, write artifacts, or commit;
- same key/binding returns the original job with no duplicate spend;
- same key with different request binding returns 409
  `idempotency_mismatch`;
- records live for at least the job lifetime plus one hour and never less than
  24 hours;
- raw keys never appear in telemetry or lineage.

The SDK may generate one random key for one `submitSolve` invocation and reuse
it across transport attempts. It never reuses a key across logical calls.
Without advertised atomic idempotency, submission is blocked or the explicit
legacy operation is non-retryable.

The legacy `POST /solve` is never automatically retried, including connection
loss before response, because the server may already have spent or executed.
Its response may be adapted to a terminal compatibility result with
`source=legacy-synchronous`; missing signatures, meter provenance, and job
history remain explicitly unverified.

### D6. Polling and wait

`getSolve` is the authoritative snapshot and is safe-read retryable under
ADR-0023. It supports `If-None-Match` and 304. Server `Retry-After` controls
normal poll cadence, not transport-error retry.

Default wait cadence starts at 2 seconds, doubles to 15 seconds with jitter,
then stays at 15 seconds. Caller deadline is required or a documented
product-policy default is applied. Deadline expiry stops only the local wait
and returns the last snapshot; it does not cancel the job.

`SolveHandle.wait` can stop on terminal, approval required, a selected state,
or local deadline. It does not approve, cancel, increase budget, or change
routing automatically. Closing the client ends waits but leaves jobs running.

### D7. Resumable server-sent events

`SolveHandle.events` uses `text/event-stream` and these event types:

~~~text
job.accepted | job.state_changed | job.progress
approval.required | approval.resolved | artifact.available
cost.updated | receipt.finalized | lineage.checkpoint | job.terminal
~~~

Every event includes schema, opaque dedupe/resume ID, numeric monotonic
`sequence`, job ID/revision, timestamp, type, and typed data. Delivery is at
least once. The service retains events for at least 24 hours and
at least one hour after terminal, whichever is later. Heartbeats occur at most
15 seconds apart; one event is at most 1 MiB.

Reconnect sends `Last-Event-ID`. The server resumes after it. The SDK dedupes
by opaque ID and detects gap/regression by numeric sequence. If
retention expired, the server returns 410 with the oldest available ID and
current snapshot reference; the SDK reports an explicit gap and may switch to
polling only when capabilities declare snapshot equivalence.

SSE reconnection is not inference-stream replay. Transport reconnect uses
ADR-0023 backoff and cannot resubmit the solve. Unknown additive events are
preserved. Content-bearing test logs are artifact references, not default event
bodies.

### D8. Cancellation

`SolveHandle.cancel` is an authenticated idempotent mutation with its own idempotency
key. The response distinguishes `cancellation_requested`,
`already_terminal`, and terminal `cancelled`.

Once accepted, the scheduler stops new model/test work and budget reservation.
The active worker receives a cancellation lease and must terminate its process
tree within 30 seconds or mark the job failed with isolation diagnostics.
No new metered route may begin after the cancel acceptance timestamp.
Already-observed usage remains in the receipt.

Cancellation does not delete artifacts or lineage. Retention/deletion is a
separate consent-bearing operation. The SDK never interprets local HTTP abort
as successful remote cancellation.

### D9. Approvals

An approval is a versioned resource:

~~~text
ApprovalRequirement {
  schema, id, job_id, revision, kind: cost_escalation | model_tier_escalation
  state: pending | approved | denied | expired | superseded
  requested_action, policy_digest, current_cost, maximum_additional_cost?
  requested_tier?, reason_code, created_at, expires_at
  approve_state, deny_state, expiry_state, required_scope, decision?
}
~~~

The SDK never approves automatically, in a retry, or because a broad consent
exists. Approve/deny requires the exact approval ID, current revision/ETag,
decision idempotency key, and declared scope. Concurrent decisions collapse or
return 409; an expired/superseded approval cannot be revived.

Approval authorizes only the described budget/tier action. In v1, post-solve
patch-promotion/business gates are non-interactive result events, not approvals.
Approval cannot relax sandboxing, expose service credentials, enable
arbitrary egress, change tenant, opt into training/retention, or bypass safety.
Those are prohibited or require ADR-0022 consent. Decision/expiry takes its
declared allowed successor (resume, grading, or failed), never another payer.

### D10. Artifact contract

Artifacts are immutable tenant-bound descriptors:

~~~text
ArtifactDescriptor {
  schema, id, job_id, kind, revision
  media_type, bytes, sha256, created_at, expires_at
  content_disposition, verification, download_authorization
}
~~~

Kinds include patch, test report, diagnostic bundle, conformance, receipt, and
lineage proof. Stable outcomes always reference patch artifacts; only legacy
`/solve` may carry an inline patch. Ordinary JSON follows ADR-0020 bounds.

Download streams to an explicit sink and enforces type/size/digest with a
100 MiB default cap. Product-auth requests allow at most three same-origin
redirects; presigned cross-origin downloads send no product auth and disable
redirects. Resume requires declared ranges; final digest always validates.
Mismatch quarantines partial output and returns `IntegrityError`.

An artifact event is not proof the content is trusted. Verification status is
preserved under ADR-0028 and ADR-0027b.

### D11. Authentication, tenant, and current blockers

Current application auth accepts `cog_` keys via `X-API-Key` or bearer and
derives account/tenant server-side. The stable OpenAPI must declare one
canonical placement per operation, actual scopes, and delegated-token rules.
The SDK never sends both and never forwards this credential to Meta LLM.

Current source scopes such as `completions:low/mid/high`,
`safety:scan`, `webhooks:admin`, and `completions:security` are preserved only
in an exact compatibility table until the service publishes HarnessaaS job and
approval scope ownership. The SDK does not invent wildcard relationships.

Stable job exposure is blocked by:

1. stale Swagger 2 routes/auth, no executable OpenAPI 3.1/schema bundle, and
   unversioned response/error/event envelopes;
2. synchronous long-running `/solve` with no durable job, atomic idempotency,
   status, cancel, or event store;
3. no approval race or immutable artifact/download contract;
4. ineffective `w`, deployed revision drift, and unproven live behavior;
5. isolation/evidence/webhook failures in ADR-0027b.

## Migration and rollout

1. Publish v1 schemas, actual auth/scopes/limits, problem codes, capabilities,
   and fixtures from the server source.
2. Introduce dispatcher/job store/idempotency record; make legacy orchestration
   a worker implementation.
3. Add snapshot, polling, cancellation, and SSE with durable event IDs.
4. Add approval and artifact resources; keep `w` preview until behavioral
   tests prove it or remove it.
5. Ship SDK async preview. Keep `legacy.solve` explicitly non-retryable.
6. Adapt legacy terminal responses without inventing history or verification.
7. Pass ADR-0027b and ADRs 0030a/0030b before GA.

The service may retain `/solve` during a two-minor deprecation window. New SDK
examples use durable jobs immediately. Unknown fields are preserved; unknown
states remain `unknown(raw)` and block mutation but not inspection.

## Consequences

### Positive

- A caller can reconnect to a 10–30 minute solve without resubmitting it.
- Idempotency prevents retry-amplified execution and spend.
- Approval, cancellation, and artifact authority become explicit resources.
- Polling and SSE share one durable source of truth.

### Negative and quantified trade-offs

- A 30-minute wait with 2-to-15-second polling uses about 123 status requests
  after ramp-up rather than 900 at a fixed 2 seconds. At 10,000 simultaneous
  jobs the 15-second steady state is about 667 requests/second; SSE trades that
  load for up to 10,000 open connections.
- At one million submissions/day, a minimal 1 KiB idempotency record is about
  1 GiB/day before indexes and replication; at least 24-hour retention is still
  required to prevent duplicate spend.
- Durable event storage, approval races, and worker cancellation add an
  estimated 10–18 upstream engineering days plus 5–8 SDK days.
- The one-second submit budget requires moving all clone/model/test work behind
  the queue and operating that queue as critical infrastructure.

### Biggest failure mode and mitigation

The biggest failure mode is retrying an ambiguous synchronous `/solve` and
launching duplicate untrusted executions, duplicate model spend, and conflicting
patches while the SDK reports one apparent request. A sub-second idempotent
submission, tenant-bound durable job, authoritative state/event history, and
explicit approval/cancellation prevent that amplification.

## Alternatives considered

| Option | Advantage | Defect | Why rejected |
|--------|-----------|--------|--------------|
| Keep synchronous `/solve` with a long timeout | Minimal server work | Disconnect ambiguity, no resume/cancel, unsafe retry | 10–30 minute work requires durable ownership |
| SDK background thread wraps `/solve` | No server API change | State disappears with client and cannot dedupe spend | Durability must be server-side |
| Poll only | Simple server | High load and delayed approval/progress | Required fallback, not only transport |
| Webhook only | No client connection | Current delivery is lossy and callback may be unavailable | Poll/status remains source of truth |
| Auto-approve cost escalation | Fewer pauses | Changes spend authority silently | Violates ADR-0022 |
| Keep raw shell string stable | Backward compatible | Ambiguous interpolation and injection surface | Stable contract uses argv |

## Compliance and executable verification

Jobs are offline SDK, injected upstream, then origin/build/budget-gated live.

1. **`openapi_runtime_conformance`:** runtime routes/auth/schemas/limits/errors exactly match OpenAPI.
2. **`submit_latency`:** after 100 warmups, 1,000 submits at concurrency 50 meet one-second p95 without inline work.
3. **`idempotency_race`:** 100 deliveries admit one fenced execution/reservation/route; changed body is 409.
4. **`unsafe_retry_guard`:** disconnect legacy `/solve`; each SDK sends one POST.
5. **`state_machine_property`:** generated sequences have allowed edges, increasing revision, one terminal.
6. **`sse_resume`:** hostile resume fixtures dedupe or report explicit sequence gap; never resubmit.
7. **`poll_fallback`:** virtual time proves 2–15 second cadence, ETags, and local-only deadline.
8. **`cancel_race`:** all states stop later routes; worker ends within 30 seconds; success race stays success.
9. **`approval_race`:** stale/concurrent/duplicate decisions yield one winner and no auto-approval.
10. **`approval_authority`:** approval cannot weaken isolation/egress/secrets/tenant/consent/safety.
11. **`artifact_integrity`:** inline/oversize/range/redirect/truncate/digest/media/expiry/sink fixtures fail safely.
12. **`tenant_handles`:** cross-tenant/origin refs fail locally or uniform not-found.
13. **`weight_behavior`:** deterministic route/cost effect is proven, or `w` is not stable.
14. **`handle_result`:** wait returns snapshots; result returns success or typed terminal failure.
15. **`live_revision`:** gated fixtures require exact origin and advertised build/policy digest.
16. **`language_parity`:** canonical fixtures decode equivalently in all SDKs.

### Executable acceptance test

~~~text
cd sdks/node   && npm test -- harnessaas-job-conformance
cd sdks/python && pytest -m harnessaas_job_conformance
cd sdks/rust   && cargo test --features harnessaas harnessaas_job_conformance
tests/agentic-conformance/harnessaas/run --mode upstream-jobs --fake-clock --fake-queue --fake-model
HARNESSAAS_TEST_ORIGIN=... EXPECTED_BUILD_SHA=... EXPECTED_POLICY_SHA=... MAX_TEST_COST=... tests/agentic-conformance/harnessaas/run --mode deployment-jobs
~~~

Simulate 30 minutes: one fenced execution, gap-safe resume, approval/cancel,
cross-language parity, and non-retried legacy must hold.

## References

- ADR-0019: agentic platform bounded contexts and SDK topology
- ADR-0020: agentic contract source of truth and code generation
- ADR-0021: agentic service configuration, transports, and capabilities
- ADR-0022: agentic authentication, tenant, budget, secret, and consent isolation
- ADR-0023: agentic errors, retries, idempotency, cancellation, and time budgets
- ADR-0024a: Meta LLM serving protocols and streaming
- ADR-0024b: Meta LLM platform resources, routing, and usage
- ADR-0025a: Meta Proxy client, routing, and consent
- ADR-0025b: Meta Proxy lifecycle, integrity, and GA gates
- ADR-0027b: HarnessaaS isolation, evidence, webhooks, and GA gates
- ADR-0028: telemetry, traces, usage, cost receipts, lineage, and redaction
- ADR-0029: language packaging, features, and CLI
- ADR-0030a: conformance, CI, and release evidence
- ADR-0030b: migration, rollout, and publication
- `cognitum-one/harnessaas@908e4a99332617fd321d6f23a1d5a70e07413ffa`
