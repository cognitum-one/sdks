# ADR 0006: Versioning Policy

- **Status:** Accepted
- **Date:** 2026-04-22
- **Scope:** cross-cutting

## Context

Three moving parts, three release cadences:

| Artefact | Version today | Scheme | Source |
|---------|---------------|--------|--------|
| Node SDK | `0.1.3` | SemVer | `sdks/node/package.json:4` |
| Python SDK | (see `pyproject.toml`) | SemVer | `sdks/python/pyproject.toml` |
| Rust SDK | `0.1.0` | SemVer | `sdks/rust/Cargo.toml:3` |
| Seed firmware | `v0.10.11.5` | Four-segment | `seed/README.md:24` |
| Wire API | `v1` via `/api/v1/*` | Major segment only | `seed/docs/seed/api-reference.md:3-5` |
| Cloud API | implicit `v1` (no prefix) | — | `sdks/node/src/client.ts:10-11` |

Without a written policy, SDK consumers cannot reason about
"does my SDK still work against firmware v0.11?".

## Decision

### SDKs use SemVer 2.0.0 strictly

For each SDK, the version encodes the SDK's public API, not the server's:

- **MAJOR** — breaking change to a public SDK type or method.
- **MINOR** — additive SDK change, new resources, new optional fields.
- **PATCH** — bug fix, doc-only change, dependency bump with no API impact.

The SDK version in `package.json` / `pyproject.toml` / `Cargo.toml` MUST
advance together across the three SDKs for any cross-cutting ADR change.
Independent fixes bump independently.

Pre-1.0 (all three SDKs today): the "breaking change" promise is relaxed.
MINOR is allowed to break. First 1.0 release ships once the Seed-direct
module is in place (see ADR-0011).

### Wire API uses URL-prefix major versioning

- Today: `/api/v1/*`.
- A breaking change to a seed endpoint MUST be introduced as a parallel
  `/api/v2/*` route and `/api/v1/*` MUST remain for at least one MINOR
  firmware release.
- SDKs hard-code the `v1` prefix inside transport code and expose
  `baseUrl` / `base_url` only down to the host:port level. The prefix is
  NOT user-configurable; changing it is an SDK MAJOR bump.

### Cloud API follows the same rule

Paths on `api.cognitum.one` have no version prefix today, but any breaking
change MUST move to `/v2/*` and the SDK MUST gate it behind a MAJOR bump.

### Firmware-compatibility matrix

Every SDK `README.md` MUST include a compatibility matrix of the form:

| SDK version | Seed firmware | Cloud API | Status |
|-------------|--------------|-----------|--------|
| 0.1.x | v0.10.x | any | supported |
| 0.2.x | v0.11.x | v1 | planned |

The matrix is maintained on PRs that touch `sdks/*/src/` or
`seed/docs/seed/api-reference.md`.

### Server-side capability discovery

`GET /api/v1/status` returns `roles` and is effectively the capability
fingerprint today. SDKs MAY call it at client-open time to verify the seed
ships the roles the SDK expects. When the seed adds a `capabilities` array
in a future release, SDKs MUST prefer that to `roles`.

### Deprecation process

A public SDK symbol or seed endpoint enters deprecation only when:

1. A replacement exists.
2. The deprecation is called out in the SDK `CHANGELOG.md`.
3. The symbol emits a runtime warning (once per process).
4. At least one MINOR release elapses before removal in the next MAJOR.

### Unknown-field forward compatibility

All SDK response types MUST tolerate unknown JSON fields without failing:

- Node: `interface`s are already permissive.
- Python: dataclasses created via `typing.get_type_hints` + explicit `.get()`
  on the parse path; never `**kwargs` into a frozen class.
- Rust: `#[serde(default)]` + `#[serde(other)]` on catch-all fields; closed
  enums become `#[non_exhaustive]` with a `Unknown(String)` variant.

This means a seed that introduces `status.witness_chain_length` (as the live
device already does today — see live `/api/v1/status` response, which has
this field while `seed/docs/seed/api-reference.md:30-42` does not document
it) does NOT break any SDK.

## Consequences

### Positive

- Consumers of the SDK can read `package.json` or `Cargo.toml` alone to
  predict breaking behavior.
- The seed team is free to evolve endpoints within `v1` as long as they
  stay additive.

### Negative

- Three coordinated releases for cross-cutting changes. Mitigation: one
  PR touches all three.
- Unknown-field tolerance is easy to regress without a lint.

## Compliance

- CI: on every SDK PR, run `GET /api/v1/status` against a virtual seed and
  deserialize with all three SDKs. Any parse failure fails CI.
- CI: reject PRs that add a new top-level resource module without updating
  `README.md`'s compatibility matrix.

## References

- Node `package.json:4`
- Rust `Cargo.toml:3`
- Seed README: `seed/README.md:24`
- Related ADRs: 0002 (wire), 0011 (cloud-vs-seed scope), 0008–0010 (per-SDK).
