import { describe, it, expect, vi } from "vitest";

import { UnsupportedCapabilityError } from "../src/agentic/index.js";
import { MetaHarnessClient } from "../src/metaharness/client.js";
import { DEFAULT_HANDSHAKE_TIMEOUT_MS } from "../src/metaharness/config.js";

// Vitest's ESM module namespace for Node builtins is not configurable, so
// `node:child_process` must be replaced via `vi.mock` (hoisted above all
// imports) rather than `vi.spyOn` — see the "stubs never touch the real
// fetch or child_process APIs" test below for what these prove.
const { childProcessSpawnSpy, childProcessExecSpy } = vi.hoisted(() => ({
  childProcessSpawnSpy: vi.fn(() => {
    throw new Error("child_process.spawn must never be called by a blocked MetaHarness stub");
  }),
  childProcessExecSpy: vi.fn(() => {
    throw new Error("child_process.exec must never be called by a blocked MetaHarness stub");
  }),
}));

vi.mock("node:child_process", () => ({
  spawn: childProcessSpawnSpy,
  exec: childProcessExecSpy,
}));

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

  it("stubs never touch the real fetch or child_process APIs (issue #102)", async () => {
    // Unlike the removed placeholder-object version of this test, these spies
    // are wired to the actual global/module surfaces a real I/O path would
    // have to go through, mirroring Python's genuine
    // `asyncio.create_subprocess_exec` monkeypatch (test_client.py's
    // `test_stubs_never_touch_a_process_or_filesystem_spy`). Each throws if
    // called, so any accidental I/O would surface as a distinct rejection
    // reason rather than silently passing.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => {
        throw new Error("fetch must never be called by a blocked MetaHarness stub");
      });
    childProcessSpawnSpy.mockClear();
    childProcessExecSpy.mockClear();

    try {
      const client = new MetaHarnessClient();

      const results = await Promise.allSettled([
        client.capabilities(),
        client.listTemplates(),
        client.listHosts(),
        client.analyzeRepository({ kind: "local", canonicalPath: "/tmp/repo" }),
        client.verifyWitness({ kind: "local", canonicalPath: "/tmp/repo" }),
      ]);

      // Every call must reject with the real fail-closed error, not with one
      // of the spies' thrown "must never be called" errors.
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(UnsupportedCapabilityError);
        }
      }

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(childProcessSpawnSpy).not.toHaveBeenCalled();
      expect(childProcessExecSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
