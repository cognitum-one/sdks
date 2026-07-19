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
    // (ADR-0019 §D2, ADR-0025a §D10, ADR-0029 §D2). This package ships one
    // universal build per subpath (no separate browser/node target here),
    // so "reject at build time" is not wired up via conditional bundler
    // exports — instead `./src/meta-proxy/browser-guard.js` runs a runtime
    // check as the FIRST statement of `MetaProxyClient`'s constructor and
    // throws `UnsupportedRuntimeError` before reading a credential or
    // opening a loopback socket, regardless of which bundler resolves this
    // module for a browser target.
    entry: { "meta-proxy/index": "src/meta-proxy/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    sourcemap: true,
    target: "es2022",
    outDir: "dist",
  },
  {
    // MetaHarness client subpath — @cognitum-one/sdk/metaharness
    // (ADR-0019 §D2, ADR-0026a §D1, ADR-0029 §D2). Same "runtime guard, not
    // build-time exclusion" approach as meta-proxy above: this package
    // ships one universal build per subpath, so `./src/metaharness/browser-guard.js`
    // (a byte-for-byte port of meta-proxy's guard) runs as the FIRST
    // statement of `MetaHarnessClient`'s constructor and throws
    // `UnsupportedRuntimeError` before any npm access, process spawn,
    // repository read, filesystem write, capability probe, login, or
    // prompt, regardless of which bundler resolves this module for a
    // browser target.
    entry: { "metaharness/index": "src/metaharness/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    sourcemap: true,
    target: "es2022",
    outDir: "dist",
  },
  {
    // HarnessaaS client subpath — @cognitum-one/sdk/harnessaas (ADR-0019
    // §D2, ADR-0027a). Depends only on the agentic subpath and `fetch`
    // (same as meta-llm) — this stays safe for browser-facing bundles too;
    // no browser-runtime guard is needed here, unlike meta-proxy/
    // metaharness (ADR-0019 §D2's browser-safe-bundle note names Meta LLM
    // and HarnessaaS together).
    entry: { "harnessaas/index": "src/harnessaas/index.ts" },
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
