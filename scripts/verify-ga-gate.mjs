#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function verifyGaGate(manifestPath) {
  const absoluteManifest = resolve(repoRoot, manifestPath);
  const manifest = JSON.parse(await readFile(absoluteManifest, "utf8"));
  const errors = [];
  const seen = new Set();
  let stableCount = 0;

  for (const [product, client] of Object.entries(manifest.productClients ?? {})) {
    if (!Array.isArray(client.operations) || client.operations.length === 0) {
      errors.push(`${product}: operations inventory is missing or empty`);
      continue;
    }

    for (const operation of client.operations) {
      const key = `${product}.${operation.id}`;
      if (seen.has(key)) errors.push(`${key}: duplicate operation id`);
      seen.add(key);

      if (!["stable", "preview", "internal"].includes(operation.maturity)) {
        errors.push(`${key}: invalid maturity ${JSON.stringify(operation.maturity)}`);
        continue;
      }

      if (operation.maturity !== "stable") continue;
      stableCount += 1;
      const evidence = operation.evidence;
      for (const language of ["node", "python", "rust"]) {
        if (!evidence?.conformance?.[language]?.length) {
          errors.push(`${key}: stable operation lacks ${language} conformance evidence`);
        }
      }
      if (!evidence?.security?.length) {
        errors.push(`${key}: stable operation lacks security evidence`);
      }
      if (!evidence?.artifacts?.length) {
        errors.push(`${key}: stable operation lacks artifact evidence`);
      }

      const paths = [
        ...Object.values(evidence?.conformance ?? {}).flat(),
        ...(evidence?.security ?? []),
        ...(evidence?.artifacts ?? []),
      ];
      for (const evidencePath of paths) {
        try {
          await access(resolve(repoRoot, evidencePath));
        } catch {
          errors.push(`${key}: evidence path does not exist: ${evidencePath}`);
        }
      }
    }
  }

  if (stableCount === 0) errors.push("manifest has no stable operations to gate");
  if (errors.length) throw new Error(errors.join("\n"));
  return { stableCount, operationCount: seen.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = process.argv[2] ?? "capabilities/sdk-release.v1.json";
  try {
    const result = await verifyGaGate(manifest);
    console.log(`GA gate passed: ${result.stableCount} stable operations, ${result.operationCount} inventoried`);
  } catch (error) {
    console.error(`GA gate failed:\n${error.message}`);
    process.exitCode = 1;
  }
}
