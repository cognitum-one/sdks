/**
 * HarnessaaS client (ADR-0027a). Product namespace per ADR-0019 §D2:
 * `@cognitum-one/sdk/harnessaas`.
 *
 * Issue #67/#68 / M5 start: `HarnessaaSClient` construction, wire types, and
 * real `health()` / `solve()` / `lineage()` implementations against the
 * REAL, deployed, synchronous upstream surface — see `./client.js`'s module
 * doc comment for the full scope note (ADR-0027a's proposed async job/
 * poll/SSE/approval/cancel/artifact contract is explicitly NOT implemented
 * here; neither is the webhook admin surface, the MicroLoRA flywheel API,
 * or the `/api/v1/*` IBO-console relay).
 *
 * Per ADR-0019 §D4, this module depends on `../agentic/index.js` and MUST
 * NOT be imported by any other product module (`meta-llm`, `meta-proxy`,
 * `metaharness`).
 */

export type {
  HarnessaaSClientConfig,
  HarnessaaSTelemetryEvent,
  HarnessaaSTelemetryHooks,
  HarnessaaSTransport,
  ResolvedHarnessaaSClientConfig,
} from "./config.js";
export { resolveHarnessaaSClientConfig } from "./config.js";

export type { HarnessaaSResponseMeta, HarnessaaSResult } from "./envelope.js";

export type { HarnessaaSHealth } from "./discovery.js";
export { parseHarnessaaSHealth } from "./discovery.js";

export type {
  HarnessaaSConformanceAttestation,
  HarnessaaSCostReceipt,
  HarnessaaSLineageRecord,
  HarnessaaSLineageResult,
  HarnessaaSSolveRequest,
  HarnessaaSSolveResponse,
  HarnessaaSVertical,
} from "./types.js";
export {
  parseCostReceipt,
  parseConformanceAttestation,
  parseLineageResult,
  parseSolveResponse,
  toSolveRequestWire,
} from "./types.js";

export { mapHarnessaaSHttpError } from "./http-errors.js";

export type { HarnessaaSCallOptions } from "./client.js";
export { HarnessaaSClient } from "./client.js";
