import { describe, it, expect } from "vitest";

import {
  SCAFFOLD_PLAN_SCHEMA_V1,
  SCAFFOLD_REQUEST_SCHEMA_V1,
  SCAFFOLD_RESULT_SCHEMA_V1,
  parseHarnessManifest,
  parseWitnessVerification,
  type GitRepository,
  type LocalRepository,
  type RepositorySource,
  type ScaffoldPlan,
  type ScaffoldRequestV1,
  type ScaffoldResult,
} from "../src/metaharness/types.js";

describe("MetaHarnessClient domain types (ADR-0026a §D3) — schema literals", () => {
  it("carries the exact schema string literals specified by the ADR", () => {
    expect(SCAFFOLD_REQUEST_SCHEMA_V1).toBe("cognitum.metaharness.scaffold-request.v1");
    expect(SCAFFOLD_PLAN_SCHEMA_V1).toBe("cognitum.metaharness.scaffold-plan.v1");
    expect(SCAFFOLD_RESULT_SCHEMA_V1).toBe("cognitum.metaharness.scaffold-result.v1");
  });
});

describe("RepositorySource — tagged union round-trip", () => {
  it("round-trips a LocalRepository through JSON unchanged", () => {
    const source: LocalRepository = {
      kind: "local",
      canonicalPath: "/tmp/repo",
      expectedTreeDigest: "sha256:abc123",
    };
    const roundTripped = JSON.parse(JSON.stringify(source)) as RepositorySource;
    expect(roundTripped).toEqual(source);
    expect(roundTripped.kind).toBe("local");
  });

  it("round-trips a GitRepository through JSON unchanged", () => {
    const source: GitRepository = {
      kind: "git",
      url: "https://github.com/ruvnet/metaharness.git",
      requestedRef: "main",
      resolvedCommitSha: "072b95c0a74610de008dca5473343a81619cef20",
    };
    const roundTripped = JSON.parse(JSON.stringify(source)) as RepositorySource;
    expect(roundTripped).toEqual(source);
    expect(roundTripped.kind).toBe("git");
  });
});

describe("ScaffoldRequestV1 — round-trip", () => {
  it("round-trips through JSON with the exact schema literal", () => {
    const request: ScaffoldRequestV1 = {
      schema: SCAFFOLD_REQUEST_SCHEMA_V1,
      name: "demo-harness",
      template: "default",
      primaryHost: "claude-code",
      hosts: ["claude-code", "codex"],
      description: "a demo harness",
      target: "/tmp/target",
      darwin: false,
      repositorySource: { kind: "local", canonicalPath: "/tmp/repo" },
    };
    const roundTripped = JSON.parse(JSON.stringify(request)) as ScaffoldRequestV1;
    expect(roundTripped).toEqual(request);
    expect(roundTripped.schema).toBe("cognitum.metaharness.scaffold-request.v1");
  });
});

describe("parseHarnessManifest — unknown-field preservation (ADR-0026a §D3)", () => {
  it("parses every documented manifest field", () => {
    const wire = {
      schema: "cognitum.metaharness.manifest.v1",
      generator: "metaharness-oss",
      template: "default",
      template_version: "0.0.0",
      vars: { projectName: "demo" },
      hosts: ["claude-code"],
      files: ["CLAUDE.md", ".claude/settings.json"],
      generated_at: "2026-07-18T00:00:00Z",
      meta: { note: "generated" },
    };
    const manifest = parseHarnessManifest(wire);
    expect(manifest).toEqual({
      schema: "cognitum.metaharness.manifest.v1",
      generator: "metaharness-oss",
      template: "default",
      templateVersion: "0.0.0",
      vars: { projectName: "demo" },
      hosts: ["claude-code"],
      files: ["CLAUDE.md", ".claude/settings.json"],
      generatedAt: "2026-07-18T00:00:00Z",
      meta: { note: "generated" },
    });
  });

  it("preserves unknown additive fields verbatim under `raw` rather than dropping them", () => {
    const wire = {
      schema: "cognitum.metaharness.manifest.v1",
      generator: "metaharness-oss",
      template: "default",
      template_version: "0.0.0",
      vars: {},
      hosts: [],
      files: [],
      generated_at: "2026-07-18T00:00:00Z",
      // Additive/unknown fields a future generator version might add:
      signing_key_id: "kid-123",
      extension_block: { future: true },
    };
    const manifest = parseHarnessManifest(wire);
    expect(manifest.raw).toEqual({
      signing_key_id: "kid-123",
      extension_block: { future: true },
    });
  });

  it("accepts camelCase field spellings too", () => {
    const wire = {
      schema: "s",
      generator: "g",
      template: "t",
      templateVersion: "1.0.0",
      vars: {},
      hosts: [],
      files: [],
      generatedAt: "2026-07-18T00:00:00Z",
    };
    const manifest = parseHarnessManifest(wire);
    expect(manifest.templateVersion).toBe("1.0.0");
    expect(manifest.generatedAt).toBe("2026-07-18T00:00:00Z");
    expect(manifest.raw).toBeUndefined();
  });
});

