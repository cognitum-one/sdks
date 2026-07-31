# Cognitum SDKs

Official client SDKs for the **Cognitum agentic platform** — Node, Python and Rust,
built from one shared contract and released together at a single version.

> This repo used to also hold `sdk-typescript/`, a client for the Cognitum *chip
> simulator* (`@ruv/cognitum-sdk`). That is gone — removed 2026-04-22, see
> `docs/adr/0012-sdk-typescript-supersession.md` (Status: Executed). If you find a
> reference to a chip simulator, `sdk-typescript/`, `@ruv/cognitum-sdk`, RxJS, or
> `CognitumSDK.create()`, it is stale and should be deleted rather than followed.

## Packages

All three ship the **same version at the same time**; a release tags one version and
publishes to all three registries.

| Path | Package | Registry | Runtime | Install |
|------|---------|----------|---------|---------|
| `sdks/node` | `@cognitum-one/sdk` | npm | Node >= 18 | `npm install @cognitum-one/sdk` |
| `sdks/python` | `cognitum-sdk` (imports as `cognitum`) | PyPI | Python >= 3.10 | `pip install cognitum-sdk` |
| `sdks/rust` | `cognitum-one` | crates.io | edition 2021, stable | `cargo add cognitum-one` |

The Python **distribution** is `cognitum-sdk` but the **import** is `cognitum` — the
PyPI name `cognitum` belongs to an unrelated third party. The Node package also
installs two executables, `cognitum` and `cognitum-sdk`.

## Product clients

One shared `agentic` core (credentials, error taxonomy, retry/idempotency, receipts
and lineage, redaction, W3C trace-context) plus per-product namespaces. Maturity is
not uniform and the difference matters — `capabilities/sdk-release.v1.json` is the
machine-readable source of truth, not this table.

| Client | Maturity | What it actually does |
|--------|----------|----------------------|
| `agentic` | available | Shared contract layer every product client builds on |
| `meta-llm` | available | Real HTTP client for the six serving protocols, streaming included |
| `meta-proxy` | available | Local data-plane client; sponsor/budget ops are fail-closed stubs |
| `harnessaas` | available | Only the deployed synchronous surface: health, solve, lineage |
| `metaharness` | **contract_preview** | Typed surface, every operation a fail-closed stub — no I/O at all |

`metaharness` is a contract preview because the upstream OSS bridge protocol does not
exist yet. Do not describe any `MetaHarnessClient` method as working.

## Layout

```
sdks/{node,python,rust}/   the three SDKs
sdks/fixtures/             cross-language conformance corpora (see below)
capabilities/              sdk-release.v1.json + its schema (public capability claims)
scripts/                   release/verification tooling + its own node:test suites
docs/adr/                  33 cross-cutting ADRs
sdks/*/docs/adr/           per-SDK ADRs (node 5, python 5, rust 7)
```

This repo has **no submodules**. It used to carry the `seed` firmware repo as one,
which was the wrong dependency direction — the seed repo vendors these SDKs as
`external/sdks`, so the pair would have become circular. Removed in #35. Consumers do
not need firmware source to use the packages. Some ADRs still cite evidence at paths
like `/home/ruvultra/projects/sdks/seed/...`; those are historical provenance
pointers, not build inputs, and they do not resolve.

## Build & test

Run from each SDK's own directory. `npm test` is `vitest run`, so there is no watch
mode to hang a non-interactive session.

```bash
cd sdks/node    && npm ci && npm run build && npm test && npm run typecheck && npm run lint && npm audit --audit-level=high
cd sdks/python  && pip install -e ".[dev]" && pytest && ruff check . && mypy
cd sdks/rust    && cargo build --features "$FEATURES" && cargo test --features "$FEATURES" && cargo clippy --all-targets --features "$FEATURES" -- -D warnings
cd .            && node --test scripts/tests/*.test.mjs     # the release tooling's own suite
```

`$FEATURES` is `native-tls,seed,stream,blocking,mdns,meta-llm,meta-proxy,metaharness,harnessaas`
— every feature **except** `live-seed-tests`, which dials a real device over an SSH
tunnel.

Set `SKIP_SEED_INTEGRATION=1` for Node and Python. The live-seed suites self-skip
without a reachable device, but pinning it means a run never depends on whatever
happens to be listening on the tunnel port.

## What CI actually runs

`.github/workflows/ci.yml` is authoritative — read it rather than trusting this
section, which can rot. Four workflows exist: `ci`, `security`, `release`,
`live-smoke`.

**`ci` (every PR and push to main)** — eight job groups:

| Job | What it proves |
|-----|----------------|
| `security` | Org-wide reusable scan (secrets + OSV deps, fails on High+ **fixable**), pinned by SHA so its semantics can't shift under a reviewed commit |
| `node` | ubuntu/macos/windows: build, test, typecheck, lint, `npm audit --audit-level=high` |
| `python` | ubuntu/macos/windows: pytest (`--no-cov`), ruff, mypy |
| `rust` | ubuntu/macos/windows: build, test, clippy `-D warnings`, all features |
| `rust-feature-matrix` | 14 combos — each feature built **alone** on top of `default`, so a feature that only compiles alongside another is caught |
| `capability-manifest` | Validates the manifest against its schema, then re-checks each claimed `registryVersion` against the **live** npm/PyPI/crates.io APIs |
| `coverage` | Thresholds for all three languages, Linux only |
| `ga-gate` | Aggregate. **Its `needs` list is the definition of "CI is green"** |

