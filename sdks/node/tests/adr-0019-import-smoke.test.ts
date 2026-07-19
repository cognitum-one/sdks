import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * ADR-0019 "Compliance and verification" #1 (issue #74):
 *
 * > Import smoke tests prove each product namespace loads without
 * > constructing or probing any other product.
 *
 * Each product subpath (`meta-llm`, `meta-proxy`, `metaharness`,
 * `harnessaas`) MUST be importable on its own, and importing it MUST NOT
 * transitively import any of the other three product subpaths (ADR-0019
 * §D4: "Product modules MUST NOT import one another"). This is verified
 * two ways per product:
 *
 *  1. `vi.doMock` registers the OTHER three product entry modules with a
 *     factory that throws if evaluated. Because Vitest/Vite mocking keys
 *     off the *resolved* module specifier (not the literal import string
 *     used by the importing file), this catches a transitive import of
 *     another product's `index.ts` from ANYWHERE in the target product's
 *     module graph, not just a direct one.
 *  2. A `fetch` spy installed before the import stays uncalled — proving
 *     the import performed no network probe of its own or another
 *     product's service (ADR-0019 §D3: "Constructing one client MUST NOT
 *     construct, install, start, authenticate, or probe another product").
 *
 * `vi.resetModules()` between tests guarantees each import below starts
 * from a clean module registry rather than reusing a previously
 * (un-mocked) cached module.
 */

const PRODUCT_ENTRIES = {
  "meta-llm": "../src/meta-llm/index.js",
  "meta-proxy": "../src/meta-proxy/index.js",
  metaharness: "../src/metaharness/index.js",
  harnessaas: "../src/harnessaas/index.js",
} as const;

type ProductName = keyof typeof PRODUCT_ENTRIES;
const PRODUCT_NAMES = Object.keys(PRODUCT_ENTRIES) as ProductName[];

describe("ADR-0019 §Compliance #1 — import smoke tests", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    fetchSpy = vi.fn(() => {
      throw new Error("import-time fetch: no product module may perform network I/O at import time");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.doUnmock("../src/meta-llm/index.js");
    vi.doUnmock("../src/meta-proxy/index.js");
    vi.doUnmock("../src/metaharness/index.js");
    vi.doUnmock("../src/harnessaas/index.js");
  });

  for (const product of PRODUCT_NAMES) {
    it(`importing ${product} alone loads without constructing or probing any other product`, async () => {
      const others = PRODUCT_NAMES.filter((p) => p !== product);
      for (const other of others) {
        vi.doMock(PRODUCT_ENTRIES[other], () => {
          throw new Error(
            `importing ${product} must not transitively import the ${other} product module (ADR-0019 §D4)`,
          );
        });
      }

      // The shared `agentic` module is allowed (it is the common dependency
      // every product depends on, ADR-0019 §D4's dependency-direction diagram).
      await expect(import(PRODUCT_ENTRIES[product])).resolves.toBeTruthy();

      // No product performs any network probe merely by being imported.
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it("importing the shared agentic module alone loads without touching any product module", async () => {
    for (const other of PRODUCT_NAMES) {
      vi.doMock(PRODUCT_ENTRIES[other], () => {
        throw new Error(`importing agentic must not import the ${other} product module (ADR-0019 §D4)`);
      });
    }

    await expect(import("../src/agentic/index.js")).resolves.toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
