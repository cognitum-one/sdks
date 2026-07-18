# ADR 0029: Language Packaging, Features, and CLI Boundaries

- **Status:** Proposed
- **Date:** 2026-07-18
- **Deciders:** Cognitum SDK Working Group, Developer Experience, Release Engineering, Security, MetaHarness owner
- **Scope:** cross-cutting (`sdks/node`, `sdks/python`, `sdks/rust`)

## Context

ADRs 0019 through 0028 introduce four independent agentic clients and the
shared contracts they require. Packaging is part of the security and
compatibility design, not a final publishing detail. A dependency imported for
local MetaHarness execution must not appear in a browser Meta LLM bundle. A
Rust feature selected for HarnessaaS must not silently compile Meta Proxy or
Seed support. Importing the Python package must not launch Node, probe a local
proxy, or pay the import-time cost of every product.

The current package baseline on `main` is:

| Language | Registry identity | Manifest version | Runtime floor | Current public packaging |
|----------|-------------------|------------------|---------------|--------------------------|
| Node | `@cognitum-one/sdk` | `0.2.1` | Node `>=18` | Root ESM/CJS export, `./seed`, `./seed/discovery/mdns`, `cognitum` and `cognitum-sdk` bins |
| Python | `cognitum` | `0.2.0` | Python `>=3.10` | One wheel/sdist, lazy root imports, optional `mdns` extra, no console script |
| Rust | `cognitum-one` | `0.2.1` | Not declared in the manifest | One crate, default `rustls`, optional `native-tls`, `seed`, `stream`, `blocking`, `live-seed-tests`, and `mdns` features |

Evidence is in `sdks/node/package.json:2-67`,
`sdks/python/pyproject.toml:5-25`, and `sdks/rust/Cargo.toml:1-73`.
The root changelog records a further release reality: npm and crates.io have
the `0.2.1` renamed packages, while PyPI was still at `0.0.1.dev2` when that
entry was written (`CHANGELOG.md`, section `0.2.1`). Registry state MUST be
reverified during ADR-0030's release gate; a manifest version is not proof of a
published artifact.

The reviewed MetaHarness source manifest reports `0.4.1`, while the npm registry
publishes `0.4.0` at the 2026-07-18 audit. The source requires Node 20 and is
invoked interactively through `npx metaharness` or a programmatic TypeScript
surface. Raising the entire Node SDK from Node 18 to Node 20 would impose a
runtime migration on cloud and Seed consumers who never use MetaHarness.
Conversely, pretending Python or Rust can execute local MetaHarness without a
Node runtime would make installation appear successful and defer failure until
the first process run.

The current repository also has packaging and documentation drift that must
not be copied into the agentic surface:

1. The root README reports all SDKs as `0.2.0`, while Node and Rust manifests
   are `0.2.1`.
2. Node source and several ADRs still show the abandoned `@cognitum/sdk`
   import, although the package is `@cognitum-one/sdk`.
3. Rust examples use `cognitum_rs` or `cognitum`; the current package normally
   imports as `cognitum_one` because there is no overriding `[lib] name`.
4. `sdks/rust/src/lib.rs` and the Rust changelog still identify the previous
   `cognitum-rs` crate.
5. The root README claims 71 typed Seed endpoints, while per-language READMEs
   and the release changelog describe the 12 shipped Phase 1 endpoints.
6. `CLAUDE.md` still describes the removed `sdk-typescript/` simulator as the
   primary package.
7. The Node ADR index states Node 20, while the package manifest and README
   state Node 18.

These inconsistencies are a release blocker because users select package names,
runtime versions, and features from these documents.

## Decision

Keep one registry package per language. Add agentic functionality through Node
subpath exports, lazy Python modules, and independent Rust features. Preserve
the existing cloud and Seed entry points. Keep browser-safe remote clients
separate from local process, loopback, filesystem, and installation code. The
first coordinated agentic release target is `0.3.0`; it is published only after
ADR-0030's baseline, contract, conformance, and registry gates pass.

### D1. Normative public namespace map

The package topology from ADR-0019 is binding:

