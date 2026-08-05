/**
 * Tests for the §D10 diagnostic-capture policy/manifest scaffolding
 * (ADR-0028 §D10, lines 325-343).
 *
 * Covers:
 * - `previewDiagnosticManifest` computes `wouldCapture` as the
 *   intersection of allowed categories minus the hard-coded
 *   never-capturable set, for several policy combinations;
 * - the hard block wins even when a policy explicitly tries to allow
 *   `"credentials"`/`"signed-urls"` (the single most important test);
 * - `blockedByPolicy` correctly lists categories not in
 *   `allowedCategories`, distinct from the hard-blocked ones;
 * - `DiagnosticPolicy`/`DiagnosticManifest`/`DiagnosticBundle` round-trip
 *   through JSON.
 */

import { describe, it, expect } from "vitest";
import type { D12Category } from "../../src/agentic/sentinel.js";
import {
  D10_RELEVANT_CATEGORIES,
  NEVER_CAPTURABLE_CATEGORIES,
  isNeverCapturable,
  previewDiagnosticManifest,
  validateDiagnosticPolicy,
  type DiagnosticPolicy,
  type DiagnosticManifest,
  type DiagnosticBundle,
} from "../../src/agentic/diagnostics.js";

function policyWithAllowed(allowed: D12Category[]): DiagnosticPolicy {
  return {
    includedFields: ["field.example"],
    maxBytes: 1_048_576,
    maxDurationMs: 5_000,
    sink: { kind: "local_path", path: "/tmp/diagnostics" },
    encryptionRequired: true,
    accessExpectation: "operator-only",
    retention: { maxAgeMs: 86_400_000 },
    allowedCategories: new Set(allowed),
  };
}

