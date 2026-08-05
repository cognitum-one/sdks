import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("npm OIDC rehearsal is staged, prerelease-only, and token-free", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");
  const stageJob = workflow.slice(
    workflow.indexOf("  stage-npm-prerelease:"),
    workflow.indexOf("  publish-pypi:"),
  );

  assert.ok(stageJob.length > 0, "stage-npm-prerelease job must exist");
  assert.match(stageJob, /inputs\.npm_action == 'stage-prerelease'/);
  assert.match(stageJob, /environment: release/);
  assert.match(stageJob, /id-token: write/);
  assert.match(stageJob, /\[\[ "\$\{VERSION\}" == \*-\* \]\]/);
  assert.match(stageJob, /test "\$\{CONFIRMATION\}" = "@cognitum-one\/sdk@\$\{VERSION\}"/);
  assert.match(stageJob, /test "\$\{PUBLISHED\}" -eq 10/);
  assert.match(stageJob, /npm stage publish release-bundle\/npm\/\*\.tgz/);
  assert.match(stageJob, /NODE_AUTH_TOKEN: ""/);
  assert.match(stageJob, /NPM_TOKEN: ""/);
  assert.doesNotMatch(stageJob, /secrets\./);
  assert.doesNotMatch(stageJob, /npm publish release-bundle/);
});

test("ordinary dispatch remains non-publishing by default", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /default: rehearse-only/);
  assert.match(workflow, /a dispatch rehearsal must run at the current main tip/);
  assert.match(workflow, /publish-npm:[\s\S]*?if: github\.event_name == 'push'/);
  assert.match(workflow, /publish-pypi:[\s\S]*?if: github\.event_name == 'push'/);
  assert.match(workflow, /publish-crates:[\s\S]*?if: github\.event_name == 'push'/);
});

test("staging and real npm publication pin the same OIDC-capable npm CLI", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");
  assert.equal([...workflow.matchAll(/npm install --global npm@11\.18\.0/g)].length, 2);
  assert.equal([...workflow.matchAll(/test "\$\(npm --version\)" = "11\.18\.0"/g)].length, 2);
});