| Context | Node export | Python module | Rust module | Rust feature |
|---------|-------------|---------------|-------------|--------------|
| Shared contracts | `@cognitum-one/sdk/agentic` | `cognitum.agentic` | `cognitum_one::agentic` | included with every agentic product feature |
| Meta LLM | `@cognitum-one/sdk/meta-llm` | `cognitum.meta_llm` | `cognitum_one::meta_llm` | `meta-llm` |
| Meta Proxy | `@cognitum-one/sdk/meta-proxy` | `cognitum.meta_proxy` | `cognitum_one::meta_proxy` | `meta-proxy` |
| MetaHarness | `@cognitum-one/sdk/metaharness` | `cognitum.metaharness` | `cognitum_one::metaharness` | `metaharness` |
| HarnessaaS | `@cognitum-one/sdk/harnessaas` | `cognitum.harnessaas` | `cognitum_one::harnessaas` | `harnessaas` |

The existing root `Cognitum` client MUST NOT eagerly create these clients or
gain four new properties. Existing root, Seed, and MCP imports retain their
current behavior. A future convenience holder may compose explicitly-created
clients as permitted by ADR-0019, but it cannot become a router or policy
engine.

### D2. Node package and subpath exports

`sdks/node/package.json` MUST add explicit exports. Each export has its own
`tsup` entry and declaration output:

```json
{
  "exports": {
    ".": {},
    "./seed": {},
    "./seed/discovery/mdns": {},
    "./agentic": {},
    "./meta-llm": {},
    "./meta-proxy": {},
    "./metaharness": {},
    "./harnessaas": {}
  }
}
```

The elided conditions above retain the existing `types`, `import`, and
`require` layout. New entries MUST generate both ESM and CJS unless a concrete
dependency cannot support CJS. Any exception requires its own compatibility
note and import test; a silent format difference is forbidden.

The dependency and environment boundaries are:

| Export | Browser import permitted | Node floor | Mandatory new runtime dependency |
|--------|--------------------------|------------|----------------------------------|
| `./agentic` | yes | 18 | none |
| `./meta-llm` | yes, subject to service CORS and delegated-token policy | 18 | none beyond the existing HTTP stack |
| `./harnessaas` | yes for HTTP, events, and in-memory results; no local file sink | 18 | none beyond the existing HTTP stack |
| `./meta-proxy` | no | 18 | none for client-only status and inference; manager dependencies remain optional |
| `./metaharness` | no | 20 for local execution | no mandatory dependency in the base package |

`./agentic`, `./meta-llm`, and the browser subset of `./harnessaas` MUST have no
transitive import of `node:child_process`, `node:fs`, `node:path`,
`node:worker_threads`, `node:net`, `node:tls`, Meta Proxy management, or
MetaHarness execution code. Browser builds may use Web `fetch`,
`ReadableStream`, `AbortSignal`, and Web Crypto APIs through narrow adapters.

Browser clients MUST NOT read process environment variables. They require
explicit configuration and SHOULD use a short-lived delegated credential. The
SDK documentation MUST warn that a long-lived Cognitum API key is not suitable
for untrusted browser code. Meta Proxy is excluded because its loopback token,
local consent, process ownership, and CORS behavior are not a browser contract.
MetaHarness is excluded because it reads repositories and launches processes.

Forbidden exports MUST fail at build time where conditional exports can make
that deterministic. If a bundler resolves a Node-only entry for a browser
target, construction MUST throw `UnsupportedRuntimeError` before reading a
credential, opening a socket, importing an installer, or executing a process.

### D3. Optional Node 20 MetaHarness runtime

The package-level Node engine remains `>=18` for `0.3.x`. The MetaHarness
subpath performs a side-effect-free runtime capability check and returns a
typed configuration error when local execution is attempted under Node 18 or
19. Merely importing types or constructing a client under Node 18 remains
valid.

MetaHarness resolution follows ADR-0026 and this packaging order:

1. injected structured bridge;
2. explicit executable path whose handshake proves the OSS MetaHarness product
   identity, protocol, version, and expected integrity;
3. an SDK-managed, content-verified exact `metaharness` distribution acquired
   explicitly under ADR-0026b.

`metaharness@latest`, a mutable Git branch, and an unspecified package version
are invalid. Automatic `PATH`, project-dependency, global-cache, and `npx`
discovery are also invalid because the OSS and private Cognitum products both
claim the `metaharness` binary name and npm execution cannot satisfy the locked
dependency and lifecycle-script policy. Interactive `npx metaharness` remains
a user workflow; the SDK integrates the same OSS product through the verified
bridge. The initial source-reviewed compatibility candidate is exact version
`0.4.1`; it cannot be acquired from the registry until that artifact is
published, its content and dependency integrity are locked, and its bridge
passes ADR-0026 conformance. Widening the entry requires ADR-0020 contract
fixtures and is not inferred from SemVer alone.

