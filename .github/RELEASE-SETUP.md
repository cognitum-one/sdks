# SDK registry release setup

The `release.yml` workflow publishes only tags shaped like `v1.2.3` or
`v1.2.3-rc.1`. The build job is credential-free. Publishing is serialized npm
→ PyPI → crates.io behind the GitHub `release` environment, and the final job
compares registry digests with the workflow-built artifacts before installing
each exact version.

## One-time owner setup

1. In GitHub repository settings, create an environment named `release`.
   Require an active release maintainer as reviewer. The current fallback is
   `proffesor-for-testing`, with self-review enabled because the previously
   configured reviewer is unavailable; replace this with a maintainer team and
   restore `prevent_self_review` when a second active reviewer is available.
   Restrict deployments to the `main` branch and protected `v*` tags, and do
   not allow administrators to bypass the protection. The `main` policy is
   required for the dispatch-only npm staging rehearsal; the tag policy is
   required for real releases.
2. Add an active tag ruleset for `refs/tags/v*` that restricts tag creation,
   update, and deletion to release maintainers. Releases must point to a commit
   already merged into protected `main`.
3. On npm, configure a trusted publisher for `@cognitum-one/sdk`:
   organization/repository `cognitum-one/sdks`, workflow `release.yml`,
   environment `release`. Allow both `npm publish` and `npm stage publish`.
   Confirm the binding with `npm trust list @cognitum-one/sdk`; npm's public
   package metadata does not expose it. Remove legacy write tokens only after
   one successful OIDC operation. npm trusted publishing requires a
   GitHub-hosted runner; this workflow uses Node 24 and pins npm 11.18.0 for
   staged publishing.
4. On PyPI, configure a GitHub trusted publisher for `cognitum-sdk`: owner
   `cognitum-one`, repository `sdks`, workflow `release.yml`, environment
   `release`. Remove the old PyPI upload token after one successful OIDC
   release. This binding is the remaining gate for the coordinated stable
   release; do not substitute an untracked token merely to bypass the proof.
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
the three publish jobs when `npm_action` is `rehearse-only`. It is free,
repeatable, and publishes nothing.

### Proving the npm trusted publisher

OIDC authentication cannot be proved by `npm whoami`, `npm publish --dry-run`,
or public registry metadata: npm exchanges the GitHub token only during a
publish or stage operation. For the first npm rehearsal:

1. Prepare and merge a coordinated prerelease version such as `0.4.0-rc.1` in
   every source-version location and changelog required by the preflight.
2. Dispatch `release.yml` from that exact `main` commit with the matching
   version, `npm_action=stage-prerelease`, and confirmation
   `@cognitum-one/sdk@0.4.0-rc.1`.
3. Review and approve the `release` environment deployment. The job refuses a
   stable version, a mismatched confirmation, an already-public version, or an
   ambiguous registry response. It supplies no npm token.
4. On npm, inspect the staged package and its source/provenance binding, then
   **reject the stage**. Do not promote it during a rehearsal.

The `0.4.0-rc.1` rehearsal completed this way on 2026-08-05: stage
`8d8c8f44-29e7-425f-aeb0-e7bf0056ce26` was inspected, confirmed absent from the
public registry, and rejected with registry-owner 2FA. No npm prerelease was
promoted.

`npm stage publish` is recoverable and does not make the version public. Stage
approval/rejection requires an interactive registry-owner session and is
deliberately outside GitHub Actions. A later tag-triggered release continues to
use ordinary `npm publish`, with prereleases assigned to dist-tag `next`.

Do this before every release. It is the only safe rehearsal available:

- A **prerelease tag is not a rehearsal.** A tag invokes the public,
  irreversible three-registry chain. Use dispatch plus npm staging to test the
  npm binding without involving deferred PyPI or crates.io publication.
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
