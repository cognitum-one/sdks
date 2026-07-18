# ADR 0026b: MetaHarness Process, Filesystem, and npm/npx Supply Chain

- **Status:** Proposed
- **Date:** 2026-07-18
- **Deciders:** Cognitum SDK Working Group, MetaHarness owners, Release Engineering, Security, Developer Experience
- **Scope:** cross-cutting (`sdks/node`, `sdks/python`, `sdks/rust`); local/server runtimes only

## Context

ADR-0026a selects the public OSS npm package `metaharness` as the local bridge.
That identity is distinct from the private, process-exiting
`@cognitum-one/metaharness` commercial CLI, despite both claiming the
`metaharness` binary name. It is also distinct from the
`@metaharness/sdk` authoring DSL and remote HarnessaaS.

At the 2026-07-18 review, `ruvnet/metaharness` source reports `0.4.1` but npm
serves `0.4.0`. Unqualified `npx metaharness` resolves mutable registry state
and may run package lifecycle code with the caller's environment. A global
`PATH` lookup can choose the private CLI or an attacker-controlled binary.
These are unacceptable defaults for an SDK that reads proprietary source and
writes a workspace.

The current `packages/create-agent-harness/src/writer.ts` stages output but `force` recursively
removes the old target before final rename. On cross-device rename it copies
non-atomically. Failure after removal can lose the prior tree. The generator
may also write with unresolved variables. `src/index.ts` `from-repo` shallow-clones mutable
HEAD without a commit pin, and no uniform cancellation contract proves whether
a partially running process committed. The destructive and EXDEV paths are at
`packages/create-agent-harness/src/writer.ts:30-68`.

The SDK therefore needs a supply-chain lock, secret-free process boundary,
immutable repository identity, reviewable plan, and crash-recoverable
transaction. ADR-0026a owns the
public API and bridge frames; this ADR owns everything between selecting a
distribution and returning a proven filesystem outcome.

## Decision

Execute only a content-verified exact OSS distribution from an SDK cache. Spawn
without shell/ambient secrets and restrict paths to explicit roots. Separate
planning from an approved, journaled same-filesystem transaction. Claim atomic
visibility only for new-target rename or a proven exchange/pointer primitive;
never expose `force` or cross-device copy fallback.

### D1. Distribution contract and resolution modes

`MetaHarnessDistribution` has three explicit modes:

~~~text
PinnedNpmDistribution {
  package: "metaharness"
  version
  registry_origin
  tarball_integrity_sha512
  dependency_lock_sha256
  entrypoint_sha256
  source_revision
  bridge_protocol
  node_range
}

BundledVerifiedDistribution { ...the same immutable identity fields... }

ExplicitDevelopmentExecutable {
  absolute_path
  expected_identity
  allow_unverified_read_only
}
~~~

Acquisition is exposed separately from `MetaHarnessClient`:

~~~text
MetaHarnessDistributionManager
  inspect(lock) -> DistributionPlan
  acquire(plan, DistributionAcquisitionApproval, context?) -> VerifiedDistribution
  listCached() -> List<VerifiedDistribution>
  prune(selection, approval) -> PruneResult
~~~

The approval binds lock digest, registry origin, maximum download bytes, and
expiry. Client construction and ordinary operations never imply it.

Normal releases use the MetaHarness entry in `specs/agentic/lock.json` from
ADR-0020. The lock contains:

- exact package name and SemVer without `^`, `~`, tag, or range;
- canonical registry origin and resolved tarball URL;
- npm SHA-512 integrity and optional registry provenance/signature evidence;
- every transitive package's exact name/version/tarball URL/integrity and the
  whole dependency-lock digest; Git/file/workspace dependencies are forbidden;
- bridge entrypoint SHA-256;
- immutable source commit;
- supported Node and bridge protocol ranges.

The SDK never executes an unqualified `metaharness` or `harness` from `PATH`,
nor `npx metaharness`, `npx metaharness@latest`, or a package inferred from a
project dependency. Documentation may retain `npx metaharness` as an
interactive user workflow, but the SDK does not use it internally.

