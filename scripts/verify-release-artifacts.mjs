#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function digest(path, algorithm, encoding = "hex") {
  return createHash(algorithm).update(await readFile(path)).digest(encoding);
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, { headers: { "User-Agent": "cognitum-sdks-release-verifier" } });
    if (!response.ok) {
      const error = new Error(`${url} returned HTTP ${response.status}`);
      error.retryable = response.status === 404 || response.status === 429 || response.status >= 500;
      throw error;
    }
    return response.json();
  } catch (error) {
    if (error.retryable === undefined) error.retryable = true;
    throw error;
  }
}

async function onlyFile(directory, suffix) {
  const matches = (await readdir(directory)).filter((name) => name.endsWith(suffix));
  if (matches.length !== 1) throw new Error(`${directory}: expected exactly one ${suffix} artifact, found ${matches.length}`);
  return join(directory, matches[0]);
}

export const REGISTRIES = ["npm", "pypi", "crates"];

async function verifyNpm(version, bundle) {
  const npmFile = await onlyFile(join(bundle, "npm"), ".tgz");
  const npm = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent("@cognitum-one/sdk")}/${version}`);
  const expected = npm.dist?.integrity?.replace(/^sha512-/, "");
  const actual = await digest(npmFile, "sha512", "base64");
  if (!expected || expected !== actual) throw new Error("npm artifact digest does not match the built tarball");
}

async function verifyPypi(version, bundle) {
  const pythonFiles = (await readdir(join(bundle, "python"))).filter((name) => name.endsWith(".whl") || name.endsWith(".tar.gz"));
  if (pythonFiles.length !== 2) throw new Error(`expected one Python wheel and sdist, found ${pythonFiles.length}`);
  const pypi = await fetchJson(`https://pypi.org/pypi/cognitum-sdk/${version}/json`);
  for (const file of pythonFiles) {
    const remote = pypi.urls?.find((entry) => entry.filename === basename(file));
    if (!remote || remote.digests?.sha256 !== await digest(join(bundle, "python", file), "sha256")) {
      throw new Error(`PyPI artifact digest mismatch: ${file}`);
    }
  }
}

async function verifyCrates(version, bundle) {
  const crateFile = await onlyFile(join(bundle, "cargo"), ".crate");
  const crates = await fetchJson(`https://crates.io/api/v1/crates/cognitum-one/${version}`);
  const expected = crates.version?.checksum;
  if (!expected || expected !== await digest(crateFile, "sha256")) throw new Error("crates.io artifact digest does not match the built crate");
}

const VERIFIERS = { npm: verifyNpm, pypi: verifyPypi, crates: verifyCrates };

// `only` restricts verification to a subset of registries. The publish jobs
// use it to prove an ALREADY-PUBLISHED version is byte-identical to this
// bundle before skipping it -- without that, resumability silently accepts a
// version somebody else published from different source, and the mismatch is
// only discovered after the remaining registries have irreversibly published
// the bundle's bytes, leaving a version that disagrees with itself across
// registries.
export async function verifyOnce(version, bundle = join(root, "release-bundle"), only = REGISTRIES) {
  const selected = only.filter((name) => REGISTRIES.includes(name));
  if (selected.length === 0) throw new Error(`no known registry in [${only.join(", ")}]`);
  for (const name of selected) await VERIFIERS[name](version, bundle);
  console.log(`${selected.join(", ")} artifact(s) for ${version} match the workflow-built files`);
}

async function main() {
  const args = process.argv.slice(2);
  const onlyIndex = args.indexOf("--only");
  const only = onlyIndex === -1 ? REGISTRIES : (args[onlyIndex + 1] ?? "").split(",").filter(Boolean);
  const positional = onlyIndex === -1 ? args : [...args.slice(0, onlyIndex), ...args.slice(onlyIndex + 2)];
  const [version, bundle] = positional;
  if (!version) throw new Error("usage: verify-release-artifacts.mjs <version> [bundle-directory] [--only npm,pypi,crates]");
  let lastError;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try { await verifyOnce(version, bundle, only); return; }
    catch (error) {
      lastError = error;
      console.warn(`verification attempt ${attempt}/12: ${error.message}`);
      if (!error.retryable) break;
    }
    await sleep(10_000);
  }
  throw lastError;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
