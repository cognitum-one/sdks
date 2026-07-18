# ADR 0027b: HarnessaaS Isolation, Evidence, Webhooks, and GA Gates

- **Status:** Proposed
- **Date:** 2026-07-18
- **Deciders:** Cognitum SDK Working Group, HarnessaaS owner, Security, Privacy, SRE, FinOps, Meta LLM owner
- **Scope:** cross-cutting (`sdks/node`, `sdks/python`, `sdks/rust`); remote governed-execution trust boundary

## Context

HarnessaaS executes repositories and customer-supplied test commands. Its
tenant-command path uses optional netns/seccomp wrappers but falls back to
plain `execSync` (`cognitum-one/harnessaas@908e4a99:src/sandbox.ts:17-47`).
The source notes that plain execution inherits full `process.env`, including
platform keys (`src/sandbox.ts:77-81`), and patch staging also invokes a shell
(`src/sandbox.ts:163`). Hosted execution must not fail open with service identity.

Current model calls use a HarnessaaS-owned outbound Cognitum credential and
optional `X-Cognitum-Sub-Tenant` metadata. That credential is distinct from
the inbound end-tenant `cog_` key, but all end tenants currently share one
HarnessaaS platform budget envelope. An SDK must not forward the inbound key,
and the service must make tenant attribution, reservation, commit, and
reconciliation explicit.

Current receipt, lineage, and conformance evidence is not independently verifiable:

- `CostReceipt` sums route tokens and floating USD cost (`src/receipt.ts:8-46`),
  but has no schema version, currency/finality, signature, or meter-source
  discriminator. Some costs are estimated.
- lineage declares canonical JSON and SHA-256 hashing (`src/lineage.ts:10,93`),
  but its read API does not return a full proof or signed anchor. A privileged
  chain rewrite can therefore be internally consistent.
- conformance isolation is structurally useful, but its attestation is
  unsigned, unversioned, and lacks an oracle policy/build digest.

`src/webhooks/*` events include `gate.decision`, `business.promotion`, and
`acceptance.completed`. Payloads are Ed25519-signed, but the signer lazily
generates a process-local key (`src/webhooks/signer.ts:34`), so verification
breaks across replicas/restarts and there is no key ID. Delivery is described
as fire-and-forget on the synchronous route (`src/server.ts:367-408`). The SSRF
guard explicitly performs no DNS lookup (`src/webhooks/ssrf.ts:7-8`); its URL
validation checks only scheme, credentials, hostnames, and literal addresses
(`src/webhooks/ssrf.ts:58-80`). DNS rebinding and redirect SSRF remain possible.

`src/server.ts:534-535` has two consecutive returns in `createApp`; the first
makes the webhook-bearing return unreachable. The documented deployed revision
predates reviewed head. Repository source is not proof of running behavior.

ADR-0027a defines durable jobs, events, approvals, cancellation, and artifacts.
This ADR defines the minimum execution and trust properties those APIs require.

## Decision

HarnessaaS submission fails closed unless the authenticated runtime advertises
and enforces an accepted isolation profile. Receipts, conformance, lineage, and
webhooks use versioned canonical envelopes and stable service keys. Poll/job
state remains authoritative; webhooks are durable notification, not the sole
completion record. No SDK labels evidence `verified` without cryptographic
validation and an accepted key policy.

### D1. Credential and tenant boundary

The end-to-end authority chain is:

~~~text
end-tenant credential -> HarnessaaS admission/job
HarnessaaS workload identity -> queue, artifact, lineage, key services
HarnessaaS Meta LLM service credential -> model calls
opaque delegated subtenant -> attribution, never authentication by itself
ephemeral worker capability -> exactly one job's bounded resources
~~~

The SDK sends only the HarnessaaS credential to the normalized HarnessaaS
origin. The service must never forward it to Meta LLM, Git, artifact URLs,
webhooks, or the worker. Outbound Meta LLM uses the service credential plus
server-derived opaque tenant attribution. Logs, events, receipts, lineage, and
errors contain no raw credential.

