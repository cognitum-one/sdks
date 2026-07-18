import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "es2022",
    outDir: "dist",
  },
  {
    // Seed-direct subpath export — @cognitum/sdk/seed
    entry: { "seed/index": "src/seed/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    sourcemap: true,
    target: "es2022",
    outDir: "dist",
  },
  {
    // Opt-in mDNS discovery subpath — @cognitum/sdk/seed/discovery/mdns.
    // Kept out of the main seed bundle so `multicast-dns` stays a
    // peerDependency that only mDNS users install.
    entry: { "seed/discovery/mdns": "src/seed/discovery/mdns.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    sourcemap: true,
    target: "es2022",
    outDir: "dist",
    external: ["multicast-dns"],
  },
  {
    // Shared agentic contract subpath — @cognitum-one/sdk/agentic
    // (ADR-0019 §D2). Type-only scaffolding: no child-process or
    // filesystem imports, so this stays safe for browser-facing Meta LLM
    // and HarnessaaS bundles that depend on it (ADR-0019 §D2 note).
    entry: { "agentic/index": "src/agentic/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    sourcemap: true,
    target: "es2022",
    outDir: "dist",
  },
  {
    // Meta LLM serving client subpath — @cognitum-one/sdk/meta-llm
    // (ADR-0019 §D2, ADR-0024a). Depends only on the agentic subpath and
    // `fetch`, so this stays safe for browser-facing bundles too.
    entry: { "meta-llm/index": "src/meta-llm/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    sourcemap: true,
    target: "es2022",
    outDir: "dist",
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    banner: { js: "#!/usr/bin/env node" },
    clean: false,
    dts: false,
    sourcemap: false,
    target: "es2022",
    outDir: "dist",
  },
]);
