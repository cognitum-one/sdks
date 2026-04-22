# ADR 0006: Versioning Policy

- **Status:** Accepted
- **Date:** 2026-04-22
- **Scope:** cross-cutting

## Context

Three moving parts, three release cadences:

| Artefact | Version today | Scheme | Source |
|---------|---------------|--------|--------|
| Node SDK | `0.1.3` | SemVer | `sdks/node/package.json:3` |
| Python SDK | `0.1.0` | SemVer | `sdks/python/pyproject.toml:8` |
| Rust SDK | `0.1.0` | SemVer | `sdks/rust/Cargo.toml:3` |
| Seed firmware | `v0.20.0` | SemVer | `seed/src/cognitum-agent/Cargo.toml:3` (authoritative; `seed/README.md:24` still advertises the older `v0.10.11.5` tag — known lag) |
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
MINOR is allowed to break. First 1.0 release ships once the criteria below
are met.

### 1.0 criteria (resolves OQ-8)

An SDK MAY cut a 1.0 release when all of the following are true. Each item
is a boolean gate; partial satisfaction is still pre-1.0:

1. **Seed-direct module shipped** — `SeedClient` / `seed` submodule / `seed`
   feature exists and covers the endpoints marked "Phase 1" in ADR-0011
   §"Rollout phasing". Cloud-only release is necessarily pre-1.0.
2. **Error taxonomy complete** — all non-reserved variants from ADR-0004
   are produced at least once by a conformance test; `AuthReason`
   enum is wired with the canonical names from ADR-0004.
3. **Cross-SDK conformance green** — the three SDKs pass the shared test
   vectors for: auth-header, 429 retry-after parsing (header + body),
   401/403 → `AuthError(reason=...)` mapping, 404 → `NotFoundError`,
   501 → `NotImplementedError`. Run in CI.
4. **TLS pinning contract** — ADR-0007 §"Common TLS-pinning interface"
   implemented, including the fail-fast rule for non-default hosts.
5. **Redaction contract** — ADR-0007 §"Cross-SDK redaction contract" test
   harness green; CI grep rules for `console.log(.*api_key)` /
   `println!.*token` / `print(.*api_key)` enforced.
6. **Trust-score protection** — ADR-0007 §"Trust-score protection"
   implemented in all three SDKs.
7. **Forward-compat round-trip** — unknown-field test: an extra JSON field
   on every response type survives round-trip via the SDK's `extras` /
   `Forward` / `#[serde(flatten)]` mechanism.
8. **Compatibility matrix published** — `README.md` of each SDK documents
   the seed firmware range tested against for that SDK version.
9. **No open MINOR-breaking fixes against a prior release** — i.e. the last
   0.x.y MINOR did NOT need a follow-up breaking fix within one month.
10. **Deprecation windows closed** — no `@deprecated` / `#[deprecated]` /
    `DeprecationWarning` symbols with a removal target earlier than 1.0.

OQ-3 (SSE streams) and OQ-5 (request signing) are explicitly NOT 1.0 gates;
both ship typed placeholders and are allowed to remain 501 / unused at 1.0.

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