describe("parseWitnessVerification — unknown-enum fail-closed + unknown-field preservation (ADR-0026a §D3/§D6)", () => {
  it("parses a shape-level verification and preserves it (not upgraded, not discarded)", () => {
    const wire = {
      verification: { level: "shape", valid: true, checked_at: "2026-07-18T00:00:00Z" },
      witness_schema: "metaharness.witness.v1",
      manifest_digest: "sha256:deadbeef",
      entry_digests: ["sha256:aaa", "sha256:bbb"],
    };
    const result = parseWitnessVerification(wire);
    expect(result.verification.level).toBe("shape");
    expect(result.verification.valid).toBe(true);
    expect(result.witnessSchema).toBe("metaharness.witness.v1");
    expect(result.manifestDigest).toBe("sha256:deadbeef");
    expect(result.entryDigests).toEqual(["sha256:aaa", "sha256:bbb"]);
  });

  it("`shape` level with valid=true is never silently escalated to cryptographic — no trust it didn't earn", () => {
    const wire = {
      verification: { level: "shape", valid: true, checked_at: "2026-07-18T00:00:00Z" },
    };
    const result = parseWitnessVerification(wire);
    expect(result.verification.level).toBe("shape");
    expect(result.verification.level).not.toBe("cryptographic");
    expect(result.verification.level).not.toBe("anchored");
  });

  it("fails closed on an unrecognized verification level rather than passing it through as a trust claim", () => {
    const wire = {
      verification: {
        level: "MetaHarness-ADR-011-alternate-shape",
        valid: true,
        checked_at: "2026-07-18T00:00:00Z",
      },
    };
    const result = parseWitnessVerification(wire);
    expect(result.verification.level).toBe("none");
    expect(result.verification.valid).toBe(false);
    expect(result.verification.warnings?.[0]).toMatch(/unknown verification level/i);
  });

  it("preserves unknown top-level fields verbatim under `rawUnknown`", () => {
    const wire = {
      verification: { level: "digest", valid: true, checked_at: "2026-07-18T00:00:00Z" },
      future_witness_extension: { anchor_proof: "opaque-blob" },
    };
    const result = parseWitnessVerification(wire);
    expect(result.rawUnknown).toEqual({
      future_witness_extension: { anchor_proof: "opaque-blob" },
    });
  });

  it("round-trips through a ScaffoldResult without losing the nested verification", () => {
    const result: ScaffoldResult = {
      schema: SCAFFOLD_RESULT_SCHEMA_V1,
      planDigest: "sha256:deadbeef",
      manifest: {
        schema: "cognitum.metaharness.manifest.v1",
        generator: "metaharness-oss",
        template: "default",
        templateVersion: "0.0.0",
        vars: {},
        hosts: ["claude-code"],
        files: ["CLAUDE.md"],
        generatedAt: "2026-07-18T00:00:00Z",
      },
      files: [{ path: "CLAUDE.md", contentDigest: "sha256:file1" }],
      targetAfterDigest: "sha256:after",
      unresolvedVariables: [],
      commitOutcome: "succeeded",
      verification: {
        verification: {
          level: "digest",
          valid: true,
          checkedAt: "2026-07-18T00:00:00Z",
        },
      },
    };
    const roundTripped = JSON.parse(JSON.stringify(result)) as ScaffoldResult;
    expect(roundTripped).toEqual(result);
    expect(roundTripped.commitOutcome).toBe("succeeded");
  });
});

describe("ScaffoldPlan — round-trip with unresolved variables and warnings preserved", () => {
  it("round-trips a full plan through JSON unchanged", () => {
    const plan: ScaffoldPlan = {
      schema: SCAFFOLD_PLAN_SCHEMA_V1,
      planId: "plan_1",
      planDigest: "sha256:plandigest",
      createdAt: "2026-07-18T00:00:00Z",
      expiresAt: "2026-07-18T00:10:00Z",
      generatorIdentity: { product: "metaharness-oss", packageVersion: "0.4.1" },
      templateIdentity: { template: "default", templateVersion: "0.0.0" },
      canonicalTarget: "/tmp/target",
      targetBeforeDigest: "sha256:before",
      requestDigest: "sha256:request",
      actions: [{ kind: "create", path: "CLAUDE.md" }],
      unresolvedVariables: ["projectName"],
      warnings: ["template pins metaharness@0.1.5, a stale version"],
      destructive: false,
      estimatedFiles: 1,
      estimatedBytes: 128,
    };
    const roundTripped = JSON.parse(JSON.stringify(plan)) as ScaffoldPlan;
    expect(roundTripped).toEqual(plan);
    expect(roundTripped.unresolvedVariables).toEqual(["projectName"]);
  });
});
