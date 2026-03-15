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
