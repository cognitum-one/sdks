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
// Supports exactly the keywords used by sdk-release.schema.json: type,
// required, additionalProperties, properties, enum, const, pattern, format
// (date-time/uri, loosely), items, minLength, $ref (local #/$defs only).
// This is intentionally not a general-purpose validator.

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

  if (schema.type === "object") {
    if (typeof instance !== "object" || instance === null || Array.isArray(instance)) {
      errors.push(`${path}: expected object`);
      return;
    }
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
  } else if (schema.type === "array") {
    if (!Array.isArray(instance)) {
      errors.push(`${path}: expected array`);
      return;
    }
    if (schema.items) {
      instance.forEach((item, i) => validate(item, schema.items, schemaRoot, `${path}[${i}]`, errors));
    }
  } else if (schema.type === "string") {
    if (typeof instance !== "string") {
      errors.push(`${path}: expected string, got ${typeof instance}`);
      return;
    }
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
  // schema.type === undefined (pure $ref/enum/const-only nodes) needs no further structural check.
}

function validateManifest(manifest, schema) {
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
          `${name}: manifest claims registryVersion "${lang.registryVersion}" but live registry reports "${liveVersion}" -- update the manifest or investigate a stalled publish (see .mission/GUIDANCE.md for the crates.io 0.3.0 incident this check exists to catch).`,
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
  console.log("\nCapability manifest is valid and matches live registries.");
}

main().catch((err) => {
  console.error(`Fatal: ${err.stack ?? err.message}`);
  process.exit(1);
});