Each job, approval, artifact, receipt, lineage proof, webhook, idempotency
record, and budget entry is keyed by authenticated account/tenant. Foreign IDs
are indistinguishable from absent IDs. A delegated subtenant is accepted only
under a scoped credential and participates in idempotency and budget identity.

The worker receives a short-lived capability scoped to job ID, input/artifact
digests, allowed operations, expiry, and output destination. It receives no
control-plane, signing, webhook, database, queue-administration, or long-lived
Meta LLM key.

### D2. Isolation capability and fail-closed admission

The runtime publishes:

~~~text
ExecutorIsolationCapability {
  level: none | process | container | microvm
  state: supported | degraded | unavailable
  worker_build_digest
  policy_digest
  controls: {
    user_namespace, filesystem, process_tree, seccomp,
    network_default_deny, metadata_deny, secret_free_env,
    cpu, memory, pids, open_files, file_bytes, disk_bytes,
    inodes, artifact_total_bytes, wall_time
  }
  observed_at
}
~~~

Stable submit requires `state=supported` and a contract-approved `container`
or `microvm` profile with every required control true. `process`, unknown,
degraded, stale, or static documentation is insufficient for hosted arbitrary
commands. A fresh server capability is checked before submit and its
build/policy digest is recorded in the job and attestation.

If worker admission later discovers a mismatch, the job fails with
`IsolationUnavailableError` before clone/test/model work. There is no plain
execution fallback, generic `force`, approval, or consent that can weaken this
gate. Health reports actual worker enforcement, not merely kernel feature
availability in the API container.

Preview deployments may expose read-only APIs while isolation is unavailable.
They may not accept a job and add an `unisolated` warning afterward.

### D3. Worker filesystem, process, environment, and network

Every job gets a new unprivileged identity, process namespace, writable
workspace, and artifact staging area. Source input is immutable by digest;
work occurs on a copy/overlay. The host filesystem, other jobs, control-plane
sockets, container runtime, service account token, and signing keys are not
mounted.

The environment is built from a small allowlist. It excludes inbound/outbound
credentials, cloud metadata tokens, provider keys, database/queue credentials,
webhook secrets, signing keys, CI secrets, Git helpers, SSH agent, and host
proxy variables. Named test environment values use scoped secret references
only when the contract and tenant policy permit them; values are neither
lineage nor diagnostics.

Network is default deny. DNS and all IP families are controlled at the egress
boundary; loopback escape, RFC1918/4193, link-local, metadata ranges, cluster
services, Unix sockets, and DNS rebinding are blocked. A task-specific egress
grant names destination, protocol, port, expiry, and purpose and is recorded in
lineage. Package installation is prebuilt or separately approved; failure does
not enable open internet.

Commands use argv, not SDK shell interpolation. The worker owns/reaps the full
process tree. Current source defaults—600-second test/scanner timeout,
900-second build timeout, 3,600 CPU seconds, 512 processes, and approximately
2 GiB file limit—must be published as enforceable contract limits or replaced
with stricter values. The SDK reflects actual limits in capabilities and
planning; it does not promise them from documentation.

Outputs reject links/devices/sockets/path escapes/undeclared mounts. Aggregate
workspace bytes, inodes, open files, artifact bytes, and per-file limits are
enforced during execution and ingestion. Cancellation/limit reaps descendants
before lease release.

### D4. Meta LLM, budget, and metering boundary

HarnessaaS is the execution/orchestration authority; Meta LLM is the model and
metering authority defined by ADR-0024b. For each route:

- HarnessaaS sends a service credential, server-derived tenant attribution,
  job/request IDs, declared tier, and budget reservation reference;
- inbound tenant credentials and repository secrets are never forwarded;
- model response request ID, route/tier/model, token usage, cache/batch state,
  ledger reference, meter source, and finality are preserved;
- cancellation prevents new routes and attempts to cancel supported remote
  operations, but already observed usage remains;
