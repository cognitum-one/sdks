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
      // The CLI/MCP-stdio layers intentionally shuttle untyped JSON-RPC
      // payloads and generic HTTP responses; requiring `unknown` casts
      // everywhere there would add noise without catching real bugs.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
