import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { verifyGaGate } from "../verify-ga-gate.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const manifestPath = join(repoRoot, "capabilities/sdk-release.v1.json");

async function mutatedManifest(mutator) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  mutator(manifest);
  const directory = await mkdtemp(join(tmpdir(), "sdk-ga-gate-"));
  const path = join(directory, "manifest.json");
  await writeFile(path, JSON.stringify(manifest));
  return relative(repoRoot, path);
}

test("accepts the checked-in GA evidence inventory", async () => {
  const result = await verifyGaGate("capabilities/sdk-release.v1.json");
  assert.ok(result.stableCount > 0);
});

test("rejects promotion to stable without cross-language evidence", async () => {
  const path = await mutatedManifest((manifest) => {
    const operation = manifest.productClients.metaLlm.operations[0];
    operation.maturity = "stable";
    delete operation.evidence;
  });
  await assert.rejects(verifyGaGate(path), /lacks node conformance evidence/);
});

test("rejects a stable operation whose evidence path disappeared", async () => {
  const path = await mutatedManifest((manifest) => {
    manifest.productClients.agenticCore.operations[0].evidence.security = ["missing/security-evidence.test"];
  });
  await assert.rejects(verifyGaGate(path), /evidence path does not exist/);
});

test("rejects a source file presented as conformance evidence", async () => {
  const path = await mutatedManifest((manifest) => {
    manifest.productClients.agenticCore.operations[0].evidence.conformance.node = [
      "sdks/node/src/agentic/scope-preflight.ts",
    ];
  });
  await assert.rejects(verifyGaGate(path), /conformance evidence is not an executable test/);
});

test("rejects generic package metadata presented as artifact evidence", async () => {
  const path = await mutatedManifest((manifest) => {
    manifest.productClients.agenticCore.operations[0].evidence.artifacts = ["sdks/node/package.json"];
  });
  await assert.rejects(verifyGaGate(path), /artifact evidence must identify an SDK implementation file/);
});

test("rejects security evidence that is not explicit and distinct", async () => {
  const path = await mutatedManifest((manifest) => {
    const operation = manifest.productClients.agenticCore.operations[3];
    operation.evidence.security = [...operation.evidence.conformance.node];
  });
  await assert.rejects(verifyGaGate(path), /security evidence must be distinct from conformance evidence/);
});
