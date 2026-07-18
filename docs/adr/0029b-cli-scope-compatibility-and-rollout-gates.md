# ADR 0029b: CLI Scope, Compatibility, and Rollout Gates

- **Status:** Proposed
- **Date:** 2026-07-18
- **Deciders:** Cognitum SDK Working Group, Developer Experience, Release Engineering, Security, MetaHarness owner
- **Scope:** cross-cutting (`sdks/node`, `sdks/python`, `sdks/rust`) — shared CLI surface, backward-compatibility guarantees, and phased implementation gates

## Context

ADR-0029a defines the per-language package, module, and feature boundaries for
the four agentic products (Meta LLM, Meta Proxy, MetaHarness, HarnessaaS).
This companion ADR owns what is built on top of those boundaries: the single
canonical multi-product CLI, the compatibility and migration guarantees
existing cloud/Seed consumers need, and the phased dependency gates that
sequence implementation work toward the first coordinated `0.3.0` agentic
release.

None of these decisions are meaningful without ADR-0029a's namespace map: the
CLI is a thin caller over the Node facade methods it defines, the migration
guide states the same Node/Python/Rust boundaries in user-facing terms, and
the phased gates are ordered around when each package boundary in ADR-0029a
becomes safe to ship. Reviewers should read ADR-0029a first.

## Decision

The canonical CLI surfaces only public SDK methods across the product
namespaces from ADR-0029a; it introduces no parallel transport, retry, or
policy logic. Existing root, Seed, and MCP consumers are unaffected by the
`0.3.0` release. Implementation proceeds through ordered dependency gates so
that no later-phase product can merge ahead of the shared contracts and
remote clients it depends on.

### D1. CLI scope and stability

The canonical multi-product CLI remains the Node package's existing
`cognitum` binary. `cognitum-sdk` remains an alias during `0.3.x` for backward
compatibility. Python receives no console script and Rust receives no binary in
`0.3.0`; three separately evolving CLIs would triple process, output, and
credential behavior without adding SDK coverage.

New commands are namespaced:

```text
cognitum agentic capabilities
cognitum meta-llm models|chat|usage
cognitum meta-proxy status|start|stop
cognitum metaharness capabilities|templates|hosts|analyze|score|plan|scaffold|validate|verify
cognitum harnessaas submit|status|events|approvals|approve|deny|cancel|artifacts
```

The command list is illustrative; ADRs 0024 through 0027, accepted contract
manifests, operation maturity, and injected lifecycle providers determine which
commands ship. Preview commands remain hidden unless the caller explicitly opts
into preview surfaces. Meta Proxy `start` and `stop` exist only when a verified
lifecycle provider is configured. The CLI MUST remain a thin
caller of public SDK methods. It cannot contain an alternative transport,
error mapping, retry loop, capability table, or policy engine.

Canonical Node facade spellings are fixed by the owning product ADR. Python and
Rust adapt only casing and async conventions, never semantic synonyms:

| Product | Canonical Node facade method | CLI command | Exposure prerequisite |
|---------|------------------------------|-------------|-----------------------|
| Shared | each configured client's `capabilities()` | `agentic capabilities` | At least one configured product |
| Meta LLM | `models.list`, `chat.completions.create`, `usage.list` | `meta-llm models`, `meta-llm chat`, `meta-llm usage` | Operation maturity from contract |
| Meta Proxy | `status()` | `meta-proxy status` | Authenticated local client |
| Meta Proxy manager | `start()`, `stop()` | `meta-proxy start`, `meta-proxy stop` | Injected verified lifecycle provider |
| MetaHarness | `capabilities()`, `listTemplates()`, `listHosts()`, `analyzeRepository()`, `scoreRepository()`, `planScaffold()`, `scaffold()`, `validateHarness()`, `verifyWitness()` | Corresponding command under `metaharness` | Exact bridge capability and runtime |
| HarnessaaS | `submitSolve()`, `getSolve()`, `SolveHandle.events()`, `listApprovals()`, `approve()`, `deny()`, `SolveHandle.cancel()`, `listArtifacts()` | Corresponding `submit`, `status`, `events`, `approvals`, `approve`, `deny`, `cancel`, or `artifacts` command | Exact job/evidence capability |

