#!/usr/bin/env node

// Post-publish smoke test for the npm package as END USERS receive it.
//
// The release workflow already proves the registry holds the same bytes we
// built (verify-release-artifacts.mjs compares digests). Digest equality is
// an identity check, not a correctness one: a build that dropped
// dist/seed/index.cjs while leaving the "./seed" export in package.json would
// pack, publish, digest-verify and install completely green, and break only
// in a user's project. So this loads every entry point the package advertises
// -- in both module systems it claims to support.
//
// Usage: node smoke-published-package.mjs [package-name]
//   Run from a directory where the package is already installed.

import { readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function entryPoints(packageName, exportsField) {
  // A package with no `exports` map is reachable only at its root.
  const subpaths = Object.keys(exportsField ?? { ".": {} }).filter((subpath) => {
    if (subpath.endsWith(".json")) return false; // data, not loadable code
    if (subpath.includes("*")) return false; // wildcard patterns are not directly loadable
    return subpath.startsWith(".");
  });
  return subpaths.map((subpath) => ({
    subpath,
    specifier: subpath === "." ? packageName : `${packageName}/${subpath.slice(2)}`,
    // Only attempt require() where the package actually advertises CJS.
    hasRequire: Boolean(exportsField?.[subpath]?.require),
    hasImport: Boolean(exportsField?.[subpath]?.import) || exportsField === undefined,
  }));
}

async function main() {
  const packageName = process.argv[2] ?? "@cognitum-one/sdk";
  const require = createRequire(`${process.cwd()}/`);
  // Read the manifest off disk rather than via require(`${pkg}/package.json`):
  // a package whose `exports` map does not list "./package.json" -- which is
  // the case for this SDK, and is normal -- makes that specifier unresolvable.
  const manifestPath = join(process.cwd(), "node_modules", ...packageName.split("/"), "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const targets = entryPoints(packageName, manifest.exports);

  if (targets.length === 0) throw new Error(`${packageName}: no entry points found to smoke-test`);

  // `import(specifier)` resolves relative to the module doing the importing,
  // which is THIS file -- not the directory where the package was installed.
  // Importing straight from here therefore fails to find the package no
  // matter how correctly it was published, i.e. the ESM half of this smoke
  // test would report failure for the wrong reason. Bridging through a
  // throwaway module inside the install directory makes resolution start
  // where a real consumer's code would. (`require` already resolves from
  // cwd via createRequire above.)
  const bridgePath = join(process.cwd(), ".smoke-import-bridge.mjs");
  await writeFile(bridgePath, "export const load = (specifier) => import(specifier);\n");
  const failures = [];
  try {
    const { load } = await import(pathToFileURL(bridgePath).href);
    for (const target of targets) {
      try {
        await load(target.specifier);
        if (target.hasRequire) require(target.specifier);
        console.log(`ok   ${target.specifier}${target.hasRequire ? " (esm + cjs)" : " (esm)"}`);
      } catch (error) {
        failures.push(`${target.specifier}: ${error.message}`);
        console.error(`FAIL ${target.specifier}: ${error.message}`);
      }
    }
  } finally {
    await rm(bridgePath, { force: true });
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length}/${targets.length} entry point(s) failed to load`);
  }
  console.log(`smoked ${targets.length} entry point(s) of ${packageName}@${manifest.version}`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
