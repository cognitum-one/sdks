#!/usr/bin/env node
// Validates capabilities/sdk-release.v1.json against its JSON Schema, then
// independently re-checks each language's registryVersion against the live
// registry (npm, PyPI, crates.io). Dependency-free by design -- see
// cognitum-one/sdks issue #123 and cognitum-one/website ADR-101 ("Drift
// prevention"): a manifest is only useful if CI catches drift, not just typos.
//
// Usage: node scripts/verify-release-manifest.mjs [--offline]
//   --offline  skip the live-registry cross-check (schema validation only)

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MANIFEST_PATH = join(ROOT, "capabilities", "sdk-release.v1.json");
const SCHEMA_PATH = join(ROOT, "capabilities", "sdk-release.schema.json");
const USER_AGENT = "cognitum-sdks-check (ruvnet@gmail.com)";
const OFFLINE = process.argv.includes("--offline");

let errorCount = 0;
function fail(message) {
  errorCount += 1;
  console.error(`✗ ${message}`);
}
function ok(message) {
  console.log(`✓ ${message}`);
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// --- Minimal JSON Schema (draft-07 subset) validator -----------------------
// Intentionally not a general-purpose validator: it implements only the
// keywords sdk-release.schema.json actually uses. That is a safe trade ONLY
// while the two stay in sync, and they had already drifted -- the schema grew
// allOf/if/then (the "stable operations must carry evidence" rule), minItems
// and uniqueItems, none of which this validator implemented. It silently
// ignored them and still printed "manifest matches ...", which is the worst
// failure mode a verification step can have: passing without verifying.
// SUPPORTED_KEYWORDS below now closes that loop -- an unimplemented keyword
// appearing anywhere in the schema is a hard error, so the next time the
// schema grows a rule this script fails loudly instead of lying quietly.

const SUPPORTED_KEYWORDS = new Set([
  "$schema", "$id", "$ref", "$defs", "title", "description", "examples", "default",
  "type", "properties", "required", "additionalProperties", "items",
  "enum", "const", "pattern", "format", "minLength",
  "minItems", "uniqueItems", "allOf", "if", "then", "else",
]);

// Keywords whose VALUES are instance data, not subschemas. Recursing into
// them would report a user's data keys as unknown schema keywords.
const DATA_VALUED_KEYWORDS = new Set(["enum", "const", "default", "examples"]);

// Keyword name alone is not enough: draft-07 allows shapes this validator
// does not implement (union `type`, tuple `items`, schema-valued
// `additionalProperties`, boolean schemas). Accepting those on name would
// make the "next schema change fails loudly" promise false, which is the very
// failure this guard exists to prevent.
const SHAPE_CHECKS = {
  type: (value) => typeof value === "string" || "must be a single type string (union types are not implemented)",
  items: (value) => (value !== null && typeof value === "object" && !Array.isArray(value)) || "must be a single schema object (tuple form is not implemented)",
  additionalProperties: (value) => value === false || "only `false` is implemented (schema-valued form is not)",
  required: (value) => Array.isArray(value) || "must be an array",
  allOf: (value) => Array.isArray(value) || "must be an array",
  uniqueItems: (value) => typeof value === "boolean" || "must be a boolean",
  minItems: (value) => typeof value === "number" || "must be a number",
  minLength: (value) => typeof value === "number" || "must be a number",
  format: (value) => value === "date-time" || value === "uri" || `unimplemented format "${value}"`,
};

export function unsupportedKeywords(schema, path = "#", found = new Set()) {
  if (Array.isArray(schema)) {
    schema.forEach((entry, i) => unsupportedKeywords(entry, `${path}[${i}]`, found));
    return found;
  }
  // A boolean schema (`true`/`false`) is legal draft-07 and not implemented here.
  if (typeof schema === "boolean") {
    found.add(`${path}: boolean schema is not implemented`);
    return found;
  }
  if (schema === null || typeof schema !== "object") return found;

  for (const [key, value] of Object.entries(schema)) {
    // Keys under `properties`/`$defs` are instance/definition names, not keywords.
    if (key === "properties" || key === "$defs") {
      for (const [name, sub] of Object.entries(value ?? {})) {
        unsupportedKeywords(sub, `${path}.${key}.${name}`, found);
      }
      continue;
    }
    if (!SUPPORTED_KEYWORDS.has(key)) {
      found.add(`${path}.${key}`);
      continue;
    }
    const shape = SHAPE_CHECKS[key]?.(value);
    if (shape !== undefined && shape !== true) found.add(`${path}.${key}: ${shape}`);
    if (DATA_VALUED_KEYWORDS.has(key)) continue;
    // Only descend into values that could BE a schema. A scalar keyword value
    // (`uniqueItems: true`, `additionalProperties: false`, `minItems: 1`) has
    // already been shape-checked above; treating it as a nested schema would
    // misreport it as an unimplemented boolean schema.
    if (value !== null && typeof value === "object") {
      unsupportedKeywords(value, `${path}.${key}`, found);
    }
  }
  return found;
}

function resolveRef(ref, schemaRoot) {
  if (!ref.startsWith("#/")) {
    throw new Error(`Unsupported $ref (not local): ${ref}`);
  }
  const parts = ref.slice(2).split("/");
  let node = schemaRoot;
  for (const part of parts) {
    node = node[part];
    if (node === undefined) throw new Error(`$ref not found: ${ref}`);
  }
  return node;
}

// Order-independent serialisation, for structural equality comparisons.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const URI_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+$/;

function validate(instance, schema, schemaRoot, path, errors) {
  if (schema.$ref) {
    schema = resolveRef(schema.$ref, schemaRoot);
  }

  if (schema.const !== undefined && instance !== schema.const) {
    errors.push(`${path}: expected const "${schema.const}", got "${instance}"`);
  }

  if (schema.enum && !schema.enum.includes(instance)) {
    errors.push(`${path}: value "${instance}" not in enum [${schema.enum.join(", ")}]`);
  }

  // allOf / if-then-else. The schema uses this to express the central GA
  // rule: an operation whose maturity is "stable" MUST carry conformance,
  // security and artifact evidence. verify-ga-gate.mjs enforces a version of
  // that too, but the schema is where the contract is written down, so the
  // schema check has to actually apply it.
  for (const subSchema of schema.allOf ?? []) {
    validate(instance, subSchema, schemaRoot, path, errors);
  }
  if (schema.if) {
    const branch = matches(instance, schema.if, schemaRoot) ? schema.then : schema.else;
    if (branch) validate(instance, branch, schemaRoot, path, errors);
  }

  // Declared `type` is checked when present, but the structural keywords
  // below are applied on the INSTANCE's type, not the declared one. That is
  // both correct JSON Schema semantics and load-bearing here: the schema's
  // `then` branch carries `required`/`properties` with no `type` of its own,
  // so dispatching on the declared type skipped it entirely -- the exact way
  // the stable-needs-evidence rule went unenforced.
  const isObject = typeof instance === "object" && instance !== null && !Array.isArray(instance);
  if (schema.type === "object" && !isObject) {
    errors.push(`${path}: expected object`);
    return;
  }
  if (schema.type === "array" && !Array.isArray(instance)) {
    errors.push(`${path}: expected array`);
    return;
  }
  if (schema.type === "string" && typeof instance !== "string") {
    errors.push(`${path}: expected string, got ${typeof instance}`);
    return;
  }

  if (isObject) {
    for (const key of schema.required ?? []) {
      if (!(key in instance)) errors.push(`${path}: missing required property "${key}"`);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(instance)) {
        if (!allowed.has(key)) errors.push(`${path}: unexpected additional property "${key}"`);
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
      if (key in instance) {
        validate(instance[key], propSchema, schemaRoot, `${path}.${key}`, errors);
      }
    }
  }

  if (Array.isArray(instance)) {
    if (schema.minItems !== undefined && instance.length < schema.minItems) {
      errors.push(`${path}: expected at least ${schema.minItems} item(s), got ${instance.length}`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      for (const item of instance) {
        // Canonicalise before comparing: JSON Schema equality is structural,
        // so {a:1,b:2} and {b:2,a:1} are the same item even though plain
        // JSON.stringify preserves insertion order and would call them
        // distinct.
        const key = canonicalJson(item);
        if (seen.has(key)) errors.push(`${path}: duplicate item ${key}`);
        seen.add(key);
      }
    }
    if (schema.items) {
      instance.forEach((item, i) => validate(item, schema.items, schemaRoot, `${path}[${i}]`, errors));
    }
  }

  if (typeof instance === "string") {
    if (schema.minLength !== undefined && instance.length < schema.minLength) {
      errors.push(`${path}: string shorter than minLength ${schema.minLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(instance)) {
      errors.push(`${path}: "${instance}" does not match pattern ${schema.pattern}`);
    }
    if (schema.format === "date-time" && !DATE_TIME_RE.test(instance)) {
      errors.push(`${path}: "${instance}" is not a valid date-time`);
    }
    if (schema.format === "uri" && !URI_RE.test(instance)) {
      errors.push(`${path}: "${instance}" is not a valid uri`);
    }
  }
}

// Does `instance` satisfy `schema`? Used for `if` branch selection, where a
// non-match selects `else` rather than raising an error.
function matches(instance, schema, schemaRoot) {
  const errors = [];
  validate(instance, schema, schemaRoot, "#", errors);
  return errors.length === 0;
}

export function validateManifest(manifest, schema) {
  // Fail before validating if the schema expresses a rule this validator
  // cannot apply. Reporting "matches" while skipping a constraint is worse
  // than reporting nothing, because it retires the question.
  const unsupported = unsupportedKeywords(schema);
  if (unsupported.size > 0) {
    return [
      `schema uses keyword(s) this validator does not implement: ${[...unsupported].sort().join(", ")}`,
      "implement them in validate() (and add to SUPPORTED_KEYWORDS) -- do not widen the allow-list alone",
    ];
  }
  const errors = [];
  validate(manifest, schema, schema, "$", errors);
  return errors;
}

// --- Live registry cross-check ---------------------------------------------

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, ...headers } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function checkNode(lang) {
  const data = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(lang.packageName).replace("%40", "@")}`);
  const latest = data["dist-tags"]?.latest;
  if (!latest) throw new Error("no dist-tags.latest in npm registry response");
  return latest;
}

async function checkPython(lang) {
  const data = await fetchJson(`https://pypi.org/pypi/${lang.distributionName}/json`);
  const version = data.info?.version;
  if (!version) throw new Error("no info.version in PyPI response");
  return version;
}

async function checkRust(lang) {
  const data = await fetchJson(`https://crates.io/api/v1/crates/${lang.crateName}`);
  const version = data.crate?.max_stable_version ?? data.crate?.max_version;
  if (!version) throw new Error("no crate.max_stable_version in crates.io response");
  return version;
}

async function crossCheckRegistries(manifest) {
  const checks = [
    ["node", checkNode],
    ["python", checkPython],
    ["rust", checkRust],
  ];
  for (const [name, checker] of checks) {
    const lang = manifest.languages[name];
    try {
      const liveVersion = await checker(lang);
      if (liveVersion !== lang.registryVersion) {
        fail(
          `${name}: manifest claims registryVersion "${lang.registryVersion}" but live registry reports "${liveVersion}" -- update the manifest, or investigate a stalled publish (this is the exact class of drift this check exists to catch -- see issue #123).`,
        );
      } else {
        ok(`${name}: registryVersion "${lang.registryVersion}" matches live registry`);
      }
    } catch (err) {
      fail(`${name}: could not verify live registry version -- ${err.message}`);
    }
  }
}

async function main() {
  const [manifest, schema] = await Promise.all([loadJson(MANIFEST_PATH), loadJson(SCHEMA_PATH)]);

  const schemaErrors = validateManifest(manifest, schema);
  if (schemaErrors.length === 0) {
    ok("manifest matches capabilities/sdk-release.schema.json");
  } else {
    for (const e of schemaErrors) fail(`schema: ${e}`);
  }

  const source = { node: manifest.languages.node, python: manifest.languages.python, rust: manifest.languages.rust };
  for (const [name, lang] of Object.entries(source)) {
    if (lang.sourceVersion !== lang.registryVersion) {
      console.warn(
        `⚠ ${name}: sourceVersion "${lang.sourceVersion}" differs from registryVersion "${lang.registryVersion}" -- allowed (source ahead of publish) but should not silently persist across releases.`,
      );
    }
  }

  if (OFFLINE) {
    console.log("(--offline: skipping live registry cross-check)");
  } else {
    await crossCheckRegistries(manifest);
  }

  if (errorCount > 0) {
    console.error(`\n${errorCount} error(s) found in capability manifest.`);
    process.exit(1);
  }
  // Say what was actually checked. `--offline` skips the live cross-check
  // entirely, so claiming it "matches live registries" there would assert a
  // fact this run never established -- and the release workflow's build job
  // runs exactly that offline path.
  console.log(
    OFFLINE
      ? "\nCapability manifest is valid (schema only; live registry cross-check was skipped)."
      : "\nCapability manifest is valid and matches live registries.",
  );
}

// Guarded like verify-ga-gate.mjs and release-preflight.mjs. Without this,
// merely importing this module for a unit test executes the whole check --
// including live calls to npm, PyPI and crates.io -- which makes the test
// suite network-dependent and flaky for reasons unrelated to what it tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`Fatal: ${err.stack ?? err.message}`);
    process.exit(1);
  });
}