- one tenant cannot consume another tenant's reservation or receipt.

If Meta LLM cannot produce authoritative metering, the receipt labels the
observation `estimated` or `unknown`. Success does not upgrade it. A shared
HarnessaaS account-level budget remains an operational ceiling, not a substitute
for tenant reservation/commit enforcement.

### D5. Execution receipt

HarnessaaS uses ADR-0028 `ExecutionReceiptV1` plus this signed payload:

~~~text
HarnessAasReceiptPayloadV1 {
  receipt_id, revision, job_id, tenant_subject_hash
  request_digest, source_commit_or_digest
  submitted_at, started_at, completed_at
  terminal_state
  routes: [{
    sequence, tier, model, model_request_id
    token_usage, cache, batch, latency
    cost: {amount_decimal, currency, meter_source, finality}
    ledger_reference?
  }]
  reservation, committed_cost, reconciled_cost?
  artifact_digests, conformance_digest, prior_lineage_root
  predecessor_receipt_digest?
  isolation_level, worker_build_digest, policy_digest
}
~~~

Money is decimal, never binary float. `meter_source` is
`ledger|provider|estimated|mock|unknown` and finality is
`provisional|committed|reconciled|reversed|unknown`. Missing currency, source,
or finality prevents authoritative aggregation.

The envelope declares schema, canonicalization, digest algorithm, signature
algorithm, key ID, payload digest, issued time, and signature. V1 uses
RFC 8785 JSON canonicalization, SHA-256, and Ed25519. This is independent from
the OSS MetaHarness witness format. A provisional receipt may be signed as an
authentic provisional observation; it is not final cost.

Every terminal receives a receipt, including partial/zero usage. Receipts are
immutable: `listReceipts` returns ordered history and `getReceipt(ref)` one
exact revision; reconciliation appends a successor and never overwrites.
A missing/not-yet-available receipt never means zero spend.

SDK verification uses ADR-0028 levels `none|shape|digest|cryptographic|anchored`
with reason/warnings. Reconciliation remains cost `finality`, not a verification
level; a valid signature never makes an estimated amount authoritative.

### D6. Conformance attestation

`ConformanceAttestationV1` includes:

~~~text
job_id, request/source/result/patch/test-output digests
oracle policy digest, oracle build digest, grading rubric version
solve-window open/close, observed route IDs, terminal verdict
isolation profile/build/policy, artifact digests
issued_at, schema, canonicalization, key_id, signature
~~~

The service signs the attestation only after the solve window closes and all
referenced digests are fixed. The private oracle may remain opaque; its policy
identity and output binding may not. Regrading creates a new attestation with
an explicit predecessor, never overwrites the original.

`resolved=true` without a valid attestation is a result claim, not verified
conformance. SDK convenience accessors preserve that distinction.

### D7. Lineage proof and independent anchor

The current per-tenant hash chain is retained as an internal primitive, not the
complete proof. `LineageProofV1` returns:

~~~text
tenant subject hash, job_id, requested range
ordered_chain_or_merkle_path with record/payload digests
checkpoint {sequence, chain_tip, previous_checkpoint_digest?, issued_at, key_id, signature}
previous_checkpoint? {sequence, chain_tip, key_id, signature}
optional external_anchor {provider, reference, digest, timestamp}
receipt and conformance digests
~~~

Record hashes use canonical bytes and include tenant/job/domain separation.
The SDK recomputes every link and verifies the signed checkpoint against the
stable keyset and previous checkpoint/path when a range starts mid-chain.
Omitted job, untrusted middle, regression, evidence mismatch, or overrun fails.

Evidence order is artifacts, attestation, append/issue prior checkpoint,
receipt referencing that `lineage_root`, append receipt, then terminal
checkpoint. Reconciliation receipts reference predecessor and an already-issued
checkpoint, then are appended/checkpointed. No object references a descendant.