`whoami` is the canonical authenticated identity probe on product clients;
`identity()` remains the credential-provider fingerprint method in ADR-0022.
The canonical local-runtime failure is `UnsupportedRuntimeError` in every
language. Internal reload, signing, publishing, and recovery operations never
become CLI commands merely because an upstream binary contains similarly named
commands.

Every automation-safe command supports `--output json`. In JSON mode stdout
contains exactly one versioned result or newline-delimited event stream; logs,
warnings, progress, and diagnostics go to stderr. Exit codes are stable:

| Exit | Meaning |
|------|---------|
| `0` | Successful terminal result |
| `2` | Invalid local configuration or arguments |
| `3` | Authentication, authorization, tenant, budget, or consent rejection |
| `4` | Unsupported capability or incompatible protocol |
| `5` | Remote operation failed |
| `6` | Local process or sandbox failed |
| `7` | Cancelled or timed out |
| `8` | Receipt, lineage, signature, or artifact verification failed |

New agentic commands MUST NOT accept secrets in command-line flags. They use a
credential provider, documented environment variable, OS-managed credential
source, or explicit `--credential-stdin`. The existing `--key` cloud option is
deprecated in `0.3.0`, warns without echoing the value, and remains for one
minor release under ADR-0006. It MUST never be forwarded into MetaHarness or
Meta Proxy child-process arguments.

CLI commands do not silently install MetaHarness, start Meta Proxy, fall back
from local to cloud, approve a job, download an artifact, or increase a budget.
Each state-changing action requires its named command and the consent rules in
ADRs 0022, 0025, 0026, and 0027.

### D2. Compatibility and migration

The integration is additive at the package namespace level. Existing users of
the root cloud client, Seed subpath/module/feature, and MCP transports need not
change code for `0.3.0`.

The migration guide MUST state:

1. use the new product namespace rather than adding a product base URL to the
   existing cloud client;
2. Meta Proxy is not a Meta LLM base-URL alias and has a narrower capability
   set under ADR-0025;
3. local MetaHarness execution requires Node 20 regardless of the calling SDK
   language;
4. browser consumers may use only the explicitly browser-safe remote surfaces
   with delegated credentials;
5. Python modules remain sync and async where the product contract supports
   both;
6. Rust consumers opt into only the named product features and import the
   crate as `cognitum_one`;
7. old Node and Rust package names are abandoned, not aliases to install;
8. CLI secret flags are deprecated in favor of providers or stdin.

Every example is compiled or executed in CI. Search-based checks reject the
old `@cognitum/sdk`, `cognitum-rs`, and `use cognitum_rs` names outside an
explicit migration-history allowlist.

### D3. Phased dependency gates

Implementation proceeds through dependency gates. A later gate cannot merge
into a release branch until the previous gate passes:

| Gate | Deliverable | Dependency rule | Authoritative work package |
|------|-------------|-----------------|----------------------------|
| P0 | Correct current manifests, docs, examples, cloud auth/redaction/retry baseline | No new product dependency | W0 |
| P1 | Shared `agentic` contracts and generated internal wire models | No process, installer, or telemetry SDK in base imports | W1 and W2 |
| P2 | Meta LLM, Meta Proxy client, and HarnessaaS remote subpaths/modules/features | Reuse existing HTTP stack; product features remain independent | W3, W4, and W5 |
| P3 | MetaHarness bridge and Meta Proxy manager | Optional local-only dependencies; Node 20 checked at execution | W6 and W7 |
| P4 | CLI, browser/WASM boundaries, artifact packaging, and migration docs | Public clients only; no duplicate protocol code | W8 |

ADR-0030b owns the unique work breakdown and estimates. Product-level figures
elsewhere explain local complexity but overlap contracts, language facades,
fixtures, and review; they are not additive program budgets.

### D4. Expected implementation layout

The implementation uses one directory per bounded context. This layout is
normative unless a language owner records an equivalent layout in the
implementation pull request:

