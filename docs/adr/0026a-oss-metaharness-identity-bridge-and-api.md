# ADR 0026a: OSS MetaHarness Identity, Structured Bridge, and Public SDK API

- **Status:** Proposed
- **Date:** 2026-07-18
- **Deciders:** Cognitum SDK Working Group, MetaHarness owners, Developer Experience, Release Engineering, Security
- **Scope:** cross-cutting (`sdks/node`, `sdks/python`, `sdks/rust`); local/server runtimes only

## Context

The requested `npx metaharness` integration is a local generator and verifier,
not an HTTP service. Its name currently collides with a different private
commercial product. The SDK must establish product identity before it can
define an API or make a trust claim.

The immutable source baseline in ADR-0019 contains three similarly named
artifacts:

| Artifact | Reviewed identity | Purpose | SDK treatment |
|----------|-------------------|---------|---------------|
| OSS MetaHarness | public npm package `metaharness`; repository version `0.4.1`; binaries `metaharness` and `harness`; Node 20+ | Generate, analyze, score, validate, sign, and inspect local harness workspaces | The target of this ADR |
| Cognitum MetaHarness | private `@cognitum-one/metaharness` version `0.1.0`; also binary `metaharness` | Commercial composition of Claude/Codex, router, Meta LLM, Meta Proxy, brains, and optimization | A separate product UX; never imported or launched by this client |
| MetaHarness authoring SDK | `@metaharness/sdk` | TypeScript DSL for harness definitions | Not a runtime or process client |

The OSS identity and runtime floor are declared at
`packages/create-agent-harness/package.json:2-3,22-26,121`.

At `ruvnet/metaharness@072b95c0:packages/create-agent-harness/src/index.ts`, the OSS generator exposes a useful
TypeScript `scaffold` function, 20 source-defined templates, and nine
source-defined hosts. Its full command surface is not one side-effect-free
library, however. Output is primarily human-oriented; there is no versioned
machine protocol with uniform progress, cancellation, output bounds, or
terminal errors (`packages/create-agent-harness/src/index.ts:63-89,210-294`).

Published npm is `metaharness@0.4.0` at review while the reviewed source
`package.json` manifest is `0.4.1`. `src/index.ts` stamps generator `0.1.0` and
`src/manifest.ts` stamps template `0.0.0`. The convenience library
`@ruvnet/agent-harness-generator@0.1.3` depends exactly on stale
`metaharness@0.1.5` and documents `result.files` although its implementation
returns `paths`, `manifestPath`, and `unresolved`.

The inconsistent stamps are visible at
`packages/create-agent-harness/src/index.ts:763` and
`packages/create-agent-harness/src/manifest.ts:24-55`.

Importing the private Cognitum CLI cannot solve this. `packages/cli/src/index.ts` invokes
`main()` and `process.exit`, and its status document explicitly acknowledges
the public/private binary collision. `npx cognitum metaharness` is a temporary
commercial entry point, not an alias for the OSS generator.

Witness behavior also requires a precise API. `src/witness-client.ts` implements a flat
schema-1 structure with hexadecimal Ed25519 key/signature fields. A materially
different proposed shape appears in MetaHarness ADR-011. If the native kernel
is unavailable, current `verifyWitness` can report structurally valid and
explicitly unverified. Publishing may be unsigned. The SDK must not map
absence, shape validation, and cryptographic verification to one `valid`
boolean (`packages/create-agent-harness/src/witness-client.ts:40-95`).

ADR-0019 requires separate bounded-context clients. ADR-0020 requires a neutral
contract rather than parsing implementation prose. ADR-0026b separately
governs exact npm acquisition, child-process containment, repository access,
and transactional filesystem mutation.

## Decision

Expose the OSS generator as `MetaHarnessClient` backed by a versioned JSON
Lines process bridge. For `MetaHarnessClient` operations, that bridge is the
only cross-language contract; it has identity `metaharness-oss` and no prompts.
`MetaHarnessClient` operations never compose Meta LLM, Meta Proxy, HarnessaaS,
or the private commercial CLI.

### D1. Product boundary and naming

The normative public namespaces remain those in ADR-0019:

| Language | Namespace |
|----------|-----------|
| Node | `@cognitum-one/sdk/metaharness` |
| Python | `cognitum.metaharness` |
| Rust | `cognitum_one::metaharness` behind feature `metaharness` |