The service emits a checkpoint at terminal and at least every 100 records or
five minutes for longer chains. A database administrator can no longer rewrite
history without invalidating a retained checkpoint. An external transparency
or timestamp anchor is required before marketing uses `independently
immutable`; a service-signed checkpoint supports `tamper-evident to this key`.

### D8. Evidence keyset and rotation

`GET /v1/evidence/keys` returns a root-signed keyset:

~~~text
schema, issuer, root_key_id, canonicalization, signature
keys: [{
  key_id, algorithm=Ed25519, public_key_base64url, use
  not_before, not_after, status: active | retiring | revoked
  replacement_key_id?, revoked_at?, compromise_at?
  revocation_effective_at?, revocation_reason?
}]
~~~

`HarnessAasVerifier` requires `EvidenceTrustPolicy` containing either the root
public key/fingerprint pinned in ADR-0020's contract lock or an explicit caller
root. TLS retrieval alone is not trust bootstrap. The verifier validates the
RFC 8785 root signature before accepting child keys; without policy, evidence
cannot exceed `digest`.

Public keys encode exactly 32 Ed25519 bytes and signatures 64 bytes as unpadded
base64url. Private keys use managed storage, never API-process generation.
Every evidence object names key ID/use. Old public keys remain for maximum
evidence retention plus deprecation.

The SDK caches at most one hour and refreshes once for unknown key. Uses are
not interchangeable. Revocation evaluation uses `compromise_at` and
`revocation_effective_at` against evidence issue time; unknown/missing policy
fails closed.

### D9. Durable webhook contract

Webhook subscriptions are tenant resources under `/v1/webhooks` with explicit
event allowlist, HTTPS destination, retention consent, and optional filter.
V1 supports current events `gate.decision`, `business.promotion`, and
`acceptance.completed` plus capability-declared `job.terminal`,
`approval.required`, and `artifact.available`.

The versioned envelope contains:

~~~text
schema_version, event_id, event_type, delivery_id, attempt
tenant_subject_hash, job_id?, occurred_at, delivered_at
sequence?, data
~~~

V1 retains `X-Harnessaas-Event`, `X-Harnessaas-Delivery-Id`,
`X-Harnessaas-Timestamp`, and `X-Harnessaas-Signature` and adds event ID,
schema version, and key ID as `X-Harnessaas-Event-Id`,
`X-Harnessaas-Schema-Version`, and `X-Harnessaas-Key-Id`. Signed bytes are
UTF-8 timestamp, one `.` byte, then exact raw body. The verifier enforces known
key/use, unpadded-base64url signature, five-minute skew, `application/json`,
and a 1 MiB body limit before parsing.

`HarnessAasWebhookVerifier` requires atomic `ReplayStore.checkAndInsert(scope,
event_id, delivery_id, expires_at)`. Duplicate is returned without handler
execution; retention is at least 24 hours. An in-memory store is preview-only
and cannot claim restart/multi-instance replay protection.

The server writes an outbox record in the same transaction as the durable
event. A queue owns delivery independently of the API request. Default attempts
are immediate, 10 seconds, 1 minute, 5 minutes, and 30 minutes, each with a
5-second response timeout and jitter. A stable delivery ID is reused across
attempts; attempt increments. Exhaustion remains queryable and does not remove
the job event. Any 200–299 response acknowledges; timeout, 3xx (not followed),
or other status retries. Polling/SSE remains source of truth.

Server SSRF controls resolve DNS at registration and every connection, validate
all returned A/AAAA addresses, pin the allowed address for that connection,
block private/link-local/metadata/cluster ranges, and disable redirects.
Outbound firewall policy supplies a second control. The SDK validates syntax
but never claims client validation makes server fetch safe.

### D10. Data minimization and retention

Normal events, receipts, and lineage contain digests, bounded codes, opaque
IDs, and numeric usage—not source, patch bodies, prompts, model output, test
logs, environment, secrets, or full repository/webhook/artifact URLs. Content
resides in access-controlled artifacts with explicit retention and source/
artifact consent under ADR-0022.