An explicit development executable must be an absolute path and still pass the
ADR-0026a product handshake. Unless its digest is in a reviewed development
policy, it reports source `unverified-development` and can perform only
read-only discovery/analysis. It cannot scaffold, sign, publish, or claim
cryptographic verification.

The reviewed source `0.4.1` must not be represented by registry `0.4.0`.
Source-HEAD execution is permitted only in repository conformance tests.

### D2. Verified acquisition and cache

Acquisition is an explicit distribution-manager operation, never a constructor
or ordinary method side effect:

1. acquire a cross-process lock keyed by the full distribution digest;
2. download into a user-private temporary directory from only the locked
   registry origin;
3. reject embedded URL credentials, cross-origin redirects, mutable metadata,
   and digest mismatch;
4. disable root and transitive npm lifecycle scripts;
5. safely extract and materialize exactly the locked dependency closure;
6. verify package, dependency-lock, and entrypoint digests;
7. record immutable product/source/protocol identity;
8. atomically rename the completed directory into the executable cache;
9. invoke normally with package-manager networking disabled.

Before materialization, archive readers bound entry count and expanded bytes
and reject absolute/traversal paths, symlink/hard-link/device/FIFO/socket
entries, compression bombs, duplicate or case/Unicode-colliding names, and
unsafe modes. Each transitive tarball is verified before extraction.

The cache and its ancestors must not be group/world-writable. Ownership,
permissions, hard-link count, identity record, and entrypoint digest are
revalidated before spawn. A changed entry is quarantined and reacquired; it is
never repaired while another process may execute it. Concurrent acquisition
produces one complete cache entry.

If a dependency requires install-time code, the upstream distribution must
provide a reviewed, integrity-pinned prebuilt artifact or remain blocked.
Enabling lifecycle scripts is not an SDK option. Cache pruning is explicit,
reports reclaimed bytes, respects active leases, and cannot delete a running
distribution.

The SDK does not implicitly install Node. It selects an exact caller-provided or
SDK-configured executable satisfying the locked range and records its version.
A future Node installer requires a separate signed lock and explicit consent.

### D3. Process environment, limits, and ownership

Node, Python, and Rust invoke the same verified ADR-0026a bridge. Spawning uses:

- argv arrays with `shell=false`;
- the verified absolute Node and bridge paths;
- a canonical operation-specific working directory;
- piped stdin/stdout/stderr, never an inherited terminal;
- a minimal allowlisted environment under ADR-0022;
- fixed locale/timezone for deterministic protocol behavior;
- no inherited npm config, global Git config, credential helper, SSH agent,
  shell startup, `NODE_OPTIONS`, or preload hooks;
- a new process group or Windows job object;
- platform resource limits and bounded diagnostic capture;
- redacted telemetry under ADR-0028.

Cloud, Meta LLM, HarnessaaS, Meta Proxy, provider, source-control, cloud-vendor,
and CI secrets are absent by default. A repository credential is a
short-lived, operation-bound mount/reference, never argv, environment, URL,
manifest, event, or error text.

Startup, handshake, operation, and cancellation budgets are distinct.
Cancellation follows:

1. send ADR-0026a `cancel` and close the commit gate;
2. wait at most 1 second for cooperative acknowledgement;
3. terminate the process group and wait at most 2 seconds;
4. force-kill the group and wait at most 2 more seconds;
5. reap the process tree within the 12-second process budget;
6. attempt transaction recovery under a separate 30-second default budget.

No descendant may survive terminal return. If a commit occurred, cancellation
returns the committed result marked `cancelled_after_commit`. If old/new state
cannot be proven or recovery exceeds its budget, preserve the journal/trees,
return `IndeterminateMutationError`, and block apply until explicit recovery.
Closing a client affects only processes it owns.

### D4. Repository acquisition

`WorkspacePolicy` declares source and output roots separately. Local sources
must remain beneath an allowed source root under component-by-component
no-follow resolution.

Remote repositories:

