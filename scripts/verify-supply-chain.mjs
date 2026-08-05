#!/usr/bin/env node
/** Verify the repository's reviewable dependency and CI supply-chain pins. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const lock = JSON.parse(await readFile(path.join(root, 'specs/agentic/supply-chain-locks.json'), 'utf8'));
const errors = [];
for (const [file, expected] of Object.entries(lock.lockfiles)) {
  const digest = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
  if (`sha256:${digest}` !== expected) errors.push(`${file}: digest changed; update the reviewed lock manifest`);
}

for await (const workflow of glob('.github/workflows/*.yml', { cwd: root })) {
  const text = await readFile(path.join(root, workflow), 'utf8');
  for (const match of text.matchAll(/uses:\s*([^\s#]+)(?:\s+#.*)?/g)) {
    const ref = match[1].split('@')[1];
    if (ref && !/^[0-9a-f]{40}$/.test(ref)) errors.push(`${workflow}: action ${match[1]} is not pinned to a full commit SHA`);
  }
}

const nodeManifest = JSON.parse(await readFile(path.join(root, 'sdks/node/package.json'), 'utf8'));
if (nodeManifest.dependencies?.metaharness || nodeManifest.devDependencies?.metaharness) {
  errors.push('sdks/node/package.json: MetaHarness must remain an explicit optional bridge, not a package dependency');
}
if (lock.policy.metaharnessMustRemainOptional && !nodeManifest.exports?.['./metaharness']) {
  errors.push('sdks/node/package.json: missing optional MetaHarness subpath export');
}
if (errors.length) {
  console.error(errors.map((e) => `supply-chain: ${e}`).join('\n'));
  process.exit(1);
}
console.log(`supply-chain: verified ${Object.keys(lock.lockfiles).length} lockfile digests and pinned GitHub Actions`);