Public documentation must use **OSS MetaHarness** when ambiguity is possible.
`MetaHarnessClient` means the local OSS bridge. It never means:

- the private `@cognitum-one/metaharness` CLI;
- the `@metaharness/sdk` authoring DSL;
- the stale `@ruvnet/agent-harness-generator` wrapper;
- HarnessaaS remote solve jobs;
- Meta Proxy lifecycle or routing.

No top-level generic `HarnessClient` or `metaharness` executable lookup is
introduced. The private commercial product may compose the four public
bounded-context clients in its own repository, but that policy does not enter
the general SDK.

The subpath MAY export `MetaHarnessProxyLifecycleProvider`, a separate
ADR-0025b adapter explicitly injected into `MetaProxyManager`. Its provider
JSONL request/result/event schemas come only from the pinned ADR-0025b lifecycle
contract bundle, not this bridge. Provider capabilities remain separate; it is
not a `MetaHarnessClient` method and Meta Proxy never imports it.

Constructors resolve configuration only. They perform no npm access, process
spawn, repository read, filesystem write, capability probe, login, or prompt.
Browser imports fail immediately with `UnsupportedRuntimeError` and perform no
loopback or registry I/O.

### D2. Public client operations

The three SDKs expose equivalent domain behavior:

~~~text
MetaHarnessClient
  capabilities() -> CapabilitySet
  listTemplates(), listHosts() -> descriptor lists
  analyzeRepository(...), scoreRepository(...) -> ProcessRun<analysis|score>
  planScaffold(request, context?) -> ProcessRun<ScaffoldPlan>
  scaffold(plan, approval, context?) -> ProcessRun<ScaffoldResult>
  inspectManifest(...), validateHarness(...), compareHarnesses(...) -> ProcessRun<T>
  verifyWitness(workspaceOrWitness, context?) -> ProcessRun<WitnessVerification>
  close()
~~~

`ProcessRun<T>` is a locally owned process operation:

~~~text
ProcessRun<T> {
  id, state
  events(), result(), cancel(reason?)
}
~~~

It is not a server-owned `OperationHandle`. Closing a client cancels only
processes owned by that client. It does not cancel a HarnessaaS job, stop Meta
Proxy, or kill a separately launched MetaHarness CLI.

`planScaffold` is non-mutating. `scaffold` accepts only a still-valid
`ScaffoldPlan` and matching `ApplyApproval`. It does not expose upstream
`force`. A plan-and-apply convenience is forbidden because it would erase the
review boundary. Signing, publishing, external template packages, and full
`from-existing` eject remain internal until their source behavior and trust
contracts are complete.

### D3. Public domain types

The facade defines at least:

~~~text
MetaHarnessConfig {
  distribution, workspace_policy, process_policy
  acquisition_timeout, handshake_timeout, operation_timeout
  diagnostic_policy, preview_features
}

RepositorySource =
  LocalRepository { canonical_path, expected_tree_digest? }
  | GitRepository {
      url, requested_ref?, resolved_commit_sha, credential_reference?
    }

ScaffoldRequestV1 {
  schema: "cognitum.metaharness.scaffold-request.v1"
  name, template, primary_host?, hosts, description?
  target, darwin, repository_source?
}

ScaffoldPlan {
  schema: "cognitum.metaharness.scaffold-plan.v1"
  plan_id, plan_digest, created_at, expires_at
  generator_identity, template_identity, repository_commit?
  canonical_target, target_before_digest, request_digest
  actions: List<FileAction>, unresolved_variables, warnings
  destructive, estimated_files, estimated_bytes
}

ApplyApproval {
  plan_digest, approved_at
  approved_by?       # opaque label, not an identity assertion
}

ScaffoldResult {
  schema: "cognitum.metaharness.scaffold-result.v1"
  plan_digest, manifest, files: List<GeneratedFile>
  target_after_digest, unresolved_variables, commit_outcome, verification
}

WitnessVerification {
  verification: VerificationResult        # ADR-0028 five-level result
  witness_schema?, manifest_digest?, entry_digests?, raw_unknown?
}
~~~

The actual manifest fields are preserved:
`schema`, `generator`, `template`, `template_version`, `vars`, `hosts`, `files`,
`generated_at`, and optional `meta`. Package version, generator version,
template version, bridge protocol, and source revision are independent. The
SDK does not infer one from another.

