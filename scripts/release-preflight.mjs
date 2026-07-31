#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function versionFromTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag);
  if (!match) throw new Error(`release tag must be canonical SemVer prefixed with v; got ${JSON.stringify(tag)}`);
  return tag.slice(1);
}

function tomlValue(source, section, key) {
  const sectionMatch = new RegExp(`\\[${section.replace(".", "\\.")}\\]([\\s\\S]*?)(?=\\n\\[|$)`).exec(source);
  const match = sectionMatch && new RegExp(`^${key}\\s*=\\s*\"([^\"]+)\"`, "m").exec(sectionMatch[1]);
  if (!match) throw new Error(`could not read ${section}.${key}`);
  return match[1];
}

function cargoLockPackageVersion(source, packageName) {
  for (const block of source.split("[[package]]").slice(1)) {
    if (tomlValue(`[package]${block}`, "package", "name") === packageName) {
      return tomlValue(`[package]${block}`, "package", "version");
    }
  }
  throw new Error(`could not find ${packageName} in Cargo.lock`);
}

export async function collectVersions(base = root) {
  const [node, nodeLock, python, pythonInit, rust, rustLock, manifest] = await Promise.all([
    readFile(resolve(base, "sdks/node/package.json"), "utf8").then(JSON.parse),
    readFile(resolve(base, "sdks/node/package-lock.json"), "utf8").then(JSON.parse),
    readFile(resolve(base, "sdks/python/pyproject.toml"), "utf8"),
    readFile(resolve(base, "sdks/python/cognitum/__init__.py"), "utf8"),
    readFile(resolve(base, "sdks/rust/Cargo.toml"), "utf8"),
    readFile(resolve(base, "sdks/rust/Cargo.lock"), "utf8"),
    readFile(resolve(base, "capabilities/sdk-release.v1.json"), "utf8").then(JSON.parse),
  ]);
  const pythonRuntime = /^__version__\s*=\s*"([^"]+)"/m.exec(pythonInit)?.[1];
  if (!pythonRuntime) throw new Error("could not read cognitum.__version__");
  return {
    "node package": node.version,
    "node lockfile": nodeLock.version,
    "python project": tomlValue(python, "project", "version"),
    "python runtime": pythonRuntime,
    "rust package": tomlValue(rust, "package", "version"),
    "rust lockfile": cargoLockPackageVersion(rustLock, "cognitum-one"),
    "manifest node source": manifest.languages.node.sourceVersion,
    "manifest python source": manifest.languages.python.sourceVersion,
    "manifest rust source": manifest.languages.rust.sourceVersion,
  };
}

export function parityErrors(expected, versions) {
  return Object.entries(versions)
    .filter(([, actual]) => actual !== expected)
    .map(([label, actual]) => `${label}: expected ${expected}, got ${actual}`);
}

async function main() {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
  const expected = versionFromTag(tag);
  const versions = await collectVersions();
  const errors = parityErrors(expected, versions);
  for (const [label, version] of Object.entries(versions)) console.log(`${label}: ${version}`);
  if (errors.length) throw new Error(`release version parity failed:\n- ${errors.join("\n- ")}`);
  for (const file of ["CHANGELOG.md", "sdks/node/CHANGELOG.md", "sdks/python/CHANGELOG.md", "sdks/rust/CHANGELOG.md"]) {
    const text = await readFile(resolve(root, file), "utf8");
    if (!text.includes(`## [${expected}]`)) throw new Error(`${file} has no [${expected}] release entry`);
  }
  console.log(`release preflight passed for ${tag}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
