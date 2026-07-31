/**
 * `MetaHarnessClient` (ADR-0026a). Issue #64 / M4 start.
 *
 * This pass implements exactly §D1 (construction — zero I/O, browser guard)
 * and the §D2 public method SIGNATURES, every one of which is a fail-closed
 * stub that throws {@link UnsupportedCapabilityError} BEFORE any process,
 * network, or filesystem access.
 *
 * §D7 states the reason directly: the OSS `metaharness` package has no
 * published `bridge --stdio` protocol (or any versioned machine contract)
 * this client could talk to yet. Seven concrete blockers are listed:
 *
 *   1. reviewed 0.4.1 is not published at the registry state;
 *   2. no versioned JSONL bridge covers the SDK operations;
 *   3. package/generator/template versions disagree and output/cancel is
 *      nonuniform;
 *   4. `from-repo` is mutable and unresolved variables do not fail by
 *      default;
 *   5. witness docs, runtime shape, verification, and publish claims
 *      disagree;
 *   6. wrapper result/dependency is stale and private CLI collides/
 *      process-exits;
 *   7. external-template and full-eject flags overstate implemented
 *      behavior.
 *
 * Until these close, "a released SDK may offer only a feature-flagged,
 * read-only development preview" (§D7) — which is not yet the case here:
 * every operational method fails closed, full stop. This mirrors how
 * `MetaProxyClient`'s M3-start pass (`../meta-proxy/client.js`) declared
 * ONLY `status`/`capabilities` as real methods and omitted everything else
 * — except here essentially the ENTIRE §D2 surface is blocked (even
 * `capabilities()` itself: there is no bridge `hello` handshake to answer
 * it), so every method is declared as a stub rather than omitted, per this
 * ADR's explicit instruction that the shape be visible while blocked.
 *
 * Construction mirrors `MetaProxyClient`'s conventions exactly
 * (`../meta-proxy/client.js`): a resolved config object and the same
 * telemetry-hook shape, with the browser-runtime guard
 * (`./browser-guard.js`, ported byte-for-byte from Meta Proxy's PR #96)
 * checked first, before config resolution.
 *
 * Explicitly out of scope this pass (do not attempt): any real npm package
 * acquisition/version checking (ADR-0026b), any actual child-process spawn
 * or JSON-Lines bridge communication, any real scaffold/analyze/score/
 * witness-verify logic, and the optional `MetaHarnessProxyLifecycleProvider`
 * adapter (needs ADR-0025b, not started).
 */

import { UnsupportedCapabilityError } from "../agentic/index.js";
import type { CapabilitySet } from "../agentic/index.js";
import { assertNodeRuntime } from "./browser-guard.js";
import {
  resolveMetaHarnessClientConfig,
  type MetaHarnessConfig,
  type ResolvedMetaHarnessConfig,
} from "./config.js";
import type {
  ApplyApproval,
  HarnessComparisonResult,
  HarnessManifest,
  HarnessValidationResult,
  HostDescriptor,
  ProcessRun,
  RepositoryAnalysis,
  RepositoryScore,
  RepositorySource,
  ScaffoldPlan,
  ScaffoldRequestV1,
  ScaffoldResult,
  TemplateDescriptor,
  WitnessVerification,
} from "./types.js";

const PRODUCT = "metaharness";

/** Optional per-call request context, matching the shared agentic convention. */
export interface MetaHarnessCallOptions {
  requestContext?: Record<string, unknown>;
}

/**
 * One row of the ADR-0026a §D7 capability table, cited verbatim in every
 * stub's thrown error so a caller sees exactly which upstream capability is
 * missing and why, rather than a generic "not implemented".
 */
interface BlockedOperation {
  capability: string;
  blockers: string;
}

