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

export async function verifyOnce(version, bundle = join(root, "release-bundle")) {
  const npmFile = await onlyFile(join(bundle, "npm"), ".tgz");
  const pythonFiles = (await readdir(join(bundle, "python"))).filter((name) => name.endsWith(".whl") || name.endsWith(".tar.gz"));
  if (pythonFiles.length !== 2) throw new Error(`expected one Python wheel and sdist, found ${pythonFiles.length}`);
  const crateFile = await onlyFile(join(bundle, "cargo"), ".crate");
  const [npm, pypi, crates] = await Promise.all([
    fetchJson(`https://registry.npmjs.org/${encodeURIComponent("@cognitum-one/sdk")}/${version}`),
    fetchJson(`https://pypi.org/pypi/cognitum-sdk/${version}/json`),
    fetchJson(`https://crates.io/api/v1/crates/cognitum-one/${version}`),
  ]);
  const npmExpected = npm.dist?.integrity?.replace(/^sha512-/, "");
  const npmActual = await digest(npmFile, "sha512", "base64");
  if (!npmExpected || npmExpected !== npmActual) throw new Error("npm artifact digest does not match the built tarball");
  for (const file of pythonFiles) {
    const remote = pypi.urls?.find((entry) => entry.filename === basename(file));
    if (!remote || remote.digests?.sha256 !== await digest(join(bundle, "python", file), "sha256")) {
      throw new Error(`PyPI artifact digest mismatch: ${file}`);
    }
  }
  const crateExpected = crates.version?.checksum;
  if (!crateExpected || crateExpected !== await digest(crateFile, "sha256")) throw new Error("crates.io artifact digest does not match the built crate");
  console.log(`all registry artifacts for ${version} match the workflow-built files`);
}

async function main() {
  const version = process.argv[2];
  if (!version) throw new Error("usage: verify-release-artifacts.mjs <version> [bundle-directory]");
  let lastError;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try { await verifyOnce(version, process.argv[3]); return; }
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