Webhook data uses the minimum fields for the selected event. Receipt and
lineage telemetry follows ADR-0028 redaction. Deletion/tombstone behavior must
preserve accounting and security evidence without retaining prohibited content;
the contract declares which digests and signed records remain.

### D11. Current blockers and GA gate

HarnessaaS remains preview/blocked until:

1. hosted execution refuses plain `execSync` when the declared jail is absent;
2. worker isolation is measured at runtime and bound into every job;
3. service credentials/metadata/network are unreachable from hostile code;
4. tenant-level Meta LLM budget and meter provenance are enforceable;
5. receipt/conformance/lineage schemas, canonicalization, stable keys, and
   rotation/revocation policy are published;
6. a signed lineage checkpoint/proof API is implemented;
7. webhook keys are stable, delivery is outbox-backed, and redirect/DNS SSRF
   is closed;
8. evidence/artifact/content retention and redaction are executable;
9. the `createApp` unreachable-return regression is fixed and tested;
10. current-head behavior is deployed and identified by immutable build digest.

No SDK escape hatch may relabel a missing gate as verified. Read-only health,
capabilities, and legacy response inspection can remain preview.

## Migration and rollout

1. Remove hosted fail-open execution; publish an enforceable isolation profile
   and hostile-repository test image.
2. Separate inbound, service, worker, signing, and repository authorities; add
   tenant reservation/commit attribution.
3. Version receipt/conformance/lineage envelopes and deploy managed stable keys.
4. Add signed terminal checkpoints/proofs and SDK offline verification.
5. Replace fire-and-forget webhook delivery with transactional outbox/queue,
   stable signatures, replay metadata, and SSRF-safe egress.
6. Deploy an immutable build, run black-box and adversarial conformance, and
   record results under ADR-0030a.
7. Ship preview, then require at least 30 days and two deployments without an
   unresolved isolation, cross-tenant, duplicate-spend, signer, SSRF, or
   evidence-integrity severity-one defect before GA.

Existing unsigned receipts/lineage/webhooks decode with verification `none`.
They are never retroactively signed or upgraded. A legacy chain may be
checkpointed from a declared migration boundary, which does not authenticate
earlier records.

## Consequences

### Positive

- Untrusted code cannot inherit cloud authority merely because optional
  sandbox features are unavailable.
- Cost, conformance, and history can be verified offline to a stable key.
- Webhooks survive API response completion and replica changes.
- Tenant attribution and meter source remain visible end to end.

### Negative and quantified trade-offs

- Default-deny egress breaks tests that download dependencies; those workloads
  need prebuilt dependencies or narrow grants and must not silently get open
  internet.
- Five webhook attempts can create up to five times the single-attempt outbound
  traffic. The bounded schedule ends within roughly 36 minutes plus jitter.
- Checkpointing every 100 records reduces signature operations by up to two
  orders of magnitude versus signing every record, while terminal jobs still
  receive an immediate checkpoint.
- Digest verification is linear in artifact bytes and must stream; a default
  100 MiB SDK cap prevents unbounded memory/disk use.
- Isolation, managed keys, proofs, metering, and outbox delivery are estimated
  at 15–25 upstream engineering days plus 5–8 SDK days.

### Biggest failure mode and mitigation

The biggest failure mode is executing a hostile repository through the current
plain-process fallback, exposing service identity or metadata, then returning
an unsigned receipt and internally consistent lineage that callers mistake for
proof. Fail-closed container/microVM admission, secret-free capabilities,
default-deny egress, stable signed evidence, and explicit SDK verification
levels prevent both compromise and false assurance.

## Alternatives considered

