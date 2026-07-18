# ADR 0020: Agentic Contract Source of Truth and Code Generation

- **Status:** Proposed
- **Date:** 2026-07-18
- **Deciders:** Cognitum SDK Working Group, product API owners, Developer Experience, Security
- **Scope:** cross-cutting (`sdks/node`, `sdks/python`, `sdks/rust`)

## Context

Cross-language SDK parity requires a language-neutral contract. None of the four
target products currently provides a complete, current, neutral contract:

- MetaHarness exposes TypeScript functions and a CLI. Some commands offer JSON,
  while others return human-oriented lines. Its manifests also carry version
  values that are not aligned with the package version.
- Meta LLM's registered routes in `src/server.ts` are materially broader than
  the introductory route table in its README
  (`cognitum-one/meta-llm@948bd31a:src/server.ts:72-119`).
- Meta Proxy's README describes the supported local routes, but route behavior
  and forwarded headers have already drifted from some documentation claims.
- HarnessaaS's Swagger 2 document specifies Google ID-token auth and three
  routes, while current source uses Cognitum API keys and has a much larger
  surface (`cognitum-one/harnessaas@908e4a99:config/api-gateway.openapi.yaml:16-85`).

Generating public clients from those artifacts would turn documentation drift
into three incompatible SDKs. Handwriting all wire types would hide the drift
until runtime. A stable contract ingestion and validation boundary is therefore
a prerequisite, not a polish task.

## Decision

Each product MUST publish a versioned Cognitum contract bundle. The SDK repo
MUST pin an immutable snapshot of each accepted bundle, generate internal wire
models from it, and expose reviewed handwritten domain facades. No GA SDK method
may be derived solely from a README, current implementation source, or live
service observation.

### D1. Contract bundle

The upstream canonical bundle has this layout:

```text
contract/
  manifest.json
  openapi.json                 # HTTP products only, OpenAPI 3.1
  schemas/
    capabilities.schema.json
    errors.schema.json
    events/*.schema.json
    receipts/*.schema.json
  fixtures/
    requests/*.json
    responses/*.json
    events/*.ndjson
  CHANGELOG.md
```

MetaHarness substitutes `bridge.schema.json` for `openapi.json`; its structured
process protocol is defined by ADR-0026a. Schemas MUST use JSON Schema 2020-12.
OpenAPI documents MUST reference the same JSON Schemas rather than maintaining
parallel shapes.

The SDK repo stores immutable reviewed snapshots at:

```text
specs/agentic/<product>/v<contract-major>/
```

It also stores `specs/agentic/lock.json`, containing:

```json
{
  "meta-llm": {
    "source_repository": "cognitum-one/meta-llm",
    "source_revision": "<40-character commit>",
    "product_version": "<semver>",
    "contract_version": "1.0.0",
    "protocol": "cognitum.meta-llm.http",
    "protocol_version": "1.0",
    "sha256": "<bundle digest>"
  }
}
```

Mutable branches, tags without a resolved commit, registry `latest`, and live
URLs are forbidden in the lock file.

### D2. Manifest requirements

`manifest.json` MUST declare:

| Field | Purpose |
|-------|---------|
| `product` | Stable identity: `metaharness-oss`, `meta-llm`, `meta-proxy`, or `harnessaas` |
| `product_version` | Product SemVer that emitted the bundle |
| `contract_version` | SemVer for the complete contract bundle |
| `protocol` | Stable wire identity, such as `cognitum.meta-llm.http` or `cognitum.metaharness.bridge` |
| `protocol_version` | Independent wire version in `<major>.<minor>` form |
| `source_revision` | Immutable source commit |
| `maturity` | Per-operation `stable`, `preview`, or `internal` |
| `auth` | Accepted credential types and required scope per operation |
| `idempotency` | Whether and how each mutation deduplicates |
| `streaming` | Media type, event schemas, terminal event, and resume behavior |
| `limits` | Request, response, event, field, and collection maxima |
| `errors` | Status/code mappings and retryability |
| `capabilities` | Runtime feature names and prerequisites |
| `privacy` | Fields classified as secret, personal data, source content, or telemetry-safe |
| `deprecations` | Replacement and removal version for deprecated fields and operations |

The manifest is rejected if a mutating or billable operation omits its auth,
scope, idempotency, maturity, or error declaration.

### D3. Protocol identity and negotiation

HTTP clients send:

```text
User-Agent: cognitum-<language>/<sdk-version>
Cognitum-Protocol-Version: <supported-major>.<preferred-minor>
X-Request-ID: <uuid or caller value>
```

Servers return the selected `Cognitum-Protocol-Version` and a request ID. If a
deployed product cannot yet return the version header, an exact product version
may map to a static compatibility entry. An unknown deployment is treated as
minimum-safe, read-only capability until it proves more.