- use only contract-approved Git schemes;
- reject embedded credentials, local-file URLs, option-like inputs, and
  unsupported ambiguous scp syntax;
- resolve a requested ref to a full commit SHA before analysis;
- fetch/check out exactly that SHA into an isolated directory;
- record remote identity and resolved SHA in plan/result;
- disable hooks, global/system configuration, submodules, LFS smudge, and
  credential helpers unless a separately reviewed capability enables one;
- do not execute package scripts, builds, tests, repository binaries, or
  repository configuration during MetaHarness analysis.

A moving branch/tag without a resolved SHA is read-only preview and cannot feed
an apply. If the resolved object disappears, the operation fails; it never
substitutes current HEAD. Authenticated source requires explicit source-access
consent from ADR-0022.

### D5. Workspace policy and non-mutating plans

Planning validates template, hosts, variables, paths, collisions, sizes, and
existing target without writing. Default policy requires:

- an explicit allowed output root;
- target is a strict descendant, never the allowed root;
- reject filesystem root, drive root, home, current directory, repository root,
  and transaction directory as targets;
- no-follow resolution for every component and revalidation at apply;
- reject symlink/junction/mount escape, hard-link surprise, special device,
  socket, FIFO, absolute generated path, and `..` escape;
- contract limits on file count, path length, per-file size, and total size;
- case-fold and Unicode-normalization collision checks on relevant platforms.

The plan digest commits to the canonical request, generator and template
identities, repository commit, target identity/preexisting-tree digest, every
file action, warning, limit, and policy. It reports estimated files, bytes, and
peak staging disk. Unresolved variables make the plan non-applicable by
default.

Apply requires `ApplyApproval.plan_digest`. It rehashes/re-resolves all
committed inputs under an exclusive target transaction lock. A changed byte,
path, symlink, source commit, distribution, template, or policy expires the
plan before staging.

### D6. Transactional commit and recovery

Stage in the target parent filesystem. Create/hash every file, then persist and
fsync a `prepared` journal containing paths, old/new digests, plan, and intended
primitive **before** the first namespace mutation. Directory fsync or an
equivalent durability primitive is mandatory; without it, crash-durable
mutation capability is unavailable.

For a new target, one staged-to-target rename is atomically visible. Existing
target replacement is atomically visible only with a tested exchange rename
(for example `RENAME_EXCHANGE`) or versioned-pointer primitive. The journal
records/fsyncs `exchanged`, `committed`, and `cleaned` transitions.

Without such a primitive, a preview `transactional-replace` may rename old to
backup, fsync/journal `old_moved`, rename stage to target, then fsync/journal
`new_installed` and `committed`. External readers can observe target absence;
the plan and result must say `atomic_visibility=false`. This path requires a
risk-specific approval and is recoverable, not atomic.

`CommitOutcome` records mode (`atomic_create`, `exchange_replace`, or
`transactional_replace`), visibility/durability/recovery flags, and retained
journal ID.

Cross-device copy is forbidden. Recovery validates the prepared journal and
trees, completes/rolls back only an unambiguous state, and otherwise preserves
both with `IndeterminateMutationError`. It never guesses by timestamp. The
backup is removed only after committed state is durable.

The result's manifest and file hashes describe the committed bytes, not the
staging tree. Transaction files are excluded from ordinary catalog/analysis
and never left world-readable.

### D7. Determinism and bounded resources

Conformance fixes the clock with `SOURCE_DATE_EPOCH` and requires deterministic
file/action ordering. Given identical package, dependency lock, Node major,
template, request, repository commit, policy, and clock, output digests are
identical except for contract-declared platform files.

Default safety bounds are contract-backed and configurable downward:

| Resource | Default |
|----------|---------|
| Structured output | 16 MiB |
| One JSONL message | 1 MiB |
| Retained stderr | last 1 MiB |
| Cooperative/terminate/kill | 1/2/2 seconds |
| Generated file/total bytes | must be declared by the pinned contract |
| Generated file count/path length | must be declared by the pinned contract |

