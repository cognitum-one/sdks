# ADR 0030a: Conformance, CI, and Release Evidence

- **Status:** Partially Implemented
- **Date:** 2026-07-18
- **Updated:** 2026-07-31 — first slice built (issue #75): the §D1 **Domain** layer for meta-llm HTTP error mapping. A shared corpus of 28 cases lives at `sdks/fixtures/error-mapping/meta-llm-http-errors-v1.json`; the Node, Python and Rust suites each drive their own mapper over it and assert a canonical camelCase result, so a cross-SDK error-semantics regression fails a build instead of reaching a user. NOTE ON LOCATION: §D2 proposes `specs/agentic/scenarios/` + `expected/`. The corpus was placed in `sdks/fixtures/` instead, alongside the existing `receipt-canonicalization/` fixture that already serves exactly this cross-language purpose — one convention beats two, and the receipt fixture is the working precedent. Adopt §D2's tree only if a scenario needs setup/teardown that a flat fixture cannot express. Where the three languages genuinely differ, a case carries a `knownDivergence` block pinning each language's ACTUAL result, so a divergence is a declared fact rather than missing coverage, and a new one requires editing the corpus deliberately. Writing the corpus immediately found a four-way `Retry-After` bug (RFC 9110 permits an HTTP-date; Node yielded NaN, Python raised an uncaught ValueError mid-error-mapping, Rust's nonstream path parsed f64 only, and Rust's streaming paths never read the header) — all four fixed in the same change. STILL OPEN from this ADR: the Wire, Security-and-governance and Packaging layers; the multi-runtime CI matrix (§D3); the product matrix report (§D4); generated-code diffing and the fake MetaHarness bridge (§D5); staging/live validation (§D6); and the provenance gates (§D7).
- **Deciders:** Cognitum SDK Working Group, Product API Owners, Release Engineering, Security, Developer Experience
- **Scope:** cross-cutting (`sdks/node`, `sdks/python`, `sdks/rust`, agentic contract fixtures, CI and release)

## Context

The agentic SDK program creates twelve product-language bindings: Meta LLM,
Meta Proxy, MetaHarness, and HarnessaaS across Node, Python, and Rust. It also
adds shared configuration, capability negotiation, authentication, error,
retry, cancellation, telemetry, receipt, lineage, and generated wire-model
behavior. A green unit test in one language is not evidence that the twelve
bindings agree or that the registry artifacts contain what was tested.

The current repository has strong language-local tests but no verified
cross-language release gate:

| Area | Current verified state |
|------|------------------------|
| Node | `npm test`, `npm run typecheck`, and `npm run build` scripts; unit and Seed integration tests under `sdks/node/tests/`; generated `dist/` committed |
| Python | pytest, pytest-asyncio, and respx dev dependencies; sync, async, Seed, and MCP tests under `sdks/python/tests/` |
| Rust | wiremock and tokio tests under `sdks/rust/tests/`; feature-gated Seed, discovery, and MCP coverage |
| CI | `.github/workflows/security.yml` delegates to `cognitum-one/.github/.github/workflows/security-scan.yml@main` |
| Release | Keep a Changelog files and SemVer policy; no repository-local build, cross-language conformance, package, or release workflow was verified during the source review |

Representative package/test baselines are `sdks/node/package.json:2-67`,
`sdks/python/pyproject.toml:5-25`, and `sdks/rust/Cargo.toml:1-73`. The verified
workflow is `.github/workflows/security.yml:1-20`; absence claims are limited to
the paths inspected during the pinned source review.

The reusable security workflow reference is mutable because it uses `@main`.
That is acceptable as an observed current fact, but it is not reproducible
release evidence. All release-critical actions and reusable workflows must be
pinned to immutable revisions before `0.3.0`.

Package state is also not aligned. Node is `@cognitum-one/sdk@0.2.1`, Python's
manifest is `cognitum==0.2.0`, and Rust is `cognitum-one@0.2.1`. The root
changelog says PyPI was still `0.0.1.dev2` when `0.2.1` was recorded. README,
source examples, ADR indexes, crate imports, and endpoint-count claims disagree
with one another as detailed in ADR-0029. New product work cannot use those
documents as a trustworthy release baseline.

The four upstream products have different readiness risks:

1. Meta LLM has the broadest HTTP surface and dual OpenAI/Anthropic protocols.
2. Meta Proxy is a strict local subset with routing and consent semantics that
   must never be treated as transparent Meta LLM failover.
3. MetaHarness executes local code and currently depends on a Node 20 CLI and
   structured bridge work.
4. HarnessaaS executes untrusted repository commands remotely and needs stable
   job, event, approval, artifact, tenant, and evidence contracts.

Shipping all four behind one marketing claim before each contract passes its
own gate would make the weakest contract the security boundary of the entire
SDK family.

## Decision

Use a contract-first, fixture-driven, cross-language release train. No stable
agentic method is published until its upstream contract, generated wire model,
handwritten facade, negative fixtures, security tests, and language-specific
package checks all pass. Release maturity is tracked per operation as required
by ADR-0019, while package versions remain coordinated at `0.3.0` for the first
agentic release.

### D1. Four layers of conformance

Every stable operation passes four distinct layers. Passing one layer does not
waive another:

| Layer | Invariant | Evidence |
|-------|-----------|----------|
| Wire | Method, path or bridge command, headers, body, event frames, status, and unknown fields match the pinned ADR-0020 contract | Golden request/response/event fixtures and generated-code clean diff |
| Domain | Node, Python, and Rust expose equivalent states, errors, capabilities, receipts, and lineage without erasing product-specific fields | Canonical cross-language result records |
| Security and governance | Credential scope, tenant, budget, consent, isolation, idempotency, cancellation, redaction, artifact verification, and fail-closed behavior hold | Negative and adversarial fixtures plus sentinel-secret tests |
| Packaging and runtime | The exact npm tarball, Python wheel/sdist, and Rust crate compile, import, and run within declared runtime and browser boundaries | Installed-artifact smoke tests and release manifest digests |

The release report MUST use `pass`, `fail`, `blocked`, or `not-applicable` for
each cell. `Skipped`, `flaky`, or “works manually” is not a passing state.

### D2. Conformance corpus and result format

ADRs 0020 and 0024 through 0027 define product fixtures. The SDK repository
adds language-neutral scenario manifests:

```text
specs/agentic/
  lock.json
  scenarios/
    shared/
    meta-llm/
    meta-proxy/
    metaharness/
    harnessaas/
  expected/
    <scenario-id>.json
tests/agentic-conformance/
  node/
  python/
  rust/
  compare/
```

Each scenario declares:

```json
{
  "id": "harnessaas.awaiting-approval.approve.v1",
  "contract": "harnessaas/1.0.0",
  "maturity": "stable",
  "capabilities": ["jobs", "approvals"],
  "setup": [],
  "operation": {},
  "expected_requests": [],
  "expected_result": {},
  "expected_events": [],
  "expected_telemetry": [],
  "forbidden_io": [],
  "redaction_sentinels": []
}
```

Language adapters emit canonical JSON with stable field names for comparison.
They MUST omit language formatting differences and MUST retain semantic
differences such as an unknown enum's raw value, a routing decision, an
approval state, an artifact digest, or a retry classification. A comparator
cannot normalize a missing security-significant field into equality.

Every stable operation has at least:

1. one success fixture;
2. one authentication or authorization failure fixture;
3. one validation or protocol failure fixture;
4. one cancellation or timeout fixture when the operation can block;
5. one unknown-field and unknown-enum fixture;
6. one redaction fixture;
7. one capability-missing fixture that proves zero forbidden I/O;
8. one idempotency fixture for a mutation or billable operation.

Preview operations may use a smaller corpus, but MUST include auth, capability,
redaction, timeout, and one successful wire fixture. Internal operations have
no public binding and therefore cannot satisfy a public release claim.

### D3. Pull-request CI matrix

All pull requests touching an SDK, agentic specification, generator, ADR,
fixture, generated file, packaging configuration, or release workflow run an
offline deterministic matrix.

#### Node

```bash
cd sdks/node
npm ci
npm run typecheck
npm test
npm run test:agentic-conformance
npm run build
npm run check:browser-boundaries
npm pack --dry-run
git diff --exit-code -- dist
```

Runtime cells:

| Runtime | Required tests |
|---------|----------------|
| Node 18 | Existing root and Seed tests; imports and remote agentic clients; MetaHarness execution must report Node 20 requirement without side effects |
| Node 20 | Full suite including exact-version MetaHarness process bridge |
| Latest active Node LTS | Full suite and package smoke tests |

Linux runs on every pull request. Windows and macOS run all subprocess,
filesystem, signal, path, certificate, and package-smoke tests on merge queue
or when those areas change. Browser checks bundle `./agentic`, `./meta-llm`,
and the allowed HarnessaaS surface, scan the dependency graph, and execute
basic remote-client fixtures in headless Chromium.

#### Python

```bash
cd sdks/python
python -m pip install --upgrade pip build
python -m pip install -e ".[dev,mdns,otel]"
pytest -q
pytest -q tests/agentic_conformance
python -m build
python -m pip install --force-reinstall dist/*.whl
python -c "import cognitum; import cognitum.agentic"
```

Python 3.10, 3.11, 3.12, and 3.13 run on Linux. The oldest and newest versions
also run on Windows and macOS for process, path, cancellation, and certificate
behavior. Sync and async APIs use the same scenario IDs; an async result cannot
pass a missing sync operation unless the product contract explicitly declares
async-only semantics.

#### Rust

```bash
cd sdks/rust
cargo fmt --check
cargo clippy --all-targets --features "seed,mdns,stream,meta-llm,meta-proxy,metaharness,harnessaas" -- -D warnings
cargo test
cargo test --features "seed,mdns,stream"
cargo test --test agentic_conformance --features "meta-llm,meta-proxy,metaharness,harnessaas"
cargo doc --no-deps --features "meta-llm,meta-proxy,metaharness,harnessaas"
cargo package --list
```

CI installs a pinned `cargo-hack` or runs an explicit generated feature matrix
to prove:

```bash
cargo check --no-default-features --features agentic
cargo check --no-default-features --features "rustls,meta-llm"
cargo check --no-default-features --features meta-proxy
cargo check --no-default-features --features metaharness
cargo check --no-default-features --features "rustls,harnessaas"
```

Rust 1.78 and current stable run on Linux. Stable also runs local-process and
package tests on Windows and macOS. A supported `wasm32` target builds only
portable types and browser-safe remote clients; MetaHarness process code and
Meta Proxy management MUST be absent from its graph.

The fast pull-request matrix SHOULD complete within 20 minutes at p95. The
merge-queue matrix SHOULD complete within 45 minutes at p95. Performance
budgets do not permit dropping a security or feature-isolation cell; slow jobs
are sharded or cached by immutable lock digest.

### D4. Cross-language product matrix

The release report includes this exact matrix:

| Product | Node | Python sync | Python async | Rust | Browser/WASM |
|---------|------|-------------|--------------|------|--------------|
| Meta LLM | required | required | required | required | required for declared remote subset |
| Meta Proxy client | required | required | required where async exists | required | prohibited unless a later browser contract is accepted |
| Meta Proxy manager | required | required if shipped | required if shipped | required if shipped | prohibited |
| MetaHarness | required under Node 20 | required through external Node 20 bridge | required through external Node 20 bridge | required through external Node 20 bridge | prohibited |
| HarnessaaS | required | required | required | required | required for declared remote subset |

The twelve core language-product bindings are the three language families by
four products. Python sync/async and browser/WASM are additional modality
checks, not extra marketing products.

Meta Proxy cannot pass by replaying Meta LLM fixtures against a changed base
URL. Its matrix uses ADR-0025 capability, status, routing-plane, consent,
header-forwarding, failover, and reload scenarios. MetaHarness cannot pass by
shelling out to human-readable CLI output; it uses ADR-0026's structured
bridge. HarnessaaS cannot pass with only `/solve`; it exercises ADR-0027 job,
event, approval, cancellation, artifact, isolation, receipt, and lineage
states.

### D5. Determinism and offline behavior

Pull-request conformance has no dependency on production services, a physical
Seed, npm registry availability, GitHub state, user credentials, or wall-clock
sleep. Tests use:

1. loopback fake HTTP services with contract-defined requests and responses;
2. a checked-in fake MetaHarness executable using the structured bridge;
3. injectable clocks, jitter sources, request IDs, and correlation IDs;
4. bounded in-memory and temporary-directory artifact sinks;
5. deterministic certificate, signature, receipt, and lineage fixtures;
6. explicit network traps that fail on an undeclared destination;
7. process traps that fail on undeclared executable invocation.

Tests that need elapsed time use a virtual clock except for a small process
termination smoke test. No conformance test waits through the default 60-second
budget. Retry schedules are asserted from recorded delays.

Generated wire models are rebuilt in a network-disabled environment from
`specs/agentic/lock.json` and checked-in snapshots. The resulting diff MUST be
empty. Upstream repositories and mutable documentation are not CI inputs.

### D6. Staging and live validation

Offline conformance proves client behavior. It cannot prove deployed
capabilities, authentication configuration, streaming intermediaries,
registry packaging, or cost accounting. Controlled staging tests therefore run
after merge and before a release candidate:

| Target | Frequency | Hard budget and isolation |
|--------|-----------|---------------------------|
| Meta LLM staging | nightly and release candidate | Maximum USD 5 per run, maximum 100 requests, dedicated tenant, no customer prompts |
| Meta Proxy | every merge on isolated loopback runner | No cloud fallback, ephemeral config, synthetic credentials, maximum five minutes |
| MetaHarness | every merge on Node 20 Linux; nightly Windows/macOS | Pinned local package/bridge, synthetic repository, no registry download, maximum five minutes per run |
| HarnessaaS staging | nightly and release candidate | Maximum USD 10 or platform-equivalent quota, dedicated tenant, synthetic repository, maximum three jobs and ten minutes per job |

The combined nightly spend ceiling is USD 20. The test tenant has no access to
customer data or production secrets. If a service cannot enforce the hard
budget server-side, its live test remains disabled and the release cell is
`blocked`, not manually assumed safe.

Production smoke tests are manual release gates, use read-only or explicitly
idempotent operations where possible, and have a combined USD 10 ceiling. No
production smoke test approves a HarnessaaS job, runs unreviewed repository
code, installs MetaHarness, changes Meta Proxy routing, or exercises sponsored
fallback.

### D7. Security, provenance, and evidence gates

Before a release candidate, CI MUST:

1. run ADR-0022 origin-bound credential and cross-tenant isolation tests;
2. run a unique sentinel through config, errors, retries, logs, telemetry,
   receipts, lineage, process argv/env, artifacts, `Debug`, `repr`, JSON, and
   CLI output, then prove the raw value is absent;
3. prove an unknown capability, protocol major, routing plane, consent state,
   isolation mode, signature algorithm, and artifact type fail closed before
   spend, mutation, installation, process execution, approval, or download;
4. audit dependencies and licenses using pinned tool versions;
5. produce CycloneDX or SPDX SBOMs for all three registry artifacts;
6. scan generated and packaged files for secrets, private keys, credentials,
   local paths, and development artifacts;
7. pin GitHub Actions and reusable workflows to immutable commit SHAs;
8. verify contract bundle and generated-artifact digests;
9. verify npm provenance, Python Trusted Publishing configuration, signed Git
   tags, and the crates.io token's least-privilege ownership;
10. attach conformance, compatibility, SBOM, provenance, and package-content
    reports to the release record.

The SDK never treats a server-generated receipt or lineage object as verified
merely because it parsed. ADR-0028 verification status and signer identity are
part of the canonical result and release fixtures.


## Consequences

### Positive

- Cross-language parity becomes an executable property rather than a README
  claim.
- Security, billing, routing, consent, and evidence semantics block release on
  the same footing as type errors.
- Installed-artifact smoke tests expose differences between a passing source
  tree and the package users actually receive.
- Bounded staging spend makes deployed-service validation repeatable and
  governable.

### Negative and trade-offs

- The matrix is materially larger than current language-local CI. Merge-queue
  and nightly sharding add infrastructure cost.
- Cross-platform local-process tests require maintained Windows and macOS
  runners.
- Strict contract gates can delay a client even when one endpoint works in a
  manual test. Preview maturity remains available, but it cannot satisfy a
  stable conformance cell.

### Biggest failure mode and mitigation

The biggest failure mode is false parity: all three source trees pass their own
tests, but one generated contract, feature combination, browser bundle, or
installed artifact differs in a security- or billing-significant way. The
mitigation is one pinned scenario corpus, canonical cross-language comparison,
installed-artifact testing, a twelve-binding traceability report, and immutable
evidence digests consumed by ADR-0030b.

## Alternatives considered

| Option | Pros | Cons | Why rejected |
|--------|------|------|--------------|
| Test only generated clients | Small test surface | Public facades, credentials, errors, packaging, and process behavior remain untested | Generation is only the wire layer |
| Use live services for all integration tests | Exercises deployments | Cost, flakiness, mutable state, credentials, and unavailable historical versions | Offline fixtures are mandatory; bounded staging supplements them |
| Allow known failures indefinitely | Faster merge | New regressions hide behind stale exemptions | Every temporary exception needs owner, issue, exact test, and expiry |

## Compliance and verification

The merge rule MUST require the applicable D3 jobs, contract regeneration,
cross-language comparison, security gates, and installed-package smoke tests.
Release Engineering owns workflow and evidence integrity. Product owners own
their contract bundle and staging capability truth. Language owners own facade
idioms and package integrity. Security owns credential, tenant, consent,
isolation, redaction, provenance, and artifact-verification gates.

The conformance report is immutable input to ADR-0030b. A release workflow MUST
NOT edit, reinterpret, or selectively omit a failing or blocked result.

### Acceptance test

From a clean checkout with external network access disabled, regenerate all
pinned contracts and require an empty diff. Build the Node, Python, and Rust
artifacts, install them in clean runtime cells, and run the complete offline
scenario matrix. Assert canonical equivalence and fail-closed negative behavior
across the twelve core bindings. Then run only the budget-capped staging cells,
bind their outputs and artifact digests into one signed conformance report, and
verify that changing any fixture, result, package, contract lock, or report byte
invalidates that evidence.

## References

- Source: `sdks/node/package.json:2-67` — Node manifest/test baseline
- Source: `sdks/python/pyproject.toml:5-25` — Python manifest/test baseline
- Source: `sdks/rust/Cargo.toml:1-73` — Rust manifest/test baseline
- Source: `.github/workflows/security.yml:1-20` — verified CI workflow
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
- ADR-0030b: migration, rollout, and publication
