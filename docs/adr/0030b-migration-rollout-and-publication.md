# ADR 0030b: Migration, Rollout, and Publication

- **Status:** Accepted — Partially Implemented
- **Date:** 2026-07-18
- **Updated:** 2026-08-05 — reconciled the plan after the `0.3.0` publication and implemented `0.4.0` release preparation. Baseline remediation, the shared agentic core, selected remote product clients, coverage gates, release tooling, and npm published-artifact smoke are implemented. Source is `0.4.0` while all registries still serve `0.3.0`; public docs now state both. Public conversion and Apache-2.0 are accepted but remain gated by history/privacy/IP review, public documentation, repository hardening, and artifact proof. PyPI/crates publication is deferred. `/v1/whoami` deployment is owned by `cognitum-one/api#96`.
- **Deciders:** Cognitum SDK Working Group, Product API Owners, Release Engineering, Security, Developer Experience
- **Scope:** cross-cutting (`sdks/node`, `sdks/python`, `sdks/rust`, migration, compatibility, registries and release operations)

## Context

ADR-0030a defines the conformance corpus, CI matrix, staging limits, security
checks, and signed evidence required for an agentic release. Passing those tests
is necessary but not sufficient. The current SDK family has misaligned manifest
and registry versions, stale package and crate names, contradictory endpoint
claims, no verified coordinated publication workflow, and immutable artifacts
spread across npm, PyPI, and crates.io.

Publication to three registries is sequential rather than atomic. A failed
middle step can leave users with different versions or capabilities by
language. Product readiness also differs: Meta LLM and the Meta Proxy client
have remote HTTP contracts, while MetaHarness requires a Node 20 structured
process bridge and HarnessaaS must reconcile job, approval, artifact, isolation,
receipt, and lineage semantics. Migration and release claims therefore require
explicit gates, not a single feature-complete assertion.

### 2026-08-05 implementation reconciliation

The original proposal targeted the then-future `0.3.0` release. That release is
now historical. The live state is:

- npm, PyPI, and crates.io serve `0.3.0`;
- source manifests and release preflight are prepared at `0.4.0`;
- the release workflow and registry-safe resume logic are implemented;
- npm trusted publishing is available for the next authorized release, while
  PyPI and crates.io owner setup remains deferred;
- public repository conversion is accepted with Apache-2.0, but visibility
  waits for the public-readiness gates;
- operation maturity remains independent from package version: MetaHarness is
  a fail-closed contract preview and `whoami` is not live at the public gateway
  until `cognitum-one/api#96` is deployed and verified.

Where this reconciliation conflicts with obsolete `0.3.0` future-tense wording
below, this section and the current capability manifest govern. Older phase and
effort material remains as decision history rather than a claim that all work is
still unstarted.

## Decision

Remediate the current SDK baseline before publishing any agentic preview. Roll
out through contract, shared-core, remote-product, local-product, beta, and
general-availability gates. The first agentic version was coordinated at `0.3.0`; coordinate subsequent versions,
publish only artifacts already proven by ADR-0030a, and bind source, contract,
conformance, SBOM, provenance, compatibility, and registry digests in one
signed release manifest. Operation maturity remains per-contract; package
version never promotes a preview or internal route to stable.

### D8. Phase-zero drift remediation

No agentic preview package is published until the current SDK baseline is
truthful and security-compatible. The remediation evidence includes
`sdks/node/src/client.ts:238-255` for current
environment-key resolution, `sdks/python/cognitum/client.py:39-51` for required
Python credentials, `sdks/python/cognitum/_http.py:97-160` for retry behavior,
and `sdks/rust/src/client.rs:28-36,297-365` for secret/retry risk.

One preparatory change set MUST:

1. align root README, package manifests, compatibility tables, and changelogs
   with actual registry versions;
2. verify ownership and publish capability for the `cognitum` PyPI project;
3. replace active examples of `@cognitum/sdk` with
   `@cognitum-one/sdk`;
4. replace active Rust examples of `cognitum_rs` or `cognitum` with
   `cognitum_one`, while retaining old names only in migration history;
5. correct the 71-versus-12 endpoint claim using an executable inventory;
6. remove or rewrite stale `CLAUDE.md` simulator instructions;
7. reconcile Node 18 package support with stale Node 20 ADR text, preserving
   ADR-0029's Node 20 requirement only for local MetaHarness execution;
8. make Rust cloud credentials redacting instead of deriving `Debug` over raw
   `api_key` strings;
9. implement or explicitly revise the documented environment-key resolution
   contract in Python and Rust;