No unbounded upstream default becomes an SDK default. A request exceeding the
contract fails during planning. Large diagnostics are artifact descriptors
with digest/media type/size and are read only through an explicit bounded sink.

### D8. Capability and release gates

Every mutation requires this common intersection:

~~~text
metaharness.distribution.integrity
metaharness.scaffold.plan
metaharness.scaffold.durable-journal
metaharness.process.cancel
metaharness.transaction.recovery
~~~

Remote-source mutation additionally requires `metaharness.repository.commit-pin`.
Creating a new target requires `metaharness.scaffold.atomic-create`. Stable
replacement requires `metaharness.scaffold.exchange-replace`; the explicitly
opted-in preview replacement may instead require
`metaharness.scaffold.transactional-replace`. The latter never satisfies an
atomic-visibility requirement. Unknown/degraded capability blocks apply;
generic force cannot override it.

Current blockers are the unpublished reviewed `0.4.1`, absent structured
bridge, mutable `from-repo`, destructive force path, EXDEV copy fallback,
unresolved-variable behavior, missing process cancellation, and inconsistent
version/provenance fields. Read-only preview may proceed only after exact
distribution identity and secret-free process fixtures pass.

## Migration and rollout

1. Upstream implements planning, cancellation, immutable Git input, durable
   journal/recovery, atomic create/exchange where available, and provenance.
2. Release Engineering publishes one exact package/dependency contract and
   reproducible content-addressed fixture.
3. SDKs ship explicit acquisition and read-only execution preview.
4. Planning ships after zero-write and deterministic parity tests.
5. Apply ships per platform/filesystem only after the complete fault-injection
   matrix passes; unsupported filesystems remain read-only.
6. GA follows ADRs 0030a/0030b after two exact releases and 30 preview days without an
   unresolved data-loss, secret-leak, identity, or process-escape defect.

No migration adopts the user's global npm cache, current `PATH` binary, or
existing MetaHarness process. Interactive `npx` behavior remains independent.

## Consequences

### Positive

- Registry movement and the public/private binary collision cannot change SDK
  execution identity.
- Secrets do not cross the child-process boundary by ambient inheritance.
- Mutable Git refs cannot silently change generated output.
- Every apply has a reviewed plan and a proven old/new filesystem outcome.

### Negative and quantified trade-offs

- A cold interactive `npx` commonly adds roughly 0.5–3 seconds before work;
  verified acquisition is therefore explicit and outside operation latency.
  Warm bridge handshake has a 2-second p95 CI budget.
- Exact version caches duplicate dependency trees. Cache usage is observable
  and explicitly prunable rather than silently shared with global npm.
- Replacement temporarily requires approximately generated target size plus
  the existing target and journal overhead; the plan reports peak bytes.
- Crash-recoverable mutation and cross-platform recovery are estimated at five to
  ten engineering days beyond the bridge work.
- Refusing EXDEV copy means some mounted/network filesystems remain read-only.

### Biggest failure mode and mitigation

The biggest failure mode is a tampered or wrong same-name npm binary inheriting
developer credentials and deleting the wrong workspace through `force`. This
combines supply-chain compromise, data exfiltration, and irreversible local
loss. Exact package/dependency/entrypoint integrity, no PATH/shell resolution,
minimal environment, explicit roots, digest-approved plans, and journaled
same-filesystem commit jointly mitigate it.

## Alternatives considered

| Option | Advantage | Defect | Why rejected |
|--------|-----------|--------|--------------|
| Run `npx metaharness` for every method | Familiar and small | Mutable/networked resolution, scripts, secrets, collision | Not reproducible or contained |
| Trust global npm cache/PATH | Fast warm start | Writable shared state and ambiguous identity | Cannot bind provenance |
| Enable npm scripts | Supports arbitrary dependencies | Executes unreviewed install code | Prebuilt verified artifacts are required instead |
| Expose upstream `force` with warning | Quick feature parity | Warning cannot recover deleted data | Public SDK must prevent known data loss |
| Copy after EXDEV | Works across mounts | Mixed/partial target on failure | Cannot claim atomic capability |
| Run repository hooks/build during analysis | Richer inference | Executes untrusted code with local authority | HarnessaaS owns governed execution |

