import assert from "node:assert/strict";
import test from "node:test";

import { MAX_PACKED_BYTES, MAX_UNPACKED_BYTES, validatePack } from "../verify-npm-tarball.mjs";

const validFiles = [
  { path: "package.json" },
  { path: "README.md" },
  { path: "LICENSE" },
  { path: "CHANGELOG.md" },
  { path: "dist/index.js" },
];

test("accepts the documented package surface", () => {
  assert.deepEqual(validatePack({ files: validFiles, size: 1000, unpackedSize: 2000 }), []);
});

test("rejects missing, unexpected, and oversized content", () => {
  const errors = validatePack({
    files: [...validFiles.filter((file) => file.path !== "LICENSE"), { path: "src/private.ts" }],
    size: MAX_PACKED_BYTES + 1,
    unpackedSize: MAX_UNPACKED_BYTES + 1,
  });
  assert.ok(errors.some((error) => error.includes("missing required file: LICENSE")));
  assert.ok(errors.some((error) => error.includes("unexpected packed file: src/private.ts")));
  assert.ok(errors.some((error) => error.includes("packed size")));
  assert.ok(errors.some((error) => error.includes("unpacked size")));
});
