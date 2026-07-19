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
    // Meta Proxy client subpath — @cognitum-one/sdk/meta-proxy
    // (ADR-0019 §D2, ADR-0025a). Depends only on the agentic subpath and
    // `fetch`, so this stays safe for browser-facing bundles too — though
    // ADR-0025a §D10 means an actual browser build should reject
    // constructing this client before opening a loopback socket (deferred
    // to a follow-up pass; not implemented in this subpath yet).
    entry: { "meta-proxy/index": "src/meta-proxy/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    sourcemap: true,
    target: "es2022",
    outDir: "dist",
  },
  {
    // Protocol-agnostic SSE parser subpath — @cognitum-one/sdk/sse
    // (ADR-0024a §D5). Zero product knowledge, zero dependencies beyond
    // `TextDecoder`/`TextEncoder` — safe for browser-facing bundles.
    // `meta-llm`'s chat-completions streaming imports this directly by
    // relative path (not through this subpath) — the subpath export exists
    // so a future Anthropic/Responses streaming facade in another package
    // can reuse it too.
    entry: { "sse/index": "src/sse/index.ts" },
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