10. bring Python cloud retry behavior to ADR-0005, including jitter, body retry
    hints, and a 60-second total budget;
11. bring Rust cloud retry behavior to ADR-0005, including 502/504,
    idempotency gating, cancellation, and a 60-second total budget;
12. make the Rust root error forward-extensible and reconcile root error
    exports/mapping in all languages with ADR-0004 and ADR-0023;
13. add CI that runs the existing language test and packaging commands;
14. record, quarantine, or fix every documented “pre-existing” test failure so
    a new failure cannot hide behind an unbounded exemption.

Each exception has an owner, issue, exact failing test, and expiry release.
“Pre-existing” without those fields is a failure.

### D9. Rollout phases and dependency gates

The release train has seven gates:

| Phase | Output | Entry dependency | Exit gate | Work packages and effort |
|-------|--------|------------------|-----------|--------------------------|
| R0: Baseline truth | Phase-zero remediation | Current `main` | Existing tests and package smoke tests green with no unexplained failure | W0, 5 to 8 engineer-days |
| R1: Contract lock | ADR-0020 bundles, lock, generators, scenarios | Product-owner contract publication | Offline regeneration clean; semantic diff reviewed | W1, 8 to 12 SDK engineer-days |
| R2: Shared core | ADRs 0021, 0022, 0023, and 0028 primitives | R0 and R1 | Cross-language shared fixtures, auth isolation, redaction, retry, cancellation, and telemetry green | W2, 15 to 22 engineer-days |
| R3: Remote products | Meta LLM, Meta Proxy client, HarnessaaS HTTP/events preview | R2 plus product contracts | Product fixture rows green; no local manager/process dependency in remote imports | W3 through W5, 55 to 88 engineer-days |
| R4: Local products | MetaHarness bridge and optional Meta Proxy manager | R2 plus exact bridge contracts | Node 20, Python, Rust, Windows/macOS/Linux process suites green | W6 and W7, 30 to 46 engineer-days |
| R5/R6: Release candidate and GA | Prerelease, migration, conformance evidence, coordinated `0.3.0` | R3 and R4 | Binding matrix and staging budgets pass; beta has no unresolved critical defect; registries match signed manifest | W8, 12 to 18 engineer-days |

The authoritative non-overlapping SDK work breakdown is:

| ID | Unique scope | Estimate |
|----|--------------|----------|
| W0 | Existing auth, retry, redaction, version, documentation, and test-baseline repair | 5 to 8 engineer-days |
| W1 | Contract snapshots, registry, lock, repository generator, semantic diff, and base fixtures | 8 to 12 engineer-days |
| W2 | Shared transport, auth/tenant/budget, errors, retry, cancellation, capability, telemetry, receipt, and lineage primitives | 15 to 22 engineer-days |
| W3 | Meta LLM serving and platform facades, streams, handles, and language fixtures | 30 to 48 engineer-days |
| W4 | Meta Proxy client facades, consent/routing evidence, streams, and language fixtures | 15 to 24 engineer-days |
| W5 | HarnessaaS job, event, approval, artifact, webhook, and evidence facades | 10 to 16 engineer-days |
| W6 | MetaHarness bridge, verified acquisition, process control, transactional filesystem, recovery, and three language facades | 22 to 34 engineer-days |
| W7 | Meta Proxy lifecycle provider adapter, installer integrity, ownership, update, and rollback | 8 to 12 engineer-days |
| W8 | CLI, package boundaries, compatibility docs, conformance infrastructure, registry rehearsal, beta, and GA evidence | 12 to 18 engineer-days |

Total incremental SDK effort is 125 to 194 engineer-days. This excludes
upstream product contract publication and server corrections. Standalone
figures in product ADRs are diagnostic estimates from those products' local
perspectives and overlap these work packages; they MUST NOT be added. With four
engineers covering shared contracts, Node, Python, and Rust, plus product-owner
reviews and upstream gates, the realistic critical path is approximately eleven
to seventeen calendar weeks. HarnessaaS contract and isolation reconciliation
is the largest schedule uncertainty; if it misses the gate, it remains
explicitly preview and `0.3.0` release claims MUST say so.

No phase may bypass R0. R3 and R4 may proceed in parallel after R2. A product
can remain preview without blocking stable methods from another product, but a
release cannot claim “all four fully integrated” until each required product
inventory declares at least one stable public operation, no required inventory
row is preview, blocked, internal, or not-applicable, and every required stable
row passes. A product with zero stable rows never satisfies this claim.

