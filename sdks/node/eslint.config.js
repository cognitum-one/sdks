// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Unused vars/params are already enforced (more strictly) by
      // tsc via noUnusedLocals/noUnusedParameters in tsconfig.json.
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // The CLI/MCP-stdio layers intentionally shuttle untyped JSON-RPC
    // payloads and generic HTTP responses; requiring `unknown` casts
    // everywhere there would add noise without catching real bugs.
    // Scoped narrowly so a stray `any` elsewhere still gets caught.
    files: ["src/cli.ts", "src/mcp.ts", "src/mcp-stdio.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Test mocks routinely need to match loosely-typed stdlib signatures
    // (e.g. JSON.stringify's replacer/space params) — standard test-only
    // leeway, doesn't weaken production source type-checking.
    files: ["tests/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
