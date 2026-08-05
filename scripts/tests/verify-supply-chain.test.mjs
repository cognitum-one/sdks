import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

test('reviewed supply-chain pins are intact', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const output = execFileSync(process.execPath, ['scripts/verify-supply-chain.mjs'], { cwd: root, encoding: 'utf8' });
  assert.match(output, /verified 2 lockfile digests/);
});