| Concern | Node | Python | Rust |
|---------|------|--------|------|
| Shared handwritten contracts | `sdks/node/src/agentic/` | `sdks/python/cognitum/agentic/` | `sdks/rust/src/agentic/` |
| Generated wire models | `sdks/node/src/generated/agentic/<product>/v1/` | `sdks/python/cognitum/_generated/agentic/<product>/v1/` | `sdks/rust/src/generated/agentic/<product>/v1/` |
| Meta LLM facade | `sdks/node/src/meta-llm/` | `sdks/python/cognitum/meta_llm/` | `sdks/rust/src/meta_llm/` |
| Meta Proxy facade/manager | `sdks/node/src/meta-proxy/` | `sdks/python/cognitum/meta_proxy/` | `sdks/rust/src/meta_proxy/` |
| MetaHarness bridge | `sdks/node/src/metaharness/` | `sdks/python/cognitum/metaharness/` | `sdks/rust/src/metaharness/` |
| HarnessaaS facade | `sdks/node/src/harnessaas/` | `sdks/python/cognitum/harnessaas/` | `sdks/rust/src/harnessaas/` |
| Product tests | `sdks/node/tests/agentic/<product>/` | `sdks/python/tests/agentic/<product>/` | `sdks/rust/tests/agentic/<product>/` |

Product directories may import shared `agentic` and generated wire modules,
but not another product directory. Root entry files export only public facade
symbols and MUST NOT instantiate clients. Generated directories are replaced
only by ADR-0020 tooling and contain a header with contract version, source
revision, and bundle digest.

## Consequences

### Positive

- One canonical CLI keeps machine output, consent, and credentials consistent
  across products.
- Existing root, Seed, and MCP consumers migrate zero code for `0.3.0`.
- Ordered dependency gates prevent a downstream product (e.g. MetaHarness's
  local bridge) from merging ahead of the shared contracts and remote clients
  it depends on.

### Negative and trade-offs

- A single canonical CLI concentrates output-contract and credential-handling
  risk in one binary rather than distributing it per language.
- Phased gates slow parallel work across products until each gate's
  dependency rule is satisfied.

### Biggest failure mode and mitigation

The biggest failure mode is a gate being merged out of order — for example a
product facade landing before its shared `agentic` contracts stabilize, or the
CLI landing before its underlying clients pass conformance. The mitigation is
the explicit per-gate dependency rule in D3 and treating ADR-0030a's
conformance evidence as a release gate rather than an advisory check.

## Alternatives considered

| Option | Pros | Cons | Why rejected |
|--------|------|------|--------------|
| Add Python and Rust CLIs immediately | Surface symmetry | Three parsers, output contracts, credential paths, and release targets | Language SDK parity does not require CLI duplication |

## Compliance and verification

CI MUST verify:

1. CLI JSON output contains no log line and secret values never appear in
   argv, stdout, stderr, process environment snapshots, or error strings;
2. all examples use current package and crate names;
3. a later phased gate (D3) does not merge into a release branch while an
   earlier gate's dependency rule is unsatisfied;
4. the implementation layout (D4) matches the normative table or an
   equivalent layout recorded in the implementation pull request.

### Acceptance test

From a clean checkout, run every automation-safe `cognitum` command with
`--output json` and assert stdout contains exactly one versioned result or
event stream with no interleaved log line, and that no secret value appears in
argv, stdout, stderr, or captured process environment snapshots. Run the
migration-history search checks against the full source tree and confirm zero
matches for `@cognitum/sdk`, `cognitum-rs`, or `use cognitum_rs` outside the
allowlist. Confirm the release branch's merge history respects the P0-P4 gate
order in D3.

## References

- ADR-0006: cross-cutting versioning
- ADR-0007: cross-cutting security model
- ADR-0011: cloud and Seed package topology
- ADR-0020: agentic contract source of truth and code generation
- ADR-0022: authentication, tenant, budget, secret, and consent isolation
- ADR-0023: errors, retries, idempotency, cancellation, and time budgets
- ADR-0024: Meta LLM dual protocol, streaming, routing, and usage
- ADR-0025: Meta Proxy local control, routing, and failover
- ADR-0026: MetaHarness local process bridge and npx supply chain
- ADR-0027: HarnessaaS jobs, events, approvals, artifacts, and isolation
- ADR-0028: telemetry, traces, usage, receipts, lineage, and redaction
- ADR-0029a: Node, Python, and Rust packaging and feature boundaries this CLI
  and rollout plan builds on
- ADR-0030: conformance, release, migration, and rollout