Types preserve unknown additive response fields and unknown event variants.
Unknown security-sensitive enums block the dependent mutation or trust claim.
`WitnessVerification(verification.level=shape, valid=true)` is never logged or
serialized as cryptographically verified.

### D4. Structured bridge

The upstream OSS package must publish a bridge command, provisionally
`metaharness bridge --stdio`; ADR-0020's bundle stores the exact spelling.
Stdin/stdout carry UTF-8 JSON Lines only. Stderr is a bounded, redacted
diagnostic channel. Human prose, ANSI, prompts, progress bars, and
content-bearing stacks are forbidden on stdout.

Every envelope contains:

~~~json
{
  "protocol": "cognitum.metaharness.bridge",
  "protocol_version": "1.0",
  "kind": "hello|request|cancel|event|result|error|shutdown",
  "message_id": "uuid",
  "reply_to": "uuid|null",
  "operation_id": "uuid",
  "sequence": 0,
  "sent_at": "RFC3339",
  "body": {}
}
~~~

The SDK sends `hello` before any operation. The response includes product
`metaharness-oss`, package name/version, source revision, bridge protocol
range, generator and Node versions, capabilities/limitations, and distribution
digest.

The SDK compares every field with the immutable distribution lock from
ADR-0026b. A private-commercial identity, absent identity, unsupported protocol
major, wrong source revision, or `latest` package value terminates the process
before repository or target access.

Each request names one operation and carries schema-validated parameters plus
ADR-0023 request context. Events have a strictly increasing sequence and use
`phase.started`, `phase.progress`, `diagnostic`, `warning`,
`artifact.planned`, `artifact.staged`, `artifact.committed`,
`verification.completed`, or `operation.cancel_requested`.

Hello and the one authoritative terminal `result|error` set `reply_to` to
their request `message_id`; terminal sequence is last-event sequence plus one.
There is no separate terminal event. Unknown events are preserved. Missing/
regressing sequence, bad correlation, duplicate terminal, invalid UTF-8/JSON,
cancel/commit-outcome contradiction, or schema mismatch is `ProtocolError`.

Default parser limits are:

| Limit | Default |
|-------|---------|
| Warm bridge handshake | 2 seconds |
| One JSONL envelope | 1 MiB decompressed UTF-8 |
| Buffered structured output | 16 MiB |
| Retained stderr | last 1 MiB |
| Event rate | 1,000/second before progress coalescing |
| JSON nesting | 64 |

Large diagnostics and artifacts use path-bound descriptors containing declared
media type, size, and SHA-256. Ordinary results never embed them past the JSON
limit. Limits may be reduced by callers and increased only through a named
bounded policy.

The first implementation starts one bridge per operation. A persistent worker
requires a future capability proving per-workspace state reset, memory bounds,
and cancellation isolation.

### D5. Errors, cancellation, and event semantics

Bridge errors map to ADR-0023 categories without losing:

~~~text
product
operation
operation_id
bridge protocol
package/source identity
machine code
retryability
phase
target mutation outcome
redacted field path
bounded diagnostics reference
~~~

The bridge publishes a machine code and retry hint; the SDK remains
authoritative about whether a local retry is safe. Catalog and immutable
analysis reads may be retried only after no mutation starts. Planning can be
repeated from the same inputs. Scaffold apply is never automatically retried.

Cancellation is a control envelope, not an EOF guess. The process manager in
ADR-0026b escalates cooperative cancellation to process-tree termination.
There is one terminal process outcome:

~~~text
succeeded
failed
cancelled_before_commit
cancelled_after_commit
indeterminate_mutation
~~~

`cancelled_after_commit` returns the committed result and a cancellation flag;
it does not pretend rollback occurred. `indeterminate_mutation` is a
high-severity error and blocks automatic recovery or another apply until the
transaction is inspected.

Events are local telemetry inputs subject to ADR-0028. Source text, rendered
file bodies, environment values, credentials, and raw repository URLs are
content-sensitive and absent by default. Diagnostics use opaque file IDs and
workspace-relative paths.

### D6. Determinism, manifests, and witness truth