### D10. Prerelease and maturity policy

The original coordinated `0.3.0` sequence was:

```text
0.3.0-alpha.1   internal contract and package validation
0.3.0-beta.1    externally consumable preview after offline conformance
0.3.0-rc.1      optional if a product or registry migration needs another freeze
0.3.0           first stable agentic SDK release
```

For subsequent releases, registry conventions map appropriately: npm uses the `next` dist-tag, Python
uses PEP 440 prerelease versions such as `0.3.0a1` and `0.3.0b1`, and crates.io
uses SemVer prerelease identifiers. Documentation shows the exact install
syntax for each registry rather than pretending one version string is accepted
everywhere.

Operation maturity from ADR-0019 remains authoritative:

1. stable operations are available through normal product namespaces;
2. preview operations require an explicit `preview` option or Rust preview
   feature and carry a warning in generated documentation;
3. internal operations have no public binding;
4. a package being `0.3.0` does not promote every server route to stable;
5. marketing and README capability tables are generated from the accepted
   contract manifests and conformance results.

The SDK family remains pre-1.0. ADR-0006's 1.0 criteria are evaluated only
after the agentic compatibility matrix has at least one supported server/CLI
version per product and no open security-significant contract gap.

### D11. Release artifact and publication process

The release candidate build creates one immutable release manifest:

```json
{
  "release": "0.3.0",
  "source_commit": "<40-character commit>",
  "contract_lock_sha256": "<digest>",
  "artifacts": {
    "npm": {"name": "@cognitum-one/sdk", "sha256": "<digest>"},
    "pypi_wheel": {"name": "cognitum", "sha256": "<digest>"},
    "pypi_sdist": {"name": "cognitum", "sha256": "<digest>"},
    "crates": {"name": "cognitum-one", "sha256": "<digest>"}
  },
  "conformance_report_sha256": "<digest>",
  "compatibility_matrix_sha256": "<digest>",
  "sboms": {},
  "known_issues": []
}
```

The exact packaged artifacts are installed into clean test environments. They
are not rebuilt between validation and publication. The release commit and tag
are signed. Publication uses registry-native provenance where available.

Stable publication is operationally sequential because three registries
cannot commit atomically:

1. verify package ownership, credentials, registry health, and that the version
   is unused;
2. publish the already-tested Python wheel/sdist, npm tarball, and Rust crate
   from the release workspace;
3. install each artifact from its public registry and rerun smoke and version
   checks;
4. publish the release manifest and compatibility page only after all public
   artifacts match their recorded digests;
5. move npm's stable tag and announce the release only after the complete
   three-registry check passes.

If publication fails before a registry accepts an artifact, retry the identical
artifact. If an incorrect artifact becomes immutable on any registry, do not
silently replace it or let other registries diverge. Yank or deprecate where
supported, document the incident, and issue a coordinated `0.3.1`. Runtime
capability manifests may disable a broken server operation, but they cannot
rewrite an already-published client artifact.

### D12. Compatibility matrix and migration deliverables

Each release publishes a machine-readable and rendered matrix containing:

| Field | Required content |
|-------|------------------|
| SDK | Registry name, exact version, runtime floor, supported OS/target |
| Product | Tested product version and immutable revision |
| Contract | Protocol major/minor and bundle digest |
| Capability | Stable and preview operations; known limitations |
| Auth | Supported methods and required scopes without secret examples |
| Streaming | Supported transport, resume, and cancellation behavior |
| Evidence | Receipt/lineage verification support and signer constraints |
| Status | Supported, preview, blocked, deprecated, or unsupported |

Migration documentation is split by audience:

1. existing cloud and Seed users: no required code change;
2. users of abandoned npm/Rust names: install the current package and update
   imports;
3. Meta LLM users: choose the dedicated client and dual-protocol facade;
4. Meta Proxy users: use the dedicated local client and explicit routing or
   failover consent;
5. MetaHarness users: provide or explicitly install an exact compatible
   version and run under Node 20;
6. HarnessaaS users: migrate from one-shot solve assumptions to operation,
   event, approval, cancellation, artifact, receipt, and lineage states;
7. browser users: use only declared remote subsets and delegated credentials;
8. Rust users: select independent product features and import
   `cognitum_one`.

Every migration example compiles or executes against the packaged artifact,
not the source tree.

### D13. Requirements traceability

The release report links each architecture decision to executable evidence:

