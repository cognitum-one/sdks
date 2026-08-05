import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function source(path) {
  return readFile(resolve(repoRoot, path), "utf8");
}

// @tier durable — guards the public release-verification contract, not the
// implementation details of any one language driver.
test("live smoke installs and drives all three public registry artifacts", async () => {
  const workflow = await source(".github/workflows/live-smoke.yml");

  assert.match(workflow, /npm install --save-exact/);
  assert.match(workflow, /pip install[^\n]*"\$\{SPEC\}"/);
  assert.match(workflow, /cognitum-one = \{ version =/);
  assert.match(workflow, /scripts\/live-smoke\.mjs/);
  assert.match(workflow, /scripts\/live_smoke\.py/);
  assert.match(workflow, /scripts\/live-smoke\.rs/);
});

// @tier durable — one resolved version must select every registry artifact;
// otherwise a green run can compare unrelated releases.
test("one validated version is reused by npm, PyPI, and crates.io", async () => {
  const workflow = await source(".github/workflows/live-smoke.yml");

  assert.match(workflow, /id: version/);
  assert.match(workflow, /version: \$\{\{ steps\.version\.outputs\.version \}\}/);
  assert.match(workflow, /registryVersion mismatch/);
  assert.match(workflow, /invalid release version/);
  assert.equal((workflow.match(/needs\.resolve_version\.outputs\.version/g) ?? []).length, 3);
});

// @tier durable — registry availability is independent. A missing PyPI
// package must not suppress npm or crates.io evidence from the same run.
test("each language runs in its own job after shared version resolution", async () => {
  const workflow = await source(".github/workflows/live-smoke.yml");

  for (const job of ["node", "python", "rust"]) {
    assert.match(workflow, new RegExp(`\\n  ${job}:\\n`));
  }
  assert.equal((workflow.match(/needs: resolve_version/g) ?? []).length, 3);
  assert.doesNotMatch(workflow, /name: published Node, Python, and Rust SDKs/);
});

// @tier durable — --locked is only meaningful when the clean consumer first
// creates a lockfile; without this command the Rust smoke fails before compile.
test("Rust clean consumer generates a lockfile before locked execution", async () => {
  const workflow = await source(".github/workflows/live-smoke.yml");
  const generate = workflow.indexOf("cargo generate-lockfile");
  const run = workflow.indexOf("run: cargo run --locked");

  assert.ok(generate >= 0, "Rust smoke must generate a consumer lockfile");
  assert.ok(run > generate, "locked Rust execution must follow lockfile generation");
});

// @tier durable — every language must assert semantics beyond a successful
// HTTP exchange, including the original #142 failure class.
test("all three drivers reject empty content and missing token accounting", async () => {
  const drivers = await Promise.all([
    source("scripts/live-smoke.mjs"),
    source("scripts/live_smoke.py"),
    source("scripts/live-smoke.rs"),
  ]);

  for (const driver of drivers) {
    assert.match(driver, /whoami/);
    assert.match(driver, /empty (completion|message)/);
    assert.match(driver, /total_tokens|totalTokens/);
    assert.match(driver, /usage/);
  }
});

// @tier durable — the smoke remains observational and cannot become an
// accidental release/tag/publish path.
test("live smoke contains no registry publication commands", async () => {
  const workflow = await source(".github/workflows/live-smoke.yml");
  assert.doesNotMatch(workflow, /\b(?:npm|cargo) publish\b|\btwine upload\b/);
});