The upstream bridge must correct package/generator/template version stamping.
It uses deterministic ordering and a bridge-provided clock; conformance
fixtures set `SOURCE_DATE_EPOCH`. Given the same distribution, template,
request, repository commit, and clock, supported platforms produce identical
bytes except for explicitly declared platform files.

Verification levels are normative:

| Level | Claim |
|-------|-------|
| `none` | No witness was supplied |
| `shape` | Required fields, encodings, and digest forms validate; no signature trust claim |
| `digest` | Manifest/file bytes match expected digests; issuer is not proven |
| `cryptographic` | Canonicalization, entry hashes, signature, algorithm, and trusted-key policy validate |
| `anchored` | Cryptographic verification plus an independently durable checkpoint/proof |

If the native kernel is unavailable, the maximum level is `shape`. Unknown
schema, key, algorithm, canonicalization, or the alternate proposed
MetaHarness ADR-011 shape fails closed for `cryptographic`/`anchored`. Unsigned publishing
is never described as witnessed. The local hash-chained run log in the
`harness` package is not a HarnessaaS cost receipt or independently anchored
lineage.

### D7. Capabilities, exposure, and current blockers

Every method declares its prerequisite and evidence owner:

| Method | Required capability | Evidence owner |
|--------|---------------------|----------------|
| catalog methods | `metaharness.catalog.templates` / `metaharness.catalog.hosts` | Bridge + pinned bundle |
| analyze / score | `metaharness.repository.analyze` / `metaharness.repository.score` | Bridge + pinned bundle |
| plan | `metaharness.scaffold.plan` | Bridge |
| scaffold | `metaharness.scaffold.render` plus ADR-0026b integrity/commit mode/recovery | Bridge + SDK platform probe |
| inspect / validate / compare | `metaharness.manifest.inspect` / `metaharness.harness.{validate,compare}` | Bridge |
| verify witness | `metaharness.witness.{shape,digest,ed25519,anchor}` at requested level | Bridge/kernel + SDK trust policy |
| cancellation | `metaharness.process.cancel` | Bridge + SDK process manager |

The optional Proxy provider advertises a separate
`meta-proxy.lifecycle-provider.v1` capability and per-operation
`meta-proxy.lifecycle.*` capabilities defined by ADR-0025b. Their absence does
not reduce `MetaHarnessClient` capabilities and never exposes Proxy operations
through that client.

Runtime claims intersect the exact compatibility table; unknown distributions
receive no mutation, installation, signature, or publish capability.

| Surface | Exposure/status |
|---------|-----------------|
| Exact identity and capabilities | Preview |
| Catalog, manifest, analysis, score | Preview after bridge fixtures |
| Scaffold planning | Preview after deterministic plan fixtures |
| Scaffold apply | Blocked until applicable ADR-0026b commit/cancel gates pass |
| Witness shape inspection | Preview |
| Cryptographic verification | Blocked pending canonical schema and key policy |
| Sign/publish, external templates, full eject | Internal/blocked |
| Private commercial CLI | Out of scope |

Current upstream blockers are:

1. reviewed `0.4.1` is not published at the registry state;
2. no versioned JSONL bridge covers the SDK operations;
3. package/generator/template versions disagree and output/cancel is nonuniform;
4. `from-repo` is mutable and unresolved variables do not fail by default;
5. witness docs, runtime shape, verification, and publish claims disagree;
6. wrapper result/dependency is stale and private CLI collides/process-exits;
7. external-template and full-eject flags overstate implemented behavior.

Until blockers 1 through 7 close, a released SDK may offer only a feature-
flagged, read-only development preview with the exact verified distribution.

## Migration and rollout

1. Publish bridge schemas, fixtures, identity handshake, corrected version
   stamps, and exact release artifacts.
2. Pin the contract and distribution under ADR-0020 and ADR-0026b.
3. Ship identity, capabilities, catalog, analysis, scoring, manifest, and
   shape-verification preview.
4. Add deterministic planning preview.
5. Enable mutation only after ADR-0026b's filesystem/process gates pass on
   each supported platform.
6. Enable cryptographic verification only after canonical schema/key-policy
   conformance.
7. Require two consecutive exact releases and at least 30 preview days with no
   unresolved data-loss, identity, secret, or trust-severity defect before GA.

Existing interactive `npx metaharness` users are unaffected. The SDK does not
take ownership of their npm cache or process. A future reusable commercial core
must have a distinct package/product identity, side-effect-free import, and its
own contract review.

