#!/usr/bin/env node

// Build and verify the exact npm tarball in a clean consumer project. This is
// intentionally separate from source-tree tests: npm's files/exports/bin
// rules can create a broken package from a green checkout.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(repoRoot, "sdks", "node");
const smokeScript = join(repoRoot, "scripts", "smoke-published-package.mjs");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

export const MAX_PACKED_BYTES = 1_500_000;
export const MAX_UNPACKED_BYTES = 6_000_000;
export const REQUIRED_FILES = ["package.json", "README.md", "LICENSE", "CHANGELOG.md"];
export const ALLOWED_PREFIXES = ["dist/"];

export function validatePack(pack) {
  const files = (pack.files ?? []).map((file) => file.path);
  const errors = [];
  for (const required of REQUIRED_FILES) {
    if (!files.includes(required)) errors.push(`missing required file: ${required}`);
  }
  for (const path of files) {
    if (!REQUIRED_FILES.includes(path) && !ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      errors.push(`unexpected packed file: ${path}`);
    }
  }
  if (pack.size > MAX_PACKED_BYTES) errors.push(`packed size ${pack.size} exceeds ${MAX_PACKED_BYTES}`);
  if (pack.unpackedSize > MAX_UNPACKED_BYTES) errors.push(`unpacked size ${pack.unpackedSize} exceeds ${MAX_UNPACKED_BYTES}`);
  return errors;
}

async function run(command, args, options = {}) {
  const result = await exec(command, args, { maxBuffer: 20 * 1024 * 1024, ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

async function main() {
  const packDir = await mkdtemp(join(tmpdir(), "cognitum-npm-pack-"));
  const consumerDir = await mkdtemp(join(tmpdir(), "cognitum-npm-consumer-"));
  try {
    await run(npmCommand, ["run", "build"], { cwd: packageDir });
    const { stdout } = await exec(npmCommand, ["pack", "--json", "--pack-destination", packDir], {
      cwd: packageDir,
      maxBuffer: 20 * 1024 * 1024,
    });
    const [pack] = JSON.parse(stdout);
    if (!pack) throw new Error("npm pack returned no package metadata");
    const errors = validatePack(pack);
    if (errors.length) throw new Error(`npm tarball policy failed:\n- ${errors.join("\n- ")}`);

    const tarball = join(packDir, pack.filename);
    await run(npmCommand, ["init", "--yes"], { cwd: consumerDir });
    await run(npmCommand, ["install", "--ignore-scripts", tarball], { cwd: consumerDir });
    await run(process.execPath, [smokeScript, "@cognitum-one/sdk"], { cwd: consumerDir });

    const installed = JSON.parse(await readFile(join(consumerDir, "node_modules", "@cognitum-one", "sdk", "package.json"), "utf8"));
    if (installed.version !== pack.version) {
      throw new Error(`installed version ${installed.version} does not match packed version ${pack.version}`);
    }
    console.log(`verified ${pack.filename}: ${pack.entryCount} files, ${pack.size} packed bytes, ${pack.unpackedSize} unpacked bytes`);
  } finally {
    await rm(packDir, { recursive: true, force: true });
    await rm(consumerDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
