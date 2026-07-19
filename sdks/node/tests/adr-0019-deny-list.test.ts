import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * ADR-0019 "Compliance and verification" #5 (issue #74):
 *
 * > A deny-list test fails if a product module imports another product
 * > module.
 *
 * ADR-0019 §D4: "Product modules MUST NOT import one another." The one
 * documented exception is §D7: "Meta LLM and Meta Proxy share OpenAI and
 * Anthropic wire primitives where their capability sets agree. They do not
 * share a client class." In this codebase that exception is exercised
 * exactly once: `meta-proxy/client.ts` imports `ChatCompletion`/
 * `ChatCompletionRequest`/`OpenAiStreamEvent` — pure wire *types*, never
 * `MetaLlmClient` itself — from `../meta-llm/types/*` and
 * `../meta-llm/stream/*`. This test therefore denies ANY import from one
 * product's source into another's, with a narrow, explicit allowlist for
 * that one type-only carve-out (never the product's `client.ts`, `config.ts`,
 * or `index.ts` — the client-class surface D7 explicitly forbids sharing).
 */

const SRC_DIR = path.resolve(fileURLToPath(new URL("../src", import.meta.url)));

const PRODUCTS = ["meta-llm", "meta-proxy", "metaharness", "harnessaas"] as const;
type Product = (typeof PRODUCTS)[number];

/**
 * D7's one documented wire-type carve-out: Meta Proxy may import Meta LLM's
 * `types/` and `stream/` (wire-shape-only) modules, never its client class
 * or config/index surface.
 */
const ALLOWED_CROSS_IMPORTS: Record<Product, RegExp[]> = {
  "meta-llm": [],
  "meta-proxy": [/^\.\.\/meta-llm\/types\//, /^\.\.\/meta-llm\/stream\//],
  metaharness: [],
  harnessaas: [],
};

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Every relative or subpath import specifier referenced by `source`. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /import\s+(?:type\s+)?[^;'"]*?from\s*["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /export\s+(?:type\s+)?[^;'"]*?from\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specs.push(match[1]);
    }
  }
  return specs;
}

/** `true` when `specifier` (relative to a file inside `fromProduct`'s dir) points into `intoProduct`. */
function pointsIntoProduct(specifier: string, intoProduct: Product): boolean {
  // Cross-product relative imports from one product dir always look like
  // "../<other-product>/..." because every product lives one level below
  // `src/`. Subpath-style imports (`@cognitum-one/sdk/<other-product>`)
  // are also denied.
  return (
    specifier.startsWith(`../${intoProduct}/`) ||
    specifier === `../${intoProduct}` ||
    specifier.includes(`/sdk/${intoProduct}`)
  );
}

describe("ADR-0019 §Compliance #5 — deny-list: no product imports another product", () => {
  for (const fromProduct of PRODUCTS) {
    const dir = path.join(SRC_DIR, fromProduct);

    it(`${fromProduct} source imports no other product module (except D7's wire-type carve-out)`, () => {
      const files = listTsFiles(dir);
      expect(files.length, `expected to find .ts files under ${dir}`).toBeGreaterThan(0);

      const violations: string[] = [];
      for (const file of files) {
        const source = readFileSync(file, "utf8");
        for (const specifier of importSpecifiers(source)) {
          for (const otherProduct of PRODUCTS) {
            if (otherProduct === fromProduct) continue;
            if (!pointsIntoProduct(specifier, otherProduct)) continue;

            const allowed = ALLOWED_CROSS_IMPORTS[fromProduct].some((re) => re.test(specifier));
            if (!allowed) {
              violations.push(
                `${path.relative(SRC_DIR, file)} imports "${specifier}" (product "${otherProduct}") — ` +
                  `forbidden by ADR-0019 §D4, no §D7 wire-type carve-out matches`,
              );
            }
          }
        }
      }

      expect(violations, violations.join("\n")).toEqual([]);
    });
  }

  it("meta-proxy's documented §D7 wire-type carve-out is exercised (not a dead allowlist entry)", () => {
    const files = listTsFiles(path.join(SRC_DIR, "meta-proxy"));
    const usesCarveOut = files.some((file) => {
      const source = readFileSync(file, "utf8");
      return importSpecifiers(source).some((specifier) =>
        ALLOWED_CROSS_IMPORTS["meta-proxy"].some((re) => re.test(specifier)),
      );
    });
    expect(
      usesCarveOut,
      "expected at least one meta-proxy file to import meta-llm/types or meta-llm/stream " +
        "(ADR-0019 §D7) — if this no longer holds, remove the dead allowlist entry above",
    ).toBe(true);
  });
});