## Consequences

### Positive

- One implementation supplies semantics to all languages.
- The bridge proves which MetaHarness product and version is executing.
- Public types make planning, unresolved variables, and verification level
  explicit.
- Machine errors/events replace brittle prose parsing.

### Negative and quantified trade-offs

- One bridge per operation adds startup. Acquisition is removed from normal
  operation latency; a verified warm handshake must meet 2 seconds p95 in CI.
- JSON framing limits ordinary structured results to 16 MiB and events to
  1 MiB, requiring descriptor-backed diagnostics.
- Supporting one protocol and fixtures upstream is estimated at four to eight
  engineering days before read-only preview.
- The strict API exposes fewer commands than the current CLI until each command
  gains a stable machine contract.

### Biggest failure mode and mitigation

The biggest failure mode is mistaking the private commercial CLI, stale
wrapper, or mutable `latest` package for the reviewed OSS generator, then
surfacing incompatible output or false verification as trusted SDK behavior.
Stable product identity, exact handshake fields, a neutral bridge, capability
intersection, and three-level witness results prevent that confused deputy.

## Alternatives considered

| Option | Advantage | Defect | Why rejected |
|--------|-----------|--------|--------------|
| Parse human CLI output | No upstream work | Prose/ANSI/localization drift; no reliable cancellation | Cannot be a cross-language contract |
| Import stale wrapper | Small Node implementation | Wrong dependency and result docs; no Python/Rust parity | Not authoritative |
| Import private CLI | Includes commercial composition | Private, process-exiting, binary collision, policy coupling | Violates ADR-0019 |
| Bind `@metaharness/sdk` | Typed TypeScript | It is an authoring DSL only | Wrong bounded context |
| Reimplement generator in three languages | No child process | Three template engines drift immediately | One bridge is cheaper and testable |

## Compliance and executable verification

CI runs these fixtures in Node, Python, and Rust:

1. **`identity_collision`:** malicious same-name PATH/commercial identities
   cannot proceed; only exact OSS identity can.
2. **`side_effect_free_construction`:** instantiate the client and assert zero
   registry, process, repository, filesystem, prompt, or network activity.
3. **`bridge_framing`:** hostile framing/correlation/sequence/terminal fixtures
   produce bounded equivalent `ProtocolError` values.
4. **`bridge_identity`:** vary product, package, version, commit, protocol,
   Node version, and digest; assert rejection before repository/target access.
5. **`golden_scaffold_contract`:** freeze clock and commit; compare upstream
   library, bridge, and three SDK domain outputs and manifest fields.
6. **`unknown_compatibility`:** additive data is preserved; unknown security
   enums fail closed.
7. **`witness_levels`:** exercise all ADR-0028 levels, tamper, unknown schema/
   key, and no-kernel; only fixture-supported minimum levels pass.
8. **`cancel_terminal`:** cancel in each bridge phase and assert exactly one of
   the normative terminal outcomes with no second result.
9. **`dependency_guard`:** private CLI/DSL/wrapper/unqualified binary are absent.
10. **`language_parity`:** domain results/errors agree for the complete corpus.
11. **`browser_guard`:** browser import fails before I/O; remote bundles contain
    no process code.

### Executable acceptance test

~~~text
cd sdks/node   && npm test -- metaharness-bridge-conformance
cd sdks/python && pytest -m metaharness_bridge_conformance
cd sdks/rust   && cargo test --features metaharness metaharness_bridge_conformance
~~~

With malicious same-name executables on `PATH` and alternating OSS/commercial
bridge identities, run identical fixtures in all SDKs. Only the locked OSS
identity may access source; results/events/errors/versions/trust must agree.
One changed witness byte removes cryptographic status; construction does no I/O.

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
- ADR-0026b: MetaHarness process, filesystem, and npm/npx supply chain
- ADR-0028: telemetry, traces, usage, cost receipts, lineage, and redaction
- ADR-0029: language packaging, features, and CLI
- ADR-0030a: conformance, CI, and release evidence
- ADR-0030b: migration, rollout, and publication
- `ruvnet/metaharness@072b95c0a74610de008dca5473343a81619cef20`
- `cognitum-one/metaharness@fc8845f3bfdb67f1ab6d99547cc98e3b57717029`