const BLOCKED: Record<string, BlockedOperation> = {
  capabilities: {
    capability: "metaharness.bridge.hello",
    blockers:
      'blockers #1 ("reviewed 0.4.1 is not published at the registry state") and #2 ' +
      '("no versioned JSONL bridge covers the SDK operations") — there is no `hello` ' +
      "handshake to answer this call, so even capability discovery itself is blocked",
  },
  listTemplates: {
    capability: "metaharness.catalog.templates",
    blockers: 'blocker #2 ("no versioned JSONL bridge covers the SDK operations")',
  },
  listHosts: {
    capability: "metaharness.catalog.hosts",
    blockers: 'blocker #2 ("no versioned JSONL bridge covers the SDK operations")',
  },
  analyzeRepository: {
    capability: "metaharness.repository.analyze",
    blockers:
      'blockers #1 ("reviewed 0.4.1 is not published at the registry state") and #2 ' +
      '("no versioned JSONL bridge covers the SDK operations")',
  },
  scoreRepository: {
    capability: "metaharness.repository.score",
    blockers:
      'blockers #1 ("reviewed 0.4.1 is not published at the registry state") and #2 ' +
      '("no versioned JSONL bridge covers the SDK operations")',
  },
  planScaffold: {
    capability: "metaharness.scaffold.plan",
    blockers:
      'blocker #2 ("no versioned JSONL bridge covers the SDK operations") and #3 ' +
      '("package/generator/template versions disagree and output/cancel is nonuniform")',
  },
  scaffold: {
    capability: "metaharness.scaffold.render",
    blockers:
      'blocker #2 ("no versioned JSONL bridge covers the SDK operations") and #4 ' +
      '("`from-repo` is mutable and unresolved variables do not fail by default") — ' +
      "plus ADR-0026b's integrity/commit-mode/recovery gates, none of which exist yet",
  },
  inspectManifest: {
    capability: "metaharness.manifest.inspect",
    blockers:
      'blockers #2 ("no versioned JSONL bridge covers the SDK operations") and #3 ' +
      '("package/generator/template versions disagree")',
  },
  validateHarness: {
    capability: "metaharness.harness.validate",
    blockers: 'blocker #2 ("no versioned JSONL bridge covers the SDK operations")',
  },
  compareHarnesses: {
    capability: "metaharness.harness.compare",
    blockers: 'blocker #2 ("no versioned JSONL bridge covers the SDK operations")',
  },
  verifyWitness: {
    capability: "metaharness.witness.shape",
    blockers:
      'blocker #5 ("witness docs, runtime shape, verification, and publish claims ' +
      'disagree") — no requested verification level (shape, digest, cryptographic, or ' +
      "anchored) can be honored yet",
  },
};

function notYetAvailable(operation: string): never {
  const blocked = BLOCKED[operation];
  throw new UnsupportedCapabilityError(
    PRODUCT,
    operation,
    blocked.capability,
    `MetaHarnessClient.${operation} is not yet available: the OSS MetaHarness bridge ` +
      `protocol this method requires ("${blocked.capability}") does not exist upstream ` +
      `yet (ADR-0026a §D7 — ${blocked.blockers}). This method fails closed before any ` +
      `process, network, or filesystem access; until all seven §D7 blockers close, a ` +
      "released SDK may offer at most a feature-flagged, read-only development preview, " +
      "which this pass does not yet ship.",
  );
}

/**
 * Client for the OSS MetaHarness local generator/verifier, backed by a
 * versioned JSON Lines process bridge that does not exist upstream yet
 * (ADR-0026a). `MetaHarnessClient` never composes Meta LLM, Meta Proxy,
 * HarnessaaS, or the private commercial `@cognitum-one/metaharness` CLI
 * (§D1) — it is the OSS generator's bounded-context client, full stop.
 *
 * Every method is `blocked` maturity this pass (ADR-0026a §D7: "Until
 * blockers 1 through 7 close, a released SDK may offer only a feature-
 * flagged, read-only development preview"). Construction never starts,
 * installs, authenticates, probes, or reconfigures a process (§D1).
 */
export class MetaHarnessClient {
  private readonly config: ResolvedMetaHarnessConfig;

  constructor(config: MetaHarnessConfig = {}) {
    // ADR-0026a §D1 / ADR-0029 §D2: reject a browser-like runtime BEFORE
    // anything else — before config validation, before reading a
    // distribution/workspace/process policy field.
    assertNodeRuntime("construct");
    this.config = resolveMetaHarnessClientConfig(config);
  }

  /** Read-only view of the effective configuration. */
  getConfig(): ResolvedMetaHarnessConfig {
    return this.config;
  }

  /**
   * Versioned behavior safe for this caller (ADR-0026a §D2). Blocked this
   * pass: there is no bridge `hello` handshake (§D4) to answer it, so even
   * capability discovery fails closed rather than guessing.
   */
  async capabilities(_options?: MetaHarnessCallOptions): Promise<CapabilitySet> {
    notYetAvailable("capabilities");
  }