MetaHarness applies the same negotiation rule to its distinct
`cognitum.metaharness.bridge` protocol in the first bridge message. Meta
Proxy capability discovery occurs through authenticated status/capabilities,
never by sending a speculative inference request.

Only the major protocol version selects incompatible wire semantics. Product
version, contract version, and SDK version never substitute for the protocol
version. Contract and protocol versions are independent: a bundle-only change
can increment `contract_version` without changing wire grammar, while an
incompatible wire change increments `protocol_version` major and the contract
bundle that describes it.

### D4. Endpoint origins

The SDK MUST NOT invent production origins. Until an accepted contract bundle
declares a stable origin, Meta LLM and HarnessaaS require either an explicit
`base_url` or their documented environment variable:

```text
COGNITUM_META_LLM_URL
COGNITUM_HARNESSAAS_URL
```

Explicit constructor configuration wins over environment configuration.
Environment lookup happens during client construction and the resolved value is
stored. It is not re-read per request. HTTPS is mandatory except for loopback or
an explicit insecure-development opt-in covered by ADR-0022.

Meta Proxy defaults to `http://127.0.0.1:11435` because the loopback origin is
part of its current local contract. MetaHarness command discovery is defined in
ADR-0026b and is not an HTTP origin.

### D5. Generation boundary

Code generation produces only internal wire artifacts:

```text
spec snapshot -> generated DTOs/codecs -> handwritten domain facade -> user
```

Generated output MUST NOT be the public ergonomic client. The facade is where
the SDK:

- uses language conventions without changing wire casing;
- represents secrets with redacting wrapper types;
- attaches request context and credential providers;
- maps errors to ADR-0004 and ADR-0023;
- checks capabilities before I/O;
- normalizes operations without discarding product states;
- preserves unknown response fields and event variants for forward
  compatibility;
- validates security-significant invariants that JSON Schema cannot express.

Generated files are checked in so releases are reproducible without fetching
another repository. CI regenerates them in a clean environment and requires an
empty diff.

### D6. Forward compatibility rules

| Change | Contract SemVer | SDK behavior |
|--------|-----------------|--------------|
| New optional response field | Minor | Preserve and ignore safely if unknown |
| New enum member | Minor when consumers retain an `unknown` representation | Map to `unknown(raw)` rather than fail decoding |
| New optional request field | Minor | Expose only after facade review |
| New route or capability | Minor | Disabled until capability manifest and fixture exist |
| New required request/response field | Major | Reject in minor contract review |
| Changed auth, consent, idempotency, billing, or tenant semantics | Major unless strictly additive | Requires explicit ADR review |
| Removed field or route | Major | Follow ADR-0006 deprecation window |

Security-sensitive enums such as routing plane, consent state, isolation level,
and signature algorithm MUST NOT map unknown values to a permissive default.
They map to `unknown` and block the dependent action.

### D7. Runtime validation

Request validation occurs before credential acquisition where possible.
Response and event validation is bounded:

- maximum JSON nesting depth: 64;
- maximum error body retained: 64 KiB;
- maximum diagnostic line: 1 MiB;
- default buffered non-artifact response: 16 MiB;
- collections use contract-declared maxima and reject unreasonable lengths;
- unknown content types are rejected before parsing;
- decompressed size, not compressed size, controls limits.

Large HarnessaaS artifacts and diagnostic bundles stream to an explicit sink;
they are never accumulated under the ordinary JSON limit.

Validation failures return `ProtocolError` with product, operation, protocol
version, request ID, and a redacted JSON path. Raw secret or source content MUST
NOT appear in the exception string.

### D8. Drift workflow

A `contract-sync` tool in the SDK repo performs:

1. fetch the exact upstream revision requested by a human;
2. verify the bundle digest and manifest schema;
3. diff semantic operations, fields, auth, scope, error, consent, isolation,
   billing, and maturity changes;
4. regenerate internal models;
5. run all product fixtures in all languages;
6. emit a review report grouped by breaking, security-sensitive, and additive
   changes;
7. update the lock only in the same reviewed pull request.

The tool MUST NOT automatically accept or publish a new contract. CI may report
that upstream moved, but a moving upstream branch is not a build input.

The sole generator is a private repository tool named
`@cognitum-one/agentic-codegen`, initially version `0.1.0`, under
`tools/agentic-codegen/`. Its exact package dependency graph is locked by the
root npm lockfile; installation uses `npm ci --ignore-scripts`. It emits only
the internal models and codecs described in D5. The deterministic commands are:

```text
npm run codegen:agentic -- --language node --out sdks/node/src/generated/agentic
npm run codegen:agentic -- --language python --out sdks/python/cognitum/_generated/agentic
npm run codegen:agentic -- --language rust --out sdks/rust/src/generated/agentic
npm run codegen:agentic -- --all --check
```

