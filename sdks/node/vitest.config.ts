import { defineConfig } from "vitest/config";

// Coverage thresholds are a RATCHET, not a target. Preserve the original
// floors across the Vitest 4 AST-remapping migration; add real tests when a
// more accurate denominator reveals gaps. Never lower floors to make a pass.
//
// Vitest 4 removed `all`. The explicit include below keeps covered AND
// uncovered source files in the denominator. Do not remove it: reporting only
// imported files would reward deleting the last test that touches a module.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/**/index.ts"],
      reporter: ["text-summary", "lcov"],
      thresholds: {
        statements: 83.5,
        lines: 83.5,
        branches: 77.5,
        functions: 92.5,
      },
    },
  },
});
