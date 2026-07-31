import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { entryPoints } from "../smoke-published-package.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = resolve(repoRoot, "scripts/smoke-published-package.mjs");
const run = promisify(execFile);

// Builds a throwaway node_modules tree so the script can be exercised
// end-to-end without touching a network or a real publish.
async function fixturePackage({ name = "@fixture/pkg", exportsField, files }) {
  const dir = await mkdtemp(join(tmpdir(), "smoke-fixture-"));
  const pkgDir = join(dir, "node_modules", ...name.split("/"));
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "host", type: "module" }));
  await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name, version: "9.9.9", type: "module", exports: exportsField }));
  for (const [relative, contents] of Object.entries(files)) {
    await mkdir(dirname(join(pkgDir, relative)), { recursive: true });
    await writeFile(join(pkgDir, relative), contents);
  }
  return dir;
}

async function smoke(cwd, name) {
  try {
    const { stdout } = await run(process.execPath, [script, name], { cwd });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.code ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

test("every subpath the real package exports is smoke-tested", async () => {
  const pkg = JSON.parse(await readFile(resolve(repoRoot, "sdks/node/package.json"), "utf8"));
  const targets = entryPoints("@cognitum-one/sdk", pkg.exports);

  const expected = Object.keys(pkg.exports).filter((s) => !s.endsWith(".json") && !s.includes("*"));
  assert.equal(targets.length, expected.length);
  assert.ok(targets.length > 1, "package advertises subpath exports; the smoke test must cover more than the root");
  assert.ok(targets.every((t) => t.hasRequire), "every export declares CJS, so every one must be require()-checked");
});

test("root specifier is the bare package name, subpaths are appended", () => {
  const targets = entryPoints("@scope/pkg", { ".": { import: "./i.js" }, "./seed": { import: "./s.js" } });
  assert.deepEqual(targets.map((t) => t.specifier), ["@scope/pkg", "@scope/pkg/seed"]);
});

test("a package with no exports map still smokes its root", () => {
  assert.deepEqual(entryPoints("@scope/pkg", undefined).map((t) => t.specifier), ["@scope/pkg"]);
});

test("json and wildcard exports are excluded as not directly loadable", () => {
  const targets = entryPoints("@scope/pkg", {
    ".": { import: "./i.js" },
    "./manifest.json": "./m.json",
    "./plugins/*": { import: "./p/*.js" },
  });
  assert.deepEqual(targets.map((t) => t.specifier), ["@scope/pkg"]);
});

test("require is only attempted where the package advertises CJS", () => {
  const targets = entryPoints("@scope/pkg", { ".": { import: "./i.js" } });
  assert.equal(targets[0].hasRequire, false);
});

// --- end-to-end: the script must actually load, and actually fail ----------
// Without these, reverting the workflow to `node -e "require(pkg)"` would
// leave every test above green -- the tests would be describing a function
// nobody calls.

test("loads every advertised entry point of a real installed package", async () => {
  const dir = await fixturePackage({
    exportsField: {
      ".": { import: "./index.js", require: "./index.cjs" },
      "./seed": { import: "./seed.js", require: "./seed.cjs" },
    },
    files: {
      "index.js": "export const a = 1;\n",
      "index.cjs": "module.exports = { a: 1 };\n",
      "seed.js": "export const b = 2;\n",
      "seed.cjs": "module.exports = { b: 2 };\n",
    },
  });
  try {
    const { code, output } = await smoke(dir, "@fixture/pkg");
    assert.equal(code, 0, output);
    assert.match(output, /ok {3}@fixture\/pkg \(esm \+ cjs\)/);
    assert.match(output, /ok {3}@fixture\/pkg\/seed \(esm \+ cjs\)/);
    assert.match(output, /smoked 2 entry point\(s\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fails when an advertised subpath build is missing", async () => {
  // The exact defect this script exists to catch: the export stays in
  // package.json but the built file was never emitted. Digest verification
  // cannot see this, because the registry holds precisely these bytes.
  const dir = await fixturePackage({
    exportsField: {
      ".": { import: "./index.js", require: "./index.cjs" },
      "./seed": { import: "./seed.js", require: "./seed.cjs" },
    },
    files: {
      "index.js": "export const a = 1;\n",
      "index.cjs": "module.exports = { a: 1 };\n",
      "seed.js": "export const b = 2;\n",
      // seed.cjs deliberately absent
    },
  });
  try {
    const { code, output } = await smoke(dir, "@fixture/pkg");
    assert.equal(code, 1, "a missing subpath build must fail the release");
    assert.match(output, /FAIL @fixture\/pkg\/seed/);
    assert.match(output, /1\/2 entry point\(s\) failed to load/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fails loudly rather than passing when the package is not installed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "smoke-empty-"));
  try {
    const { code } = await smoke(dir, "@fixture/absent");
    assert.equal(code, 1, "an absent package must not be reported as smoked");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the workflow invokes this script rather than a bare root require", async () => {
  // Guards the wiring itself: the fix is only live while release.yml calls it.
  const workflow = await readFile(resolve(repoRoot, ".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /smoke-published-package\.mjs/);
  assert.match(workflow, /smoke_published_package\.py/);
  assert.doesNotMatch(workflow, /node -e "require\('@cognitum-one\/sdk'\)"/);
});

test("the script file is reachable at the path the workflow uses", () => {
  assert.ok(pathToFileURL(script).href.endsWith("scripts/smoke-published-package.mjs"));
});