`metaharness` MUST NOT become a mandatory `dependencies` entry of
`@cognitum-one/sdk`. A compatible package MAY be declared as an optional peer
dependency only under a future ADR that preserves the exact bridge, integrity,
and cross-language semantics. It is not part of this decision. A missing local
distribution affects only `./metaharness`, never installation or import of the
root, Meta LLM, Meta Proxy client, HarnessaaS, or Seed surface.

### D4. Node build artifacts and bundle budgets

The Node package currently publishes checked-in `dist/` output. Until a
separate ADR changes that policy:

1. every new entry has ESM, CJS, declaration, and source-map outputs;
2. `npm run build` followed by `git diff --exit-code -- sdks/node/dist` is a
   release gate;
3. `npm pack --dry-run` MUST contain only allowlisted artifacts;
4. source and generated entry lists MUST be compared mechanically;
5. a clean root import MUST not load an agentic product module.

The root bundle receives no new product implementation and may grow by at most
5 KiB gzip for shared error or export metadata. Each browser-safe agentic
subpath has an initial budget of 35 KiB gzip, excluding consumer-supplied HTTP
and telemetry implementations. Exceeding a budget requires a measured bundle
report in the release pull request and explicit Developer Experience approval.

### D5. Python modules, lazy imports, and extras

All five new Python namespaces ship in the existing `cognitum` wheel. They
MUST use the package's existing PEP 562 lazy import pattern. `import cognitum`
and `import cognitum.seed` MUST NOT import `subprocess`, an agentic HTTP client,
an event parser, MetaHarness, or Meta Proxy management code.

`pyproject.toml` retains `httpx` as the base transport. Optional dependencies
are capability-oriented rather than product aliases:

```toml
[project.optional-dependencies]
mdns = ["zeroconf>=0.131"]
otel = ["opentelemetry-api>=1,<2"]
dev = ["pytest>=8", "pytest-asyncio>=0.23", "respx>=0.21"]
```

MetaHarness does not receive a misleading Python dependency extra. Its module
is present, but `capabilities()` reports whether a compatible Node 20 runtime
and exact MetaHarness bridge are available. Missing Node or MetaHarness returns
a typed local capability error before process execution. Installing a Python
wheel MUST never download an npm package.

An aggregate `agentic-all` extra MAY be added only if there are two or more
real optional Python libraries. It MUST be the union of documented extras and
must not include Node, npm, an executable installer, a cloud credential, or a
platform-specific binary.

The base import-time regression budget is the larger of 5 milliseconds or ten
percent against the tagged `0.2.x` median on the same CI runner, measured over
50 fresh interpreter processes. Import timing is an advisory gate on pull
requests and a blocking gate if the median exceeds both thresholds.

### D6. Rust modules and independent features

The Rust crate identity remains `cognitum-one`; all new documentation and
tests use the import name `cognitum_one`. The manifest MUST declare an MSRV of
Rust 1.78 unless a separately-reviewed compatibility test proves a lower
floor. The existing `rustls` default remains unchanged.

Product features are independent leaves over private shared primitives:

```toml
[features]
agentic = []
meta-llm = ["agentic"]
meta-proxy = ["agentic"]
metaharness = ["agentic", "tokio/process", "tokio/io-util"]
harnessaas = ["agentic"]
```

The final dependency expressions may include private shared HTTP and event
features, but these invariants are mandatory:

1. no product feature enables another product feature;
2. `meta-llm`, `meta-proxy`, `metaharness`, and `harnessaas` each compile with
   `--no-default-features` plus only the TLS or runtime feature they require;
3. the `metaharness` module is unavailable on `wasm32` except for portable
   types and an `UnsupportedRuntimeError` constructor path;
4. remote Meta LLM and HarnessaaS types can compile for a browser/WASM client
   only if their HTTP and entropy adapters support that target;
5. optional process and event dependencies do not enter the default crate
   graph;
6. docs.rs builds the documented feature set without enabling mutually
   exclusive TLS configurations.

The existing `stream = ["seed", ...]` feature cannot be reused as a generic
agentic streaming flag. `0.3.0` introduces a private or public shared event
feature, while retaining `stream` as the Seed compatibility alias for at least
the ADR-0006 deprecation window. Meta LLM and HarnessaaS select only the shared
event implementation, not the Seed module.

