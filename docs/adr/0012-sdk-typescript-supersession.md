# ADR 0012: Disposition of `sdk-typescript/` (chip-simulator SDK)

- **Status:** Executed
- **Date:** 2026-04-22
- **Scope:** sdk-typescript/

> **Execution note (2026-04-22):** The `/home/ruvultra/projects/sdks/sdk-typescript/`
> directory was removed from this repo in the ADR-reorganization commit that also
> moved per-SDK ADRs into `sdks/{node,python,rust}/docs/adr/`. The chip-simulator
> product, if revived, should live in its own repository and not collide with the
> `@cognitum/sdk` namespace.

## Context

`/home/ruvultra/projects/sdks/sdk-typescript/` ships a package named
`@ruv/cognitum-sdk` (`sdk-typescript/package.json:2`) whose README
(`sdk-typescript/README.md:3`) describes it as "TypeScript SDK for the
Cognitum chip simulator — a massively parallel tile-based computing
architecture."

This is **not the same Cognitum** as the Seed appliance or the cloud API
served by `@cognitum/sdk` (`sdks/node/package.json:2`). Surface signals:

| Signal | `sdk-typescript/` | `sdks/node/` |
|--------|------------------|--------------|
| Package name | `@ruv/cognitum-sdk` | `@cognitum/sdk` |
| Scope | chip simulator (tiles, programCounter, stackPointer) | Seed appliance + cloud commerce/MCP |
| API surface | `CognitumSDK.create()`, `loadProgram`, `run`, tile inspection | `catalog`, `orders`, `devices`, `brain`, `mcp` |
| Runtime deps | `rxjs` | none |
| Peer dep | `@ruv/cognitum` (native NAPI) | none |
| Repo | migrated 2026-04-15 from ruvnet/cognitum | migrated 2026-04-15 |

The `MIGRATION.md` at the repo root records both trees were pulled from
`ruvnet/cognitum`. That repo contained two unrelated products sharing the
name.

## Decision

Treat `sdk-typescript/` as **superseded for the purposes of these SDKs**.
It is NOT the Node SDK for the Cognitum platform; `sdks/node/` is.

Concretely:

- ADRs 0001–0011 **do not apply** to `sdk-typescript/`. It has its own
  lifecycle tied to the chip simulator, which lives outside the `seed/`
  submodule and the cloud API.
- No cross-cutting changes (auth header, error taxonomy, retry policy,
  versioning) MUST be applied to `sdk-typescript/`. Its wire contract is
  NAPI/WASM, not HTTP.
- The directory SHOULD either move to its own repo or be renamed to
  `sdk-chip-simulator/` in this monorepo to remove the name collision.
  That decision is owned by whoever owns the chip-simulator product.
- Until then, `docs/adr/README.md` and every SDK README MUST state that
  the `sdk-typescript/` folder is unrelated and users should
  `npm install @cognitum/sdk`, NOT `@ruv/cognitum-sdk`, unless they
  actually want the simulator.

### What this ADR does NOT say

- It does NOT deprecate `@ruv/cognitum-sdk` on npm — that's the chip
  simulator team's call.
- It does NOT move files in this PR — disruption is out of scope.
- It does NOT import or depend on the chip simulator from the other SDKs.

## Consequences

### Positive

- Prevents the chip-simulator SDK from being accidentally promoted as
  "the Node SDK for Cognitum Seed".
- Clears the ADR index.

### Negative

- Confusion persists until the folder is renamed or extracted. Mitigation:
  large note in `docs/adr/README.md` (already present).

## Compliance

- CI on `sdks/**` and `docs/adr/**` MUST NOT run against
  `sdk-typescript/`.
- A root-level note in `README.md` (future) or `MIGRATION.md` disambiguates
  the two packages.

## References

- `sdk-typescript/package.json:2`
- `sdk-typescript/README.md:3`
- `sdks/node/package.json:2`
- `MIGRATION.md:1-10`