Every invocation consumes only `specs/agentic/lock.json` and its local immutable
snapshots, sorts products/files/fields deterministically, writes LF and UTF-8,
and emits a header with generator version, source lock digest, and contract
bundle digest. `--check` renders to a temporary directory and fails on any byte
diff. CI runs it with registry and network access denied. A generator or custom
template change requires its own reviewed commit and regeneration diff; no
language-specific generator may silently become a second source of truth.

### D9. Reconciliation gate for the current products

Before the first SDK implementation release, product owners must complete these
gates:

| Product | Blocking reconciliation |
|---------|-------------------------|
| MetaHarness | One structured, versioned bridge for every SDK-supported command; package, generator, and template version fields corrected |
| Meta LLM | Publish registered stable routes, SSE events, scope rules, errors, and `x_cognitum` schemas from the same source used by the server |
| Meta Proxy | Publish the actual subset, forwarded-header allowlist, plane metadata, streaming limits, and status/capabilities schema |
| HarnessaaS | Replace stale Swagger 2, resolve current auth, define asynchronous job semantics, declare executor isolation, and publish signed evidence schemas |

An implementation MAY ship behind a preview feature against a pinned static
compatibility table. It MUST NOT be labeled GA or feature-complete until its
gate is satisfied.

## Consequences

### Positive

- Contract drift becomes a reviewable diff instead of a production surprise.
- One fixture corpus drives Node, Python, and Rust parity.
- Handwritten public APIs remain usable while generated wire models remain
  mechanically accurate.
- Security and billing changes receive the same review status as field-level
  breaking changes.

### Negative and trade-offs

- Each product must own contract publication. Initial bundle creation is
  estimated at three to five engineering days for Meta LLM, two to three for
  Meta Proxy, four to seven for HarnessaaS, and two to four for MetaHarness.
- Checked-in generated code increases repository size and review noise. Semantic
  diff reports and generated-file ownership mitigate this.
- Strict GA gates delay broad surface claims. Preview bindings remain possible
  for early feedback without pretending the contract is stable.

### Biggest failure mode and mitigation

The biggest failure mode is declaring a stale OpenAPI document authoritative,
then emitting three SDKs that authenticate incorrectly or expose unsafe server
behavior. The fix is an upstream-owned bundle tied to server/CLI tests, an
immutable SDK lock, and a reviewed facade that fails closed on unknown security
semantics.

## Alternatives considered

| Option | Pros | Cons | Why rejected |
|--------|------|------|--------------|
| Generate clients directly from current OpenAPI | Fast for one product | HarnessaaS spec is stale; other products are incomplete | Would codify known inaccuracies |
| Treat TypeScript types as canonical | Accurate for some implementations | Not neutral, may include internal fields, poor Python/Rust generation | Couples SDKs to server implementation details |
| Handwrite all clients | Maximum ergonomic control | Drift is invisible and parity expensive | Wire DTO generation plus handwritten facades gives both control and accuracy |
| Runtime introspection only | No snapshots | Non-reproducible, requires live access, unsafe for unknown deployments | Builds and tests must be offline and deterministic |
| One schema for all four products | Superficial uniformity | Erases product-specific security semantics | Only primitives are shared; product contracts remain independent |

## Compliance and verification

CI MUST provide:

- JSON Schema and OpenAPI validation for every pinned bundle;
- digest verification against `specs/agentic/lock.json`;
- clean regeneration checks in all three language workspaces;
- semantic contract diff classification;
- one positive and one negative fixture per stable operation;
- unknown-field and unknown-enum compatibility fixtures;
- malformed, oversized, wrong-content-type, truncated-stream, and schema-depth
  adversarial fixtures;
- a test proving no generated file is part of a public import path without a
  handwritten facade.

### Acceptance test

From a network-disabled clean checkout, regenerate all pinned wire models and
obtain an empty diff. Run the same golden request, response, error, stream, and
capabilities fixtures through Node, Python, and Rust. The three SDKs must produce
equivalent domain values and error categories, preserve unknown data, reject an
unknown security-sensitive enum before I/O, and report the pinned product commit
and contract version in the test output.

## References

- ADR-0004: cross-cutting error taxonomy
- ADR-0006: cross-cutting versioning
- ADR-0019: agentic bounded contexts and SDK topology
- ADR-0022: agentic authentication, tenant, budget, secret, and consent isolation
- ADR-0026a: OSS MetaHarness identity, structured bridge, and public SDK API
- ADR-0026b: MetaHarness process, filesystem, and npm/npx supply chain
- ADR-0029: language packaging, features, and CLI boundaries
