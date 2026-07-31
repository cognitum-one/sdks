import test from "node:test";
import assert from "node:assert/strict";
import { parityErrors, versionFromTag } from "../release-preflight.mjs";

test("accepts stable and prerelease canonical tags", () => {
  assert.equal(versionFromTag("v1.2.3"), "1.2.3");
  assert.equal(versionFromTag("v1.2.3-rc.1"), "1.2.3-rc.1");
});

test("rejects tags that are not canonical release tags", () => {
  for (const tag of ["1.2.3", "v01.2.3", "v1.2", "release-v1.2.3"]) {
    assert.throws(() => versionFromTag(tag), /canonical SemVer/);
  }
});

test("reports every mismatched version", () => {
  assert.deepEqual(parityErrors("1.2.3", { node: "1.2.3", python: "1.2.2", rust: "1.2.1" }), [
    "python: expected 1.2.3, got 1.2.2",
    "rust: expected 1.2.3, got 1.2.1",
  ]);
});
