import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { unsupportedKeywords, validateManifest } from "../verify-release-manifest.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = async (path) => JSON.parse(await readFile(resolve(repoRoot, path), "utf8"));

const realSchema = () => readJson("capabilities/sdk-release.schema.json");
const realManifest = () => readJson("capabilities/sdk-release.v1.json");

// --- the drift guard -------------------------------------------------------
// These are the regression tests for the class of bug this file exists to
// prevent: a validator that reports success for constraints it never applied.

test("the real schema uses no keyword the validator cannot apply", async () => {
  assert.deepEqual([...unsupportedKeywords(await realSchema())], []);
});

test("a schema keyword the validator does not implement is a hard error", () => {
  const errors = validateManifest({}, { type: "object", propertyNames: { pattern: "^x" } });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /does not implement: #\.propertyNames/);
});

test("property and $defs names are not mistaken for keywords", () => {
  const schema = { type: "object", properties: { uniqueItems: { type: "string" } }, $defs: { minItems: { type: "string" } } };
  assert.deepEqual([...unsupportedKeywords(schema)], []);
});

test("instance data under enum/const/default/examples is not scanned for keywords", () => {
  // These keywords' values are DATA. Recursing into them reports a user's
  // data keys as unknown schema keywords -- a false positive that would
  // block a perfectly valid schema.
  const schema = {
    type: "object",
    default: { customerField: 1 },
    examples: [{ customerField: 1 }],
    enum: [{ notAKeyword: true }],
    const: { alsoNotAKeyword: true },
  };
  assert.deepEqual([...unsupportedKeywords(schema)], []);
});

test("a supported keyword in an unimplemented SHAPE is still rejected", () => {
  // Recognising keyword spelling alone is not enough: draft-07 permits
  // shapes this validator does not implement, and silently accepting them
  // would reintroduce exactly the pass-without-verifying bug.
  const cases = [
    [{ type: ["string", "null"] }, /type: must be a single type string/],
    [{ type: "array", items: [{ type: "string" }] }, /items: must be a single schema object/],
    [{ type: "object", additionalProperties: { type: "string" } }, /additionalProperties: only `false` is implemented/],
    [{ type: "object", properties: { x: false } }, /boolean schema is not implemented/],
    [{ type: "string", format: "email" }, /format: unimplemented format "email"/],
  ];
  for (const [schema, expected] of cases) {
    const found = [...unsupportedKeywords(schema)];
    assert.equal(found.length, 1, `expected exactly one complaint for ${JSON.stringify(schema)}, got ${JSON.stringify(found)}`);
    assert.match(found[0], expected);
  }
});

test("uniqueItems uses structural equality, not key order", () => {
  const schema = { type: "array", uniqueItems: true };
  const errors = validateManifest([{ a: 1, b: 2 }, { b: 2, a: 1 }], schema);
  assert.equal(errors.length, 1, "objects equal up to key order are the same item");
  assert.match(errors[0], /duplicate item/);
});

// --- the keywords that were silently skipped -------------------------------

test("uniqueItems rejects a duplicated evidence path", () => {
  const schema = { type: "array", uniqueItems: true, items: { type: "string" } };
  const errors = validateManifest(["a.ts", "a.ts"], schema);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /duplicate item/);
});

test("minItems rejects an empty evidence array", () => {
  const errors = validateManifest([], { type: "array", minItems: 1, items: { type: "string" } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /at least 1 item/);
});

test("if/then applies the stable-operation evidence rule", () => {
  const schema = {
    type: "object",
    allOf: [{
      if: { properties: { maturity: { const: "stable" } }, required: ["maturity"] },
      then: { required: ["evidence"] },
    }],
  };
  assert.deepEqual(validateManifest({ maturity: "preview" }, schema), [], "preview needs no evidence");
  const errors = validateManifest({ maturity: "stable" }, schema);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing required property "evidence"/);
});

test("a then-branch with no declared type still enforces nested required", () => {
  // Regression: dispatching on the DECLARED type skipped `then` entirely,
  // because the schema's then-branch carries only required/properties.
  const schema = {
    type: "object",
    if: { properties: { maturity: { const: "stable" } }, required: ["maturity"] },
    then: { required: ["evidence"], properties: { evidence: { required: ["conformance", "security", "artifacts"] } } },
  };
  const errors = validateManifest({ maturity: "stable", evidence: { conformance: {} } }, schema);
  assert.equal(errors.length, 2);
  assert.match(errors.join("\n"), /missing required property "security"/);
  assert.match(errors.join("\n"), /missing required property "artifacts"/);
});

// --- the real manifest still passes ----------------------------------------

test("the committed manifest validates against the committed schema", async () => {
  assert.deepEqual(validateManifest(await realManifest(), await realSchema()), []);
});

test("a stable operation stripped of its evidence is rejected", async () => {
  const manifest = await realManifest();
  const stable = Object.values(manifest.productClients)
    .flatMap((client) => client.operations ?? [])
    .find((operation) => operation.maturity === "stable");
  assert.ok(stable, "fixture requires at least one stable operation");
  delete stable.evidence;
  const errors = validateManifest(manifest, await realSchema());
  assert.ok(errors.length > 0, "a stable operation without evidence must fail schema validation");
  assert.match(errors.join("\n"), /evidence/);
});

test("date-time format rejects impossible timestamps", () => {
  const schema = { type: "string", format: "date-time" };
  const bad = ["2026-99-99T25:61:61Z", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2025-02-29T00:00:00Z"];
  for (const value of bad) {
    assert.equal(validateManifest(value, schema).length, 1, `${value} should be rejected`);
  }
  const good = ["2026-07-31T09:00:00Z", "2024-02-29T00:00:00Z", "2026-07-31T09:00:00.123+02:00"];
  for (const value of good) {
    assert.deepEqual(validateManifest(value, schema), [], `${value} should be accepted`);
  }
});