| ADR | Release invariant | Required evidence |
|-----|-------------------|-------------------|
| 0019 | Independent bounded contexts and side-effect-free construction | Import isolation and zero-I/O constructor scenarios |
| 0020 | Immutable contract source and generated internal wire models | Lock digest, schema validation, regeneration clean diff |
| 0021 | Explicit service origins, transports, capabilities, and negotiation | Configuration precedence, origin, protocol, and unknown-capability scenarios |
| 0022 | Credential, tenant, budget, secret, and consent isolation | Cross-origin and cross-tenant negative tests, hard-budget fixtures, sentinel scan |
| 0023 | Uniform errors, safe retry, idempotency, cancellation, and budgets | Status/process/job error matrix, virtual-clock retry and cancellation tests |
| 0024 | Meta LLM protocol, stream, route, usage, and cost fidelity | OpenAI/Anthropic fixtures, stream events, `x_cognitum`, token and cost reconciliation |
| 0025 | Meta Proxy local control and explicit routing/failover | Status, capability subset, consent, no-silent-fallback, reload, token isolation |
| 0026 | Structured MetaHarness process and verified npm distribution boundary | Exact-version bridge, no-shell argv, output limits, process-tree cancellation, acquisition consent |
| 0027 | HarnessaaS job, event, approval, artifact, and isolation semantics | State-machine, resume, approve/deny, digest/size, sandbox, receipt and lineage fixtures |
| 0028 | Telemetry, traces, usage, receipts, lineage, and redaction | Canonical events, trace propagation, exactly-one terminal record, content exclusion, signature verification |
| 0029 | Package, runtime, browser, feature, and CLI boundaries | Installed-artifact imports, bundle graph, lazy imports, feature powerset, CLI JSON and secret tests |

A stable method with no row in the generated traceability report is a release
failure.

### D14. Executable release acceptance tests

The following twelve tests are mandatory for `0.3.0`:

1. **Clean build:** run all commands in D3 on a clean checkout and require zero
   unexplained failure, warning promoted by policy, or generated diff.
2. **Installed artifacts:** install the npm tarball, Python wheel, Python
   sdist-built wheel, and Rust crate in clean projects; compile or execute every
   documented quick start.
3. **Twelve bindings:** for each of the three language families by four
   products, run one successful and one security-negative scenario at the
   operation's declared maturity and compare canonical results. Stable
   operations must pass the stable suite. A preview-only product instead proves
   that its surface is hidden without explicit preview opt-in and that opted-in
   results retain the preview maturity marker. No release may claim that product
   stable until its applicable operation passes the stable suite.
4. **Constructor isolation:** instantiate every client with unique sentinel
   credentials while network, process, filesystem mutation, and registry access
   are trapped; observe zero I/O and zero cross-product import.
5. **Capability failure:** present an unknown version and missing required
   capability; verify the SDK blocks spend, mutation, consent, install,
   execution, approval, and artifact download before transport I/O.
6. **Credential and content redaction:** scan exceptions, `Debug`, `repr`, JSON,
   logs, telemetry, receipts, lineage, stdout, stderr, argv, and artifacts for
   raw credential, prompt, repository, and client-secret sentinels; find none.
7. **Retry and idempotency:** under a virtual clock, prove replay-safe HTTP
   operations honor bounded server hints with at most three retries and a
   60-second aggregate sleep budget; prove non-idempotent inference and local
   MetaHarness operations never replay automatically; prove a stable HarnessaaS
   submit with one idempotency binding creates one job across an uncertain
   transport retry, while legacy `/solve` without atomic dedupe never retries.
8. **Streaming and cancellation:** validate ordered Meta LLM chunks,
   HarnessaaS event resume without duplicates, cancellation races, one terminal
   event; for local MetaHarness cancellation, observe cooperative acknowledgement
   within one second when available, terminate/kill escalation within five
   seconds, descendant reaping within the 12-second process budget, and any
   journal recovery under its separate 30-second budget.
9. **Routing and consent:** prove Meta Proxy never receives an unsupported Meta
   LLM governance call, never forwards a forbidden header, and never selects
   cloud, sponsored, or local fallback without the exact consent fixture.
10. **Approval and artifacts:** drive a HarnessaaS job through `accepted`,
    `queued`, `preparing`, a declared running tier, `awaiting_approval`, and an
    approve and deny resolution. Follow the declared resume or grading path to
    `succeeded`, `failed`, `cancelled`, or `expired`; reject invalid transitions
    and artifacts with wrong digest, media type, origin, or declared size.
