# SDK registry release setup

The `release.yml` workflow publishes only tags shaped like `v1.2.3` or
`v1.2.3-rc.1`. The build job is credential-free. Publishing is serialized npm
→ PyPI → crates.io behind the GitHub `release` environment, and the final job
compares registry digests with the workflow-built artifacts before installing
each exact version.

## One-time owner setup (Ruv)

1. In GitHub repository settings, create an environment named `release`. Add
   Ruv (or the release-maintainers team) as a required reviewer, prevent
   self-review where the plan supports it, restrict deployment branches/tags to
   protected tags, and do not allow administrators to bypass the protection.
2. Add an active tag ruleset for `refs/tags/v*` that restricts tag creation,
   update, and deletion to release maintainers. Releases must point to a commit
   already merged into protected `main`.
3. On npm, configure a trusted publisher for `@cognitum-one/sdk`:
   organization/repository `cognitum-one/sdks`, workflow `release.yml`,
   environment `release`. Remove legacy write tokens after one successful OIDC
   release. npm trusted publishing requires a GitHub-hosted runner; this
   workflow uses Node 24 and a current npm CLI.
4. On PyPI, configure a GitHub trusted publisher for `cognitum-sdk`: owner
   `cognitum-one`, repository `sdks`, workflow `release.yml`, environment
   `release`. Remove the old PyPI upload token after one successful OIDC
   release.
5. crates.io does not currently expose the same GitHub trusted-publisher flow.
   Create a least-privilege token scoped to the `cognitum-one` crate and store
   it as the `CARGO_REGISTRY_TOKEN` secret on the GitHub `release` environment.
   Rotate/revoke the token after maintainer changes or suspected exposure.

## Preparing a release PR

Update all versions together: Node `package.json` and lockfile, Python
`pyproject.toml` and `cognitum.__version__`, Rust `Cargo.toml` and lockfile, and
all three `sourceVersion` values in `capabilities/sdk-release.v1.json`. Add the
same version to the root and three language changelogs. Keep `registryVersion`
at the last version actually observed in each registry until publication.

## Rehearsing

Run the `release` workflow via **workflow_dispatch** with the version you are
about to ship. It runs every gate and builds every artifact, then stops before
the three publish jobs. It is free, repeatable, and publishes nothing.

Do this before every release. It is the only safe rehearsal available:

- A **prerelease tag is not a rehearsal.** `release-preflight.mjs` requires the
  tag version to equal every source literal, so `v0.4.0-rc.1` fails against a
  0.4.0 source tree. Bumping the source to `0.4.0-rc.1` does not fix it
  either: PEP 440 normalises that to `0.4.0rc1`, so the built wheel is named
  for a version `verify-release-artifacts.mjs` will not find on PyPI. Proper
  prerelease support is tracked separately.
- A **failed tag cannot be retried.** The `release tags` ruleset blocks
  deletion, update and force-push on `refs/tags/v*` with no bypass actors, by
  design -- a published release tag must be immutable. The consequence is that
  a tag which fails burns that version string permanently.

After the PR passes the required `GA gate (maturity + evidence)` and is merged,
a release maintainer creates and pushes the matching tag from that exact `main`
commit. Approve the `release` environment only after reviewing the tag, commit,
workflow-built checksums, and GA result. After publication, open a follow-up PR
updating `registryVersion`, `verifiedAt`, `sourceCommit`, and `generatedAt` in
the capability manifest with the verified release evidence.

Registry uploads are immutable and the three registries have no atomic commit.
If a later registry fails after an earlier publish succeeds, do not retag or
reuse the version. Preserve the run artifacts and logs, diagnose the failure,
then either complete the same version from the exact release artifacts or mark
the partial versions deprecated/yanked and issue a coordinated patch release.
