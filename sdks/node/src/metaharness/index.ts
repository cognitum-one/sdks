/**
 * MetaHarness client (ADR-0026a). Product namespace per §D1:
 * `@cognitum-one/sdk/metaharness`.
 *
 * Issue #64 / M4 start: `MetaHarnessClient` construction (§D1, zero I/O +
 * browser guard) and the §D2 public method surface as fail-closed stubs
 * (every upstream capability is blocked — see `./client.js`'s module doc
 * comment for the full ADR-0026a §D7 blocker list). Domain types (§D3) are
 * pure data shapes with no bridge dependency.
 *
 * Per ADR-0019 §D4, this module depends on `../agentic/index.js` and MUST
 * NOT be imported by any other product module (`meta-llm`, `meta-proxy`,
 * `harnessaas`). It never composes those clients either (ADR-0026a §D1).
 */

export {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  resolveMetaHarnessClientConfig,
} from "./config.js";
export type {
  MetaHarnessConfig,
  MetaHarnessDiagnosticPolicy,
  MetaHarnessDistribution,
  MetaHarnessProcessPolicy,
  MetaHarnessTelemetryEvent,
  MetaHarnessTelemetryHooks,
  MetaHarnessWorkspacePolicy,
  ResolvedMetaHarnessConfig,
} from "./config.js";

export { assertNodeRuntime, isBrowserLikeRuntime } from "./browser-guard.js";

export {
  SCAFFOLD_PLAN_SCHEMA_V1,
  SCAFFOLD_REQUEST_SCHEMA_V1,
  SCAFFOLD_RESULT_SCHEMA_V1,
  parseHarnessManifest,
  parseWitnessVerification,
} from "./types.js";
export type {
  ApplyApproval,
  FileAction,
  GeneratedFile,
  GeneratorIdentity,
  GitRepository,
  HarnessComparisonResult,
  HarnessManifest,
  HarnessValidationResult,
  HostDescriptor,
  LocalRepository,
  ProcessCommitOutcome,
  ProcessRun,
  ProcessRunState,
  RepositoryAnalysis,
  RepositoryScore,
  RepositorySource,
  ScaffoldPlan,
  ScaffoldRequestV1,
  ScaffoldResult,
  TemplateDescriptor,
  TemplateIdentity,
  WitnessVerification,
} from "./types.js";

export type { MetaHarnessCallOptions } from "./client.js";
export { MetaHarnessClient } from "./client.js";