11. **Package boundaries:** bundle allowed browser entries and find no Node
    built-ins; import Python lazily; build every Rust product feature alone;
    under Node 18 fail only MetaHarness execution and under Node 20 pass the
    exact bridge fixture.
12. **Registry rehearsal:** publish prerelease artifacts to isolated test or
    prerelease channels, install by exact version, verify artifact digests and
    provenance against the release manifest, then repeat smoke tests without a
    source checkout.


## Consequences

### Positive

- Current documentation and registry drift is repaired before new product
  claims compound it.
- Product maturity can differ without hiding the difference or coupling every
  stable operation to an unready internal endpoint.
- Exact installed artifacts, compatibility data, migration examples, SBOMs,
  and provenance are cryptographically tied to the tested source and contract.
- Prerelease rehearsal makes registry ownership, version syntax, package
  contents, and runtime floors observable before general availability.

### Negative and trade-offs

- Coordinated registry publication is not atomic. The release manifest,
  prerelease rehearsal, and no-rebuild rule reduce but cannot eliminate partial
  publication risk.
- Strict contract and migration gates can delay general availability even when
  a subset of endpoints works.
- Keeping package versions coordinated requires release-owner availability
  across npm, PyPI, and crates.io.

### Biggest failure mode and mitigation

The biggest failure mode is publishing a partial or misleading release: one
registry receives a different artifact, one language advertises an unsupported
capability, or documentation claims all four products are stable while a
contract remains preview. The mitigation is phase-zero truth remediation,
per-operation maturity, tested prereleases, one signed multi-registry manifest,
post-publish installation by exact version, and a coordinated patch rather than
silent artifact replacement.

## Alternatives considered

| Option | Pros | Cons | Why rejected |
|--------|------|------|--------------|
| Release each language whenever ready | Faster first artifact | Versions and behavior diverge; users cannot rely on parity | The first agentic release establishes a coordinated contract |
| Ship all server routes as preview | Broad apparent coverage | Internal and unstable semantics become public dependencies | Contract maturity controls exposure |
| Publish one registry first and port later | Lower immediate effort | Repeats current version and documentation drift | Coordinated prereleases reveal portability gaps before GA |

## Compliance and verification

A release candidate MUST consume an unmodified passing ADR-0030a report. The
release rule additionally requires all twelve executable acceptance tests,
signed and digest-bound artifacts, complete compatibility and traceability
matrices, migration examples executed against installed packages, verified
registry ownership, and zero unowned exception.

Release Engineering owns artifact identity and publication. Product owners own
maturity and compatibility truth. Language owners own package metadata and
migration accuracy. Security owns provenance, secret handling, consent,
isolation, artifact verification, and rollback review. No owner may waive
another owner's failing invariant unilaterally.

### Acceptance test

Start with the signed source commit, contract lock, and passing ADR-0030a report.
Build each artifact once, install it into clean supported environments, and bind
its digest into the release manifest. Publish the exact artifacts to
prerelease channels, reinstall them by exact registry version without a source
checkout, run the migration and compatibility smoke suite, and verify every
digest and provenance statement. Promote the same artifacts to stable only
after the complete three-registry rehearsal passes. Any mismatch, unsupported
stable claim, missing migration row, or changed artifact blocks publication.

## References

- Source: `sdks/node/src/client.ts:238-255` — current environment-key resolution
- Source: `sdks/python/cognitum/client.py:39-51` — required Python credentials
- Source: `sdks/python/cognitum/_http.py:97-160` — retry behavior
- Source: `sdks/rust/src/client.rs:28-36,297-365` — secret/retry risk
- ADR-0004: cross-cutting error taxonomy
- ADR-0005: retry and rate-limit backoff
- ADR-0006: cross-cutting versioning
- ADR-0007: cross-cutting security model
- ADR-0019: agentic platform bounded contexts and SDK topology
- ADR-0020: agentic contract source of truth and code generation
- ADR-0021: agentic service configuration, transports, and capabilities
- ADR-0022: authentication, tenant, budget, secret, and consent isolation
- ADR-0023: errors, retries, idempotency, cancellation, and time budgets
- ADR-0024: Meta LLM dual protocol, streaming, routing, and usage
- ADR-0025: Meta Proxy local control, routing, and failover
- ADR-0026: MetaHarness local process bridge and npx supply chain
- ADR-0027: HarnessaaS jobs, events, approvals, artifacts, and isolation
- ADR-0028: telemetry, traces, usage, receipts, lineage, and redaction
- ADR-0029: language packaging, features, and CLI boundaries
- ADR-0030a: conformance, CI, and release evidence
