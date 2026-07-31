import { defineConfig } from "vitest/config";

// Coverage thresholds are a RATCHET, not a target. They are set just below
// what this configuration measured when it was added (2026-07-31: 83.96%
// statements/lines, 77.97% branches, 93.16% functions), so the gate fails on
// a regression while leaving a little slack for legitimate refactors. Raise
// them when coverage rises; never lower them to make a build pass.
//
// `all: true` is load-bearing. Without it v8 only reports files some test
// imported, so deleting the last test that touched a module makes coverage go
// UP -- the metric would reward removing tests.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      all: true,
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