| Option | Advantage | Defect | Why rejected |
|--------|-----------|--------|--------------|
| Keep best-effort sandbox with warning | Higher availability | Executes hostile code with control-plane authority | Isolation is a precondition, not telemetry |
| Trust hash chain without anchor | Simple | Privileged rewrite remains undetectable | Signed checkpoint/proof is required |
| Treat estimated cost as receipt | Always returns a number | Misstates accounting authority | Meter source/finality must survive |
| Generate signer key per replica | No key service | Cross-replica/restart verification fails | Stable managed keyset is required |
| Fire webhook after response | Small implementation | Scale-to-zero loses delivery | Durable outbox owns retries |
| Allow redirects after URL validation | Compatible callbacks | Redirect/DNS rebinding bypasses SSRF check | Redirects are disabled |

## Compliance and executable verification

1. **`isolation_fail_closed`:** missing control rejects before repo execution.
2. **`hostile_repository`:** network/metadata/secret/mount/sibling/link/daemon and CPU/memory/pid/disk/inode/open-file escapes all fail.
3. **`credential_canaries`:** every authority canary is absent from worker/output/observability/evidence.
4. **`tenant_budget`:** tenants cannot share reservations; inbound key never reaches Meta LLM.
5. **`meter_provenance`:** all source/finality/currency variants survive without promotion.
6. **`receipt_dag_tamper`:** mutate/reorder/overwrite predecessor, lineage root, field, decimal, artifact, key, or signature; verification fails.
7. **`attestation_binding`:** cross-job patch/test/oracle/isolation/artifact swaps fail.
8. **`lineage_rewrite`:** delete/reorder/splice/truncate/range/previous-checkpoint attacks fail.
9. **`key_rotation`:** pinned-root, encoding, use, time, compromise, replacement, and revocation cases match policy across restarts.
10. **`webhook_replay`:** raw/header/time/key/duplicate/restart races exercise atomic replay store before JSON.
11. **`webhook_outbox`:** crashes at every transition resume stable delivery and polling reconciliation.
12. **`webhook_ssrf`:** encoding/IPv6/rebinding/multi-answer/metadata/redirect/proxy attacks reach no protected listener.
13. **`retention_redaction`:** content canaries never enter normal events/evidence/telemetry/tombstones.
14. **`create_app_shape`:** `createApp` returns webhook dependencies once and routes match OpenAPI.
15. **`live_black_box`:** gated origin/build/policy/key IDs pass the full adversarial suite.
16. **`cross_language_evidence`:** canonical evidence/webhook verification levels/reasons agree.

### Executable acceptance test

First three jobs are offline; fourth upstream; fifth network/budget-gated.

~~~text
cd sdks/node   && npm test -- harnessaas-security-conformance
cd sdks/python && pytest -m harnessaas_security_conformance
cd sdks/rust   && cargo test --features harnessaas harnessaas_security_conformance
tests/agentic-conformance/harnessaas/run --mode upstream-adversarial --fake-clock --fake-dns --fake-model --protected-listener
HARNESSAAS_TEST_ORIGIN=... EXPECTED_BUILD_SHA=... EXPECTED_POLICY_SHA=... MAX_TEST_COST=... tests/agentic-conformance/harnessaas/run --mode deployment
~~~

Run a hostile deterministic repository concurrently for two tenants against
the release-candidate deployment. Remove one required jail control and prove
the job does not start. With controls restored, prove the worker cannot reach
metadata, network, service credentials, host/sibling files, or survive
cancellation. Complete one job, verify its receipt, attestation, artifacts, and
lineage offline in all three SDKs, then mutate one byte and rewrite the stored
chain; verification must fail. Restart signer/API replicas, crash webhook
delivery at every step, and perform DNS rebinding/redirect attacks; signatures
must remain verifiable, delivery reconcilable through polling, and protected
listeners untouched.

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
- ADR-0027a: HarnessaaS jobs, events, approvals, and artifacts
- ADR-0028: telemetry, traces, usage, cost receipts, lineage, and redaction
- ADR-0029: language packaging, features, and CLI
- ADR-0030a: conformance, CI, and release evidence
- ADR-0030b: migration, rollout, and publication
- `cognitum-one/harnessaas@908e4a99332617fd321d6f23a1d5a70e07413ffa`