## Compliance and executable verification

1. **`registry_pin`:** fake registry serves locked `0.4.1` and malicious newer
   `latest`; assert only locked tarball/dependencies are requested and warm
   execution makes zero registry calls.
2. **`integrity_matrix`:** alter tarball, dependency, entrypoint, identity,
   owner, permissions, and hard links; each fails before spawn/target access.
3. **`archive_extraction`:** traversal/absolute/link/device/bomb/duplicate/
   case/Unicode/mode/count/size fixtures never escape or enter the cache.
4. **`no_lifecycle_scripts`:** root and transitive install-script canaries never
   execute.
5. **`cache_race`:** 100 concurrent acquisitions yield one complete immutable
   entry; interruption yields no executable partial entry.
6. **`secret_free_process`:** seed ADR-0022, Git, shell, Node, CI, and cloud
   canaries; scan argv/env/stderr/events/errors/telemetry and find zero.
7. **`process_tree_cancel`:** hostile descendants are reaped within 12 seconds
   plus scheduler tolerance; recovery gets a separate 30-second budget.
8. **`repository_nonexecution`:** hooks, submodules, smudge filters, package
   scripts, executable configs, and malicious binaries execute zero times.
9. **`git_toc_tou`:** move a branch between resolution/fetch; exact SHA is used
   or operation fails, never new HEAD.
10. **`dry_plan`:** with pre-acquired local source, bridge planning writes no
    target, staging, transaction journal, or source byte.
11. **`path_escape`:** root/home/cwd/workspace root, `..`, absolute paths,
    symlink/junction races, mount/case/Unicode collisions, links/devices/FIFOs,
    and size/count limits change no byte outside staging.
12. **`plan_toc_tou`:** mutate every digest-bound input after planning; apply
    rejects all before staging.
13. **`transaction_fault_matrix`:** injected filesystem fails every file/dir
    fsync, rename, journal transition, crash, and disk-full on Linux/macOS/
    Windows cells; final state is exact old/new or preserved indeterminate.
14. **`visibility_claim`:** readers never see absence for atomic create/exchange;
    transactional replacement declares and exercises its observable gap.
15. **`exdev_refusal`:** force cross-device rename and assert no recursive copy
    begins.
16. **`unresolved_variable`:** unresolved marker makes plan non-applicable.
17. **`committed_rehash`:** mutate staging/target around commit and assert
    result is returned only when committed hashes match manifest.
18. **`platform_parity`:** Node/Python/Rust drive identical bridge fixture and
    produce equivalent plan/result/error/cancellation outcomes.

### Executable acceptance test

~~~text
cd sdks/node   && npm test -- metaharness-supply-chain-conformance
cd sdks/python && pytest -m metaharness_supply_chain_conformance
cd sdks/rust   && cargo test --features metaharness metaharness_supply_chain_conformance
~~~

In a network-disabled checkout, execute the locked distribution from a fake
content-addressed cache while malicious same-name binaries lead `PATH` and
secret canaries fill the parent environment. Plan and apply the same pinned
repository in all three SDKs. Outputs and manifests must be equivalent. Inject
failure at every transition; each run leaves exact old/new, or both preserved
with indeterminate status, and no descendant/secret. Atomic modes expose no
gap; transactional preview declares it. Changed package bytes stop before spawn.

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
- ADR-0026a: OSS MetaHarness identity, structured bridge, and public SDK API
- ADR-0028: telemetry, traces, usage, cost receipts, lineage, and redaction
- ADR-0029: language packaging, features, and CLI
- ADR-0030a: conformance, CI, and release evidence
- ADR-0030b: migration, rollout, and publication
- `ruvnet/metaharness@072b95c0a74610de008dca5473343a81619cef20`
- `cognitum-one/metaharness@fc8845f3bfdb67f1ab6d99547cc98e3b57717029`
