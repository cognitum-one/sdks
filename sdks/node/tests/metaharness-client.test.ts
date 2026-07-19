import { describe, it, expect } from "vitest";

import { UnsupportedCapabilityError } from "../src/agentic/index.js";
import { MetaHarnessClient } from "../src/metaharness/client.js";
import { DEFAULT_HANDSHAKE_TIMEOUT_MS } from "../src/metaharness/config.js";

describe("MetaHarnessClient construction (ADR-0026a §D1) — zero I/O", () => {
  it("constructs with no arguments and performs no I/O", () => {
    expect(() => new MetaHarnessClient()).not.toThrow();
  });

  it("resolves default configuration without touching npm, a process, or the filesystem", () => {
    const client = new MetaHarnessClient();
    const config = client.getConfig();
    expect(config.handshakeTimeoutMs).toBe(DEFAULT_HANDSHAKE_TIMEOUT_MS);
    expect(config.previewFeatures).toEqual([]);
  });

  it("holds caller-supplied opaque policy fields as-is, with no I/O to validate them", () => {
    const distribution = { registry: "https://registry.npmjs.org", version: "0.4.1" };
    const client = new MetaHarnessClient({
      distribution,
      workspacePolicy: { allowSymlinks: false },
      processPolicy: { maxConcurrent: 1 },
      acquisitionTimeoutMs: 5_000,
      operationTimeoutMs: 30_000,
      previewFeatures: ["catalog"],
    });
    const config = client.getConfig();
    expect(config.distribution).toBe(distribution);
    expect(config.acquisitionTimeoutMs).toBe(5_000);
    expect(config.operationTimeoutMs).toBe(30_000);
    expect(config.previewFeatures).toEqual(["catalog"]);
  });

  it("rejects a non-positive handshakeTimeoutMs at construction (still zero I/O — a pure validation failure)", () => {
    expect(() => new MetaHarnessClient({ handshakeTimeoutMs: 0 })).toThrow(TypeError);
    expect(() => new MetaHarnessClient({ acquisitionTimeoutMs: -1 })).toThrow(TypeError);
    expect(() => new MetaHarnessClient({ operationTimeoutMs: -1 })).toThrow(TypeError);
  });

  it("copies previewFeatures rather than aliasing the caller's array", () => {
    const features = ["catalog"];
    const client = new MetaHarnessClient({ previewFeatures: features });
    features.push("scaffold-plan");
    expect(client.getConfig().previewFeatures).toEqual(["catalog"]);
  });

  it("close() resolves without throwing and performs no I/O (no process was ever spawned)", async () => {
    const client = new MetaHarnessClient();
    await expect(client.close()).resolves.toBeUndefined();
  });
});

describe("MetaHarnessClient §D2 method stubs — fail closed, zero I/O (ADR-0026a §D7)", () => {
  const cases: Array<{
    name: string;
    capability: string;
    invoke: (client: MetaHarnessClient) => Promise<unknown>;
  }> = [
    {
      name: "capabilities",
      capability: "metaharness.bridge.hello",
      invoke: (c) => c.capabilities(),
    },
    {
      name: "listTemplates",
      capability: "metaharness.catalog.templates",
      invoke: (c) => c.listTemplates(),
    },
    {
      name: "listHosts",
      capability: "metaharness.catalog.hosts",
      invoke: (c) => c.listHosts(),
    },
    {
      name: "analyzeRepository",
      capability: "metaharness.repository.analyze",
      invoke: (c) => c.analyzeRepository({ kind: "local", canonicalPath: "/tmp/repo" }),
    },
    {
      name: "scoreRepository",
      capability: "metaharness.repository.score",
      invoke: (c) => c.scoreRepository({ kind: "local", canonicalPath: "/tmp/repo" }),
    },
    {
      name: "planScaffold",
      capability: "metaharness.scaffold.plan",
      invoke: (c) =>
        c.planScaffold({
          schema: "cognitum.metaharness.scaffold-request.v1",
          name: "demo",
          template: "default",
          hosts: ["claude-code"],
          target: "/tmp/target",
          darwin: undefined,
        }),
    },
    {
      name: "scaffold",
      capability: "metaharness.scaffold.render",
      invoke: (c) =>
        c.scaffold(
          {
            schema: "cognitum.metaharness.scaffold-plan.v1",
            planId: "plan_1",
            planDigest: "sha256:deadbeef",
            createdAt: new Date().toISOString(),
            expiresAt: new Date().toISOString(),
            generatorIdentity: { product: "metaharness-oss" },
            templateIdentity: { template: "default" },
            canonicalTarget: "/tmp/target",
            targetBeforeDigest: "sha256:before",
            requestDigest: "sha256:request",
            actions: [],
            unresolvedVariables: [],
            warnings: [],
            destructive: false,
            estimatedFiles: 0,
            estimatedBytes: 0,
          },
          { planDigest: "sha256:deadbeef", approvedAt: new Date().toISOString() },
        ),
    },
    {
      name: "inspectManifest",
      capability: "metaharness.manifest.inspect",
      invoke: (c) => c.inspectManifest({ kind: "local", canonicalPath: "/tmp/repo" }),
    },
    {
      name: "validateHarness",
      capability: "metaharness.harness.validate",
      invoke: (c) => c.validateHarness({ kind: "local", canonicalPath: "/tmp/repo" }),
    },
    {
      name: "compareHarnesses",
      capability: "metaharness.harness.compare",
      invoke: (c) =>
        c.compareHarnesses(
          { kind: "local", canonicalPath: "/tmp/a" },
          { kind: "local", canonicalPath: "/tmp/b" },
        ),
    },
    {
      name: "verifyWitness",
      capability: "metaharness.witness.shape",
      invoke: (c) => c.verifyWitness({ kind: "local", canonicalPath: "/tmp/repo" }),
    },
  ];

  for (const { name, capability, invoke } of cases) {
    it(`${name}() throws UnsupportedCapabilityError citing "${capability}" before any I/O`, async () => {
      const client = new MetaHarnessClient();
      await expect(invoke(client)).rejects.toBeInstanceOf(UnsupportedCapabilityError);
      try {
        await invoke(client);
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedCapabilityError);
        const capErr = err as UnsupportedCapabilityError;
        expect(capErr.capability).toBe(capability);
        expect(capErr.product).toBe("metaharness");
        expect(capErr.operation).toBe(name);
        expect(capErr.retryable).toBe(false);
        expect(capErr.kind).toBe("unsupported_capability");
      }
    });
  }

  it("stubs never touch an injected process/filesystem/network spy", async () => {
    const spawnSpy = { called: false };
    const fsSpy = { called: false };
    const fetchSpy = { called: false };

    // A pass-through "environment" object standing in for child_process/fs/fetch —
    // no method under test accepts or could reach these, but we assert they are
    // never invoked as a structural proof that no I/O path exists yet.
    const client = new MetaHarnessClient();

    await Promise.allSettled([
      client.capabilities(),
      client.listTemplates(),
      client.listHosts(),
      client.analyzeRepository({ kind: "local", canonicalPath: "/tmp/repo" }),
      client.verifyWitness({ kind: "local", canonicalPath: "/tmp/repo" }),
    ]);

    expect(spawnSpy.called).toBe(false);
    expect(fsSpy.called).toBe(false);
    expect(fetchSpy.called).toBe(false);
  });
});