**`ga-gate` is the only required status check on `main`, and the only CI result
`release.yml` consults before publishing.** Any job missing from its `needs` is
silently advisory — that is not hypothetical, `rust-feature-matrix` and
`capability-manifest` were both omitted at one point. **Adding a job to `ci.yml` means
adding it to `ga-gate.needs`.** The job itself also enforces the GA rule: an operation
claiming `stable` in the manifest must cite executable conformance tests in all three
languages, plus security and artifact evidence.

**`live-smoke`** (daily, after a successful release, on demand) — installs the
**published** SDK from npm into a clean directory and drives it against live
`api.cognitum.one`. Every other suite runs against mocks, so this is the only check
that would notice the gateway changing a route or a response shape. Assertions are on
**semantics, not status codes**: a 200 carrying an empty completion is a failure.

**`release`** — tag-triggered, see `.github/RELEASE-SETUP.md`.

### Test inventory (measured 2026-07-31, after #128 and #75)

| Suite | Passing | Kind |
|-------|---------|------|
| node (vitest) | 675 (+8 skipped) | unit, wire-protocol, retry/idempotency, streaming decoders, ADR-compliance, mocked HTTP |
| python (pytest) | 727 (+11 skipped) | same contracts via respx |
| rust (cargo test) | 569 | unit + 36 integration files |
| `scripts/` (node:test) | 34 | release tooling: preflight, GA gate, manifest validator, smoke scripts |

### Cross-language conformance (`sdks/fixtures/`)

The corpora that catch the three SDKs disagreeing. Each language's own suite only
ever checks that language against itself; these are the tests where Node, Python and
Rust are compared to each other. Governed by ADR-0030a §D1.

| Corpus | Catches |
|--------|---------|
| `receipt-canonicalization/` | Canonical-JSON drift — key casing, number formatting, key order |
| `error-mapping/` | Error semantics — kind, retryability, `Retry-After`, upgrade affordance |
| `wire/` | Request bodies — that an unset optional is **absent**, never `null` |

**Every language's behaviour on every case is pinned.** Where the three genuinely
differ, the case carries a `knownDivergence` block naming the language and its actual
result, so a divergence is a declared fact rather than absent coverage — and adding a
new one means editing the corpus on purpose. Every corpus records, in a `bugContext`
field, the real bug that motivated it — each found a live cross-SDK defect on the day it
was written, and `wire/` found two shipped SDKs that could not call production at all.

Live-device suites exist in all three languages but are excluded from CI.

### Coverage thresholds

A **ratchet against regression**, not a target. Raise them when coverage rises; never
lower one to make a build pass.

| SDK | Floor | Enforced by |
|-----|-------|-------------|
| node | 83.5% statements/lines, 77.5% branches, 92.5% functions | `sdks/node/vitest.config.ts` |
| python | 85% (**branch coverage on**) | `--cov-fail-under` in `pyproject.toml` |
| rust | 79% lines/regions, 77% functions | `cargo llvm-cov --fail-under-*` in `ci.yml` |

Two things to know. The Python number is **not** comparable to a line-only figure —
the same suite reads 89% without branch coverage; the branch number is the honest one.
And vitest sets `all: true` deliberately: without it, v8 reports only files some test
imported, so deleting the last test touching a module makes coverage go *up*.

Thresholds live in each language's own config so a local run enforces the same bar CI
does. They are checked once, on Linux — coverage measures which lines the tests reach,
which doesn't vary by runner.

## Releasing

Read `.github/RELEASE-SETUP.md`. Short version: bump all three packages plus the
manifest's `sourceVersion`s together, merge, then push a `v*.*.*` tag from that exact
`main` commit. The workflow builds once, publishes npm → PyPI → crates.io, then
verifies registry digests against the artifacts it built.

Registry uploads are **immutable** and there is no atomic three-registry commit. Never
retag or reuse a version. Rehearse on a prerelease tag (`v0.3.1-rc.1` → npm dist-tag
`next`) before a real one.

## Critical rules

- **NEVER** commit secrets, credentials or `.env` files.
- **ALWAYS** run the full per-language gate before committing — build, test, typecheck
  and lint, not just tests.
- A new job in `ci.yml` **MUST** be added to `ga-gate.needs`, or it gates nothing.
- Never widen a claim in `capabilities/sdk-release.v1.json` without the evidence the
  GA gate demands. The manifest is a public statement about what users can rely on.
- `metaharness` operations do not work. Do not document them as if they do.
- Keep files under 500 lines; typed interfaces for all public APIs; validate input at
  system boundaries.
- ADRs in `docs/adr/` are living plans. If a change contradicts one, update it in the
  same piece of work.