  /** Catalog of source-defined templates (ADR-0026a §D2, Context: "20 source-defined templates"). */
  async listTemplates(_options?: MetaHarnessCallOptions): Promise<TemplateDescriptor[]> {
    notYetAvailable("listTemplates");
  }

  /** Catalog of source-defined hosts (ADR-0026a §D2, Context: "nine source-defined hosts"). */
  async listHosts(_options?: MetaHarnessCallOptions): Promise<HostDescriptor[]> {
    notYetAvailable("listHosts");
  }

  /** Immutable analysis of a repository (ADR-0026a §D2, §D7). */
  async analyzeRepository(
    _source: RepositorySource,
    _options?: MetaHarnessCallOptions,
  ): Promise<ProcessRun<RepositoryAnalysis>> {
    notYetAvailable("analyzeRepository");
  }

  /** Immutable scoring of a repository (ADR-0026a §D2, §D7). */
  async scoreRepository(
    _source: RepositorySource,
    _options?: MetaHarnessCallOptions,
  ): Promise<ProcessRun<RepositoryScore>> {
    notYetAvailable("scoreRepository");
  }

  /**
   * Non-mutating scaffold planning (ADR-0026a §D2: "`planScaffold` is
   * non-mutating"). Still blocked — planning requires the same unpublished
   * bridge as every other operation.
   */
  async planScaffold(
    _request: ScaffoldRequestV1,
    _options?: MetaHarnessCallOptions,
  ): Promise<ProcessRun<ScaffoldPlan>> {
    notYetAvailable("planScaffold");
  }

  /**
   * Apply a still-valid `ScaffoldPlan` with matching `ApplyApproval`
   * (ADR-0026a §D2). No `force`, no plan-and-apply convenience — the ADR
   * explicitly forbids eroding the plan/apply review boundary. Blocked
   * pending ADR-0026b's commit/cancel/recovery gates in addition to the
   * bridge itself.
   */
  async scaffold(
    _plan: ScaffoldPlan,
    _approval: ApplyApproval,
    _options?: MetaHarnessCallOptions,
  ): Promise<ProcessRun<ScaffoldResult>> {
    notYetAvailable("scaffold");
  }

  /** Inspect an existing harness manifest (ADR-0026a §D2, §D3). */
  async inspectManifest(
    _target: RepositorySource,
    _options?: MetaHarnessCallOptions,
  ): Promise<ProcessRun<HarnessManifest>> {
    notYetAvailable("inspectManifest");
  }

  /** Validate an existing harness against its manifest (ADR-0026a §D2). */
  async validateHarness(
    _target: RepositorySource,
    _options?: MetaHarnessCallOptions,
  ): Promise<ProcessRun<HarnessValidationResult>> {
    notYetAvailable("validateHarness");
  }

  /** Compare two harnesses (ADR-0026a §D2). */
  async compareHarnesses(
    _a: RepositorySource,
    _b: RepositorySource,
    _options?: MetaHarnessCallOptions,
  ): Promise<ProcessRun<HarnessComparisonResult>> {
    notYetAvailable("compareHarnesses");
  }

  /**
   * Verify a witness at the requested level (ADR-0026a §D2, §D6). Blocked
   * for every level — even `shape`, the weakest, requires the bridge/kernel
   * this pass does not have (§D7 blocker #5).
   */
  async verifyWitness(
    _workspaceOrWitness: RepositorySource | WitnessVerification,
    _options?: MetaHarnessCallOptions,
  ): Promise<ProcessRun<WitnessVerification>> {
    notYetAvailable("verifyWitness");
  }

  /**
   * Cancel only processes owned by this client (ADR-0026a §D2: "Closing a
   * client cancels only processes owned by that client. It does not cancel
   * a HarnessaaS job, stop Meta Proxy, or kill a separately launched
   * MetaHarness CLI."). A real no-op this pass: no bridge process is ever
   * spawned by any method above, so there is nothing to release.
   */
  async close(): Promise<void> {
    // No process is ever started by this pass's stubs — nothing to cancel
    // or release. Reserved for the real bridge-process lifecycle once one
    // exists (ADR-0026a §D4, ADR-0026b).
  }
}
