import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * ADR-0019 "Compliance and verification" #2 (issue #74):
 *
 * > Node bundle tests prove importing Meta LLM or HarnessaaS does not
 * > include child-process or filesystem code.
 *
 * ADR-0019 §D2: "Node subpaths MUST avoid importing child-process or
 * filesystem modules into browser-safe Meta LLM and HarnessaaS bundles."
 * `tsup.config.ts`'s comments already assert this in prose for both
 * subpaths ("Depends only on the agentic subpath and `fetch` ... this
 * stays safe for browser-facing bundles too") — this test makes that
 * assertion executable by grepping the actual BUILT `dist/` output (not
 * the TypeScript source, so a transitive dependency pulled in only during
 * bundling would still be caught) for the exact require/import strings a
 * bundler would emit for Node's `child_process` and `fs` built-ins.
 *
 * Scope note (audited before writing this assertion, per issue #74): as of
 * this pass, `meta-proxy` and `metaharness` ALSO have zero child-process/fs
 * imports in their own bundles (`MetaHarnessClient`'s bridge and
 * `MetaProxyManager`'s install/start/stop are not implemented yet — every
 * method is either a real HTTP call or a fail-closed
 * `UnsupportedCapabilityError` stub). This test intentionally checks only
 * `meta-llm` and `harnessaas` because that is what ADR-0019 §D2 actually
 * requires ("browser-safe Meta LLM and HarnessaaS bundles") — `meta-proxy`
 * and `metaharness` are explicitly NOT required to be browser-safe
 * (ADR-0025a §D10 / ADR-0026a §D1's runtime guards reject browser
 * construction outright), so a future real bridge/manager landing
 * child-process or fs code in those two subpaths would NOT be a
 * regression against this check.
 */

const DIST_DIR = path.resolve(fileURLToPath(new URL("../dist", import.meta.url)));

// A bundler-agnostic list of ways `node:child_process`/`node:fs` (and their
// unprefixed aliases) can show up in built CJS or ESM output.
const FORBIDDEN_PATTERNS: RegExp[] = [
  /require\(\s*["']node:child_process["']\s*\)/,
  /require\(\s*["']child_process["']\s*\)/,
  /from\s*["']node:child_process["']/,
  /from\s*["']child_process["']/,
  /import\(\s*["']node:child_process["']\s*\)/,
  /require\(\s*["']node:fs["']\s*\)/,
  /require\(\s*["']fs["']\s*\)/,
  /from\s*["']node:fs["']/,
  /from\s*["']fs["']/,
  /import\(\s*["']node:fs["']\s*\)/,
  /require\(\s*["']node:fs\/promises["']\s*\)/,
  /require\(\s*["']fs\/promises["']\s*\)/,
];

const BROWSER_SAFE_BUNDLES: Array<{ product: string; files: string[] }> = [
  {
    product: "meta-llm",
    files: [path.join(DIST_DIR, "meta-llm", "index.cjs"), path.join(DIST_DIR, "meta-llm", "index.js")],
  },
  {
    product: "harnessaas",
    files: [path.join(DIST_DIR, "harnessaas", "index.cjs"), path.join(DIST_DIR, "harnessaas", "index.js")],
  },
];

describe("ADR-0019 §Compliance #2 — Node bundle isolation (browser-safe subpaths)", () => {
  for (const { product, files } of BROWSER_SAFE_BUNDLES) {
    for (const file of files) {
      it(`${path.relative(DIST_DIR, file)} contains no child-process or filesystem import`, () => {
        expect(
          existsSync(file),
          `${file} does not exist — run "npm run build" before this test (it reads the ` +
            `built dist/ output, not TypeScript source, per ADR-0019 §D2)`,
        ).toBe(true);

        const contents = readFileSync(file, "utf8");
        for (const pattern of FORBIDDEN_PATTERNS) {
          expect(
            pattern.test(contents),
            `${product} bundle (${path.basename(file)}) must not import child_process/fs ` +
              `(ADR-0019 §D2) — matched forbidden pattern ${pattern}`,
          ).toBe(false);
        }
      });
    }
  }
});