describe("ADR-0028 §D10 diagnostic-capture policy/manifest", () => {
  it("D10_RELEVANT_CATEGORIES has exactly the six §D10 categories, no hard-blocked ones", () => {
    expect(D10_RELEVANT_CATEGORIES).toHaveLength(6);
    expect(new Set(D10_RELEVANT_CATEGORIES).size).toBe(6);
    for (const blocked of NEVER_CAPTURABLE_CATEGORIES) {
      expect(D10_RELEVANT_CATEGORIES).not.toContain(blocked);
    }
  });

  it("allowing all six relevant categories yields a full wouldCapture and empty blockedByPolicy", () => {
    const policy = policyWithAllowed([...D10_RELEVANT_CATEGORIES]);
    const manifest = previewDiagnosticManifest(policy);
    expect(manifest.wouldCapture).toHaveLength(6);
    for (const category of D10_RELEVANT_CATEGORIES) {
      expect(manifest.wouldCapture).toContain(category);
    }
    expect(manifest.blockedByPolicy).toHaveLength(0);
  });

  it("allowing only some categories splits wouldCapture and blockedByPolicy correctly", () => {
    const policy = policyWithAllowed(["prompts", "environment-values"]);
    const manifest = previewDiagnosticManifest(policy);
    expect(manifest.wouldCapture).toEqual(
      expect.arrayContaining(["prompts", "environment-values"]),
    );
    expect(manifest.wouldCapture).toHaveLength(2);
    expect(manifest.blockedByPolicy).toEqual(
      expect.arrayContaining(["messages", "source", "patches", "tool-arguments-results"]),
    );
    expect(manifest.blockedByPolicy).not.toContain("environment-values");
    expect(manifest.wouldCapture.length + manifest.blockedByPolicy.length).toBe(6);
  });

  it("empty allowedCategories blocks every §D10-relevant category", () => {
    const policy = policyWithAllowed([]);
    const manifest = previewDiagnosticManifest(policy);
    expect(manifest.wouldCapture).toHaveLength(0);
    expect(manifest.blockedByPolicy).toHaveLength(6);
  });

  it("the hard block wins even when a policy explicitly allows credentials and signed-urls", () => {
    // The single most important test in this module: a policy that tries
    // to "allow" credentials/signed-urls (plus every §D10-relevant
    // category, so the hard block is the only thing that could exclude
    // them) must never see them show up in wouldCapture. The hard block
    // is policy-independent, per ADR-0028 §D10.
    const policy = policyWithAllowed([
      ...D10_RELEVANT_CATEGORIES,
      "credentials",
      "signed-urls",
    ]);
    expect(policy.allowedCategories.has("credentials")).toBe(true);
    expect(policy.allowedCategories.has("signed-urls")).toBe(true);

    const manifest = previewDiagnosticManifest(policy);
    expect(manifest.wouldCapture).not.toContain("credentials");
    expect(manifest.wouldCapture).not.toContain("signed-urls");
    expect(manifest.blockedByPolicy).not.toContain("credentials");
    expect(manifest.blockedByPolicy).not.toContain("signed-urls");
    expect(manifest.wouldCapture).toHaveLength(6);
  });

  it("isNeverCapturable covers exactly credentials and signed-urls", () => {
    expect(isNeverCapturable("credentials")).toBe(true);
    expect(isNeverCapturable("signed-urls")).toBe(true);
    for (const category of D10_RELEVANT_CATEGORIES) {
      expect(isNeverCapturable(category)).toBe(false);
    }
    expect(isNeverCapturable("webhook-bodies")).toBe(false);
    expect(isNeverCapturable("repository-urls")).toBe(false);
    expect(isNeverCapturable("raw-tenant-user-identifiers")).toBe(false);
  });

  it("DiagnosticPolicy round-trips through JSON (Set serialized via Array.from at the call site)", () => {
    const policy = policyWithAllowed(["prompts", "source"]);
    const serializable = {
      ...policy,
      allowedCategories: Array.from(policy.allowedCategories),
    };
    const json = JSON.parse(JSON.stringify(serializable));
    expect(json.includedFields).toEqual(["field.example"]);
    expect(json.maxBytes).toBe(1_048_576);
    expect(json.sink).toEqual({ kind: "local_path", path: "/tmp/diagnostics" });
    expect(json.encryptionRequired).toBe(true);
    expect(json.retention).toEqual({ maxAgeMs: 86_400_000 });
    expect(new Set(json.allowedCategories)).toEqual(new Set(["prompts", "source"]));

    const roundTripped: DiagnosticPolicy = {
      ...json,
      allowedCategories: new Set(json.allowedCategories as D12Category[]),
    };
    expect(roundTripped.maxBytes).toBe(1_048_576);
    expect(roundTripped.allowedCategories.has("prompts")).toBe(true);
  });

  it("DiagnosticSink callback variant serializes without a path", () => {
    const sink = { kind: "callback" as const };
    const json = JSON.parse(JSON.stringify(sink));
    expect(json).toEqual({ kind: "callback" });
  });

  it("rejects invalid limits and sink/field values before capture", () => {
    expect(() => validateDiagnosticPolicy(policyWithAllowed([]))).not.toThrow();
    expect(() => validateDiagnosticPolicy({
      ...policyWithAllowed([]), maxBytes: 0,
    })).toThrow(/maxBytes/);
    expect(() => validateDiagnosticPolicy({
      ...policyWithAllowed([]), maxDurationMs: Number.NaN,
    })).toThrow(/maxDurationMs/);
    expect(() => validateDiagnosticPolicy({
      ...policyWithAllowed([]), includedFields: [""],
    })).toThrow(/includedFields/);
    expect(() => validateDiagnosticPolicy({
      ...policyWithAllowed([]), sink: { kind: "local_path", path: "  " },
    })).toThrow(/sink.path/);
  });

  it("DiagnosticManifest round-trips through JSON", () => {
    const manifest: DiagnosticManifest = {
      wouldCapture: ["prompts"],
      blockedByPolicy: ["source"],
    };
    const json = JSON.parse(JSON.stringify(manifest));
    expect(json).toEqual({ wouldCapture: ["prompts"], blockedByPolicy: ["source"] });
  });

  it("DiagnosticBundle round-trips through JSON", () => {
    const bundle: DiagnosticBundle = {
      redactionReport: {
        redactionCount: 3,
        categoriesRedacted: ["credentials", "prompts"],
      },
      sdkVersion: "0.1.0",
      contractVersion: "1.0",
      sha256Digest: "a".repeat(64),
    };
    const json = JSON.parse(JSON.stringify(bundle));
    expect(json.redactionReport.redactionCount).toBe(3);
    expect(json.sdkVersion).toBe("0.1.0");
    expect(json).toEqual(bundle);
  });
});