`ClientConfig`, clients, and builders MUST NOT derive a secret-revealing
`Debug`. ADR-0022's redacting credential provider applies before new product
features are released.

### D7. CLI scope and stability

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

### D8. Compatibility and migration

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

### D9. Phased dependency gates

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

### D10. Expected implementation layout

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

- Existing cloud and Seed consumers do not acquire Node 20, process, proxy, or
  registry-install requirements.
- Browser bundles have an auditable boundary and cannot accidentally include
  local execution code.
- Python preserves its low-cost lazy import design.
- Rust consumers pay compile time only for explicitly-selected products.
- One canonical CLI keeps machine output, consent, and credentials consistent
  across products.

### Negative and trade-offs

- Node cannot express a different engine floor for one subpath in package
  metadata, so MetaHarness must enforce Node 20 at execution and document it
  prominently.
- Python and Rust MetaHarness users need an external Node 20 runtime. This is
  explicit rather than hidden behind a misleading language package.
- Independent Rust features and Node entrypoints expand the CI matrix.
- Checked-in Node build output creates a deterministic-diff burden until the
  repository adopts a different generated-artifact policy.

### Biggest failure mode and mitigation

The biggest failure mode is allowing local process and installation code to
leak into the base or browser-safe packages, which could raise every user's
runtime floor, enlarge the attack surface, and permit unexpected registry or
process activity. The mitigation is explicit subpaths/modules/features,
side-effect-free imports, Node 20 enforcement only at MetaHarness execution,
zero mandatory MetaHarness dependency, and bundle/import conformance tests.

## Alternatives considered

| Option | Pros | Cons | Why rejected |
|--------|------|------|--------------|
| Raise all Node SDK users to Node 20 | Simple engine declaration | Breaks unrelated Node 18 cloud and Seed consumers | Only MetaHarness requires Node 20 |
| Publish four packages per language | Strongest release isolation | Twelve new registry identities, discovery and versioning fragmentation | Existing subpath/module/feature architecture already isolates dependencies |
| Install MetaHarness as a mandatory dependency | First run appears simple | Large dependency and supply-chain impact for every user | Exact, consented, optional execution is safer |
| Add Python and Rust CLIs immediately | Surface symmetry | Three parsers, output contracts, credential paths, and release targets | Language SDK parity does not require CLI duplication |
| Put all Rust products behind one `agentic` feature | Small manifest | Prevents minimal builds and hides product dependencies | ADR-0019 requires independent contexts |
| Allow browser access to loopback Meta Proxy | Potential local web UI | CORS, token, consent, and local-process boundary are not defined for browsers | Browser access requires a separate product contract and threat model |

## Compliance and verification

CI MUST verify:

1. every documented Node subpath resolves in ESM and CJS;
2. browser bundles for shared contracts, Meta LLM, and HarnessaaS contain no
   Node built-ins or local product code;
3. Node 18 can import every portable subpath, while MetaHarness execution fails
   locally with the expected Node 20 requirement and performs zero I/O first;
4. Node 20 runs the pinned MetaHarness bridge tests;
5. `import cognitum` remains lazy and every new Python module imports alone;
6. each Rust product feature compiles alone with `--no-default-features`, all
   supported combinations compile, and `wasm32` excludes local process code;
7. package contents contain no credential, test fixture secret, private source,
   unreviewed generated file, npm cache, or local binary;
8. root imports do not load product implementations;
9. CLI JSON output contains no log line and secret values never appear in
   argv, stdout, stderr, process environment snapshots, or error strings;
10. all examples use current package and crate names.

### Acceptance test

From clean Node 18, Node 20, Python 3.10, and Rust 1.78 environments, package
all three SDKs. Import each new namespace independently with network disabled
and process execution trapped. Assert zero side effects. Bundle each permitted
browser entry and scan its module graph for forbidden Node built-ins. Build
each Rust feature alone. Under Node 18, assert only local MetaHarness execution
returns `UnsupportedRuntimeError`; under Node 20, run the exact pinned
bridge fixture. Rebuild checked-in Node artifacts and require an empty diff.

## References

- ADR-0006: cross-cutting versioning
- ADR-0007: cross-cutting security model
- ADR-0011: cloud and Seed package topology
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
- ADR-0030: conformance, release, migration, and rollout
