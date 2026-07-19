"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/metaharness/index.ts
var metaharness_exports = {};
__export(metaharness_exports, {
  DEFAULT_HANDSHAKE_TIMEOUT_MS: () => DEFAULT_HANDSHAKE_TIMEOUT_MS,
  MetaHarnessClient: () => MetaHarnessClient,
  SCAFFOLD_PLAN_SCHEMA_V1: () => SCAFFOLD_PLAN_SCHEMA_V1,
  SCAFFOLD_REQUEST_SCHEMA_V1: () => SCAFFOLD_REQUEST_SCHEMA_V1,
  SCAFFOLD_RESULT_SCHEMA_V1: () => SCAFFOLD_RESULT_SCHEMA_V1,
  assertNodeRuntime: () => assertNodeRuntime,
  isBrowserLikeRuntime: () => isBrowserLikeRuntime,
  parseHarnessManifest: () => parseHarnessManifest,
  parseWitnessVerification: () => parseWitnessVerification,
  resolveMetaHarnessClientConfig: () => resolveMetaHarnessClientConfig
});
module.exports = __toCommonJS(metaharness_exports);

// src/metaharness/config.ts
var DEFAULT_HANDSHAKE_TIMEOUT_MS = 2e3;
function resolveMetaHarnessClientConfig(config = {}) {
  if (config.handshakeTimeoutMs !== void 0 && config.handshakeTimeoutMs <= 0) {
    throw new TypeError("MetaHarnessConfig.handshakeTimeoutMs must be a positive number");
  }
  if (config.acquisitionTimeoutMs !== void 0 && config.acquisitionTimeoutMs <= 0) {
    throw new TypeError("MetaHarnessConfig.acquisitionTimeoutMs must be a positive number");
  }
  if (config.operationTimeoutMs !== void 0 && config.operationTimeoutMs <= 0) {
    throw new TypeError("MetaHarnessConfig.operationTimeoutMs must be a positive number");
  }
  return {
    ...config,
    handshakeTimeoutMs: config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    previewFeatures: config.previewFeatures ? [...config.previewFeatures] : []
  };
}

// src/agentic/errors.ts
var AgenticError = class extends Error {
  kind;
  product;
  operation;
  status;
  code;
  requestId;
  correlationId;
  protocolVersion;
  retryable;
  retryAfterMs;
  attemptCount;
  details;
  constructor(kind, message, fields) {
    super(message, { cause: fields?.cause });
    this.name = "AgenticError";
    this.kind = kind;
    this.product = fields?.product;
    this.operation = fields?.operation;
    this.status = fields?.status;
    this.code = fields?.code;
    this.requestId = fields?.requestId;
    this.correlationId = fields?.correlationId;
    this.protocolVersion = fields?.protocolVersion;
    this.retryable = fields?.retryable ?? false;
    this.retryAfterMs = fields?.retryAfterMs;
    this.attemptCount = fields?.attemptCount;
    this.details = fields?.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
var UnsupportedCapabilityError = class extends AgenticError {
  capability;
  constructor(product, operation, capability, message) {
    super(
      "unsupported_capability",
      message ?? `capability "${capability}" is unsupported or unknown for ${product}/${operation}`,
      { product, operation, retryable: false }
    );
    this.name = "UnsupportedCapabilityError";
    this.capability = capability;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
var UnsupportedRuntimeError = class extends AgenticError {
  runtime;
  constructor(product, operation, runtime, message) {
    super(
      "configuration",
      message ?? `${product} does not support the "${runtime}" runtime (ADR-0029 \xA7D2) \u2014 construction refused before reading a credential or opening a socket`,
      { product, operation, retryable: false }
    );
    this.name = "UnsupportedRuntimeError";
    this.runtime = runtime;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};

// src/agentic/credentials.ts
var REDACT_INSPECT = /* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom");
var RedactedSecret = class {
  #value;
  constructor(value) {
    this.#value = value;
  }
  /** Explicit, auditable access to the underlying secret. */
  reveal() {
    return this.#value;
  }
  toString() {
    return "[REDACTED]";
  }
  toJSON() {
    return "[REDACTED]";
  }
  [REDACT_INSPECT]() {
    return "RedactedSecret([REDACTED])";
  }
};

// src/agentic/static-api-key-provider.ts
var import_node_crypto = require("crypto");

// src/agentic/receipt-verification.ts
var import_node_crypto2 = require("crypto");

// src/metaharness/browser-guard.ts
var PRODUCT = "metaharness";
function isBrowserLikeRuntime() {
  const g = globalThis;
  if (typeof g.window !== "undefined") return true;
  if (typeof g.document !== "undefined") return true;
  const proc = g.process;
  if (typeof proc === "undefined") return true;
  if (typeof proc.versions === "undefined") return true;
  if (typeof proc.versions.node === "undefined") return true;
  return false;
}
function assertNodeRuntime(operation) {
  if (!isBrowserLikeRuntime()) return;
  throw new UnsupportedRuntimeError(
    PRODUCT,
    operation,
    "browser",
    `MetaHarnessClient cannot be constructed in a browser-like runtime (ADR-0026a \xA7D1, ADR-0029 \xA7D2): its local child-process bridge and workspace filesystem access are not a browser contract. Construction is refused before any npm access, process spawn, repository read, filesystem write, capability probe, login, or prompt.`
  );
}

// src/metaharness/types.ts
var SCAFFOLD_REQUEST_SCHEMA_V1 = "cognitum.metaharness.scaffold-request.v1";
var SCAFFOLD_PLAN_SCHEMA_V1 = "cognitum.metaharness.scaffold-plan.v1";
var SCAFFOLD_RESULT_SCHEMA_V1 = "cognitum.metaharness.scaffold-result.v1";
var KNOWN_VERIFICATION_LEVELS = /* @__PURE__ */ new Set([
  "none",
  "shape",
  "digest",
  "cryptographic",
  "anchored"
]);
var KNOWN_MANIFEST_KEYS = /* @__PURE__ */ new Set([
  "schema",
  "generator",
  "template",
  "template_version",
  "templateVersion",
  "vars",
  "hosts",
  "files",
  "generated_at",
  "generatedAt",
  "meta"
]);
function pick(data, snake, camel) {
  return data[snake] ?? data[camel];
}
function parseHarnessManifest(data) {
  const raw = {};
  for (const [key, value] of Object.entries(data)) {
    if (!KNOWN_MANIFEST_KEYS.has(key)) raw[key] = value;
  }
  return {
    schema: String(data.schema ?? ""),
    generator: String(data.generator ?? ""),
    template: String(data.template ?? ""),
    templateVersion: String(pick(data, "template_version", "templateVersion") ?? ""),
    vars: data.vars ?? {},
    hosts: data.hosts ?? [],
    files: data.files ?? [],
    generatedAt: String(pick(data, "generated_at", "generatedAt") ?? ""),
    meta: data.meta,
    ...Object.keys(raw).length > 0 ? { raw } : {}
  };
}
function parseWitnessVerification(data) {
  const verificationRaw = data.verification ?? {};
  const reportedLevel = verificationRaw.level;
  const levelKnown = typeof reportedLevel === "string" && KNOWN_VERIFICATION_LEVELS.has(reportedLevel);
  const level = levelKnown ? reportedLevel : "none";
  const warnings = Array.isArray(verificationRaw.warnings) ? [...verificationRaw.warnings] : void 0;
  const verification = {
    level,
    valid: levelKnown ? Boolean(verificationRaw.valid) : false,
    algorithm: verificationRaw.algorithm,
    keyId: pick(verificationRaw, "key_id", "keyId"),
    checkedAt: String(pick(verificationRaw, "checked_at", "checkedAt") ?? ""),
    subjectDigest: pick(verificationRaw, "subject_digest", "subjectDigest"),
    warnings: levelKnown ? warnings : [
      ...warnings ?? [],
      `unknown verification level "${String(reportedLevel)}" fails closed to "none" (ADR-0026a \xA7D3/\xA7D6)`
    ],
    failure: verificationRaw.failure
  };
  const KNOWN_TOP_KEYS = /* @__PURE__ */ new Set([
    "verification",
    "witness_schema",
    "witnessSchema",
    "manifest_digest",
    "manifestDigest",
    "entry_digests",
    "entryDigests"
  ]);
  const rawUnknown = {};
  for (const [key, value] of Object.entries(data)) {
    if (!KNOWN_TOP_KEYS.has(key)) rawUnknown[key] = value;
  }
  return {
    verification,
    witnessSchema: pick(data, "witness_schema", "witnessSchema"),
    manifestDigest: pick(data, "manifest_digest", "manifestDigest"),
    entryDigests: pick(data, "entry_digests", "entryDigests"),
    ...Object.keys(rawUnknown).length > 0 ? { rawUnknown } : {}
  };
}

// src/metaharness/client.ts
var PRODUCT2 = "metaharness";
var BLOCKED = {
  capabilities: {
    capability: "metaharness.bridge.hello",
    blockers: 'blockers #1 ("reviewed 0.4.1 is not published at the registry state") and #2 ("no versioned JSONL bridge covers the SDK operations") \u2014 there is no `hello` handshake to answer this call, so even capability discovery itself is blocked'
  },
  listTemplates: {
    capability: "metaharness.catalog.templates",
    blockers: 'blocker #2 ("no versioned JSONL bridge covers the SDK operations")'
  },
  listHosts: {
    capability: "metaharness.catalog.hosts",
    blockers: 'blocker #2 ("no versioned JSONL bridge covers the SDK operations")'
  },
  analyzeRepository: {
    capability: "metaharness.repository.analyze",
    blockers: 'blockers #1 ("reviewed 0.4.1 is not published at the registry state") and #2 ("no versioned JSONL bridge covers the SDK operations")'
  },
  scoreRepository: {
    capability: "metaharness.repository.score",
    blockers: 'blockers #1 ("reviewed 0.4.1 is not published at the registry state") and #2 ("no versioned JSONL bridge covers the SDK operations")'
  },
  planScaffold: {
    capability: "metaharness.scaffold.plan",
    blockers: 'blocker #2 ("no versioned JSONL bridge covers the SDK operations") and #3 ("package/generator/template versions disagree and output/cancel is nonuniform")'
  },
  scaffold: {
    capability: "metaharness.scaffold.render",
    blockers: 'blocker #2 ("no versioned JSONL bridge covers the SDK operations") and #4 ("`from-repo` is mutable and unresolved variables do not fail by default") \u2014 plus ADR-0026b\'s integrity/commit-mode/recovery gates, none of which exist yet'
  },
  inspectManifest: {
    capability: "metaharness.manifest.inspect",
    blockers: 'blockers #2 ("no versioned JSONL bridge covers the SDK operations") and #3 ("package/generator/template versions disagree")'
  },
  validateHarness: {
    capability: "metaharness.harness.validate",
    blockers: 'blocker #2 ("no versioned JSONL bridge covers the SDK operations")'
  },
  compareHarnesses: {
    capability: "metaharness.harness.compare",
    blockers: 'blocker #2 ("no versioned JSONL bridge covers the SDK operations")'
  },
  verifyWitness: {
    capability: "metaharness.witness.shape",
    blockers: 'blocker #5 ("witness docs, runtime shape, verification, and publish claims disagree") \u2014 no requested verification level (shape, digest, cryptographic, or anchored) can be honored yet'
  }
};
function notYetAvailable(operation) {
  const blocked = BLOCKED[operation];
  throw new UnsupportedCapabilityError(
    PRODUCT2,
    operation,
    blocked.capability,
    `MetaHarnessClient.${operation} is not yet available: the OSS MetaHarness bridge protocol this method requires ("${blocked.capability}") does not exist upstream yet (ADR-0026a \xA7D7 \u2014 ${blocked.blockers}). This method fails closed before any process, network, or filesystem access; until all seven \xA7D7 blockers close, a released SDK may offer at most a feature-flagged, read-only development preview, which this pass does not yet ship.`
  );
}
var MetaHarnessClient = class {
  config;
  constructor(config = {}) {
    assertNodeRuntime("construct");
    this.config = resolveMetaHarnessClientConfig(config);
  }
  /** Read-only view of the effective configuration. */
  getConfig() {
    return this.config;
  }
  /**
   * Versioned behavior safe for this caller (ADR-0026a §D2). Blocked this
   * pass: there is no bridge `hello` handshake (§D4) to answer it, so even
   * capability discovery fails closed rather than guessing.
   */
  async capabilities(_options) {
    notYetAvailable("capabilities");
  }
  /** Catalog of source-defined templates (ADR-0026a §D2, Context: "20 source-defined templates"). */
  async listTemplates(_options) {
    notYetAvailable("listTemplates");
  }
  /** Catalog of source-defined hosts (ADR-0026a §D2, Context: "nine source-defined hosts"). */
  async listHosts(_options) {
    notYetAvailable("listHosts");
  }
  /** Immutable analysis of a repository (ADR-0026a §D2, §D7). */
  async analyzeRepository(_source, _options) {
    notYetAvailable("analyzeRepository");
  }
  /** Immutable scoring of a repository (ADR-0026a §D2, §D7). */
  async scoreRepository(_source, _options) {
    notYetAvailable("scoreRepository");
  }
  /**
   * Non-mutating scaffold planning (ADR-0026a §D2: "`planScaffold` is
   * non-mutating"). Still blocked — planning requires the same unpublished
   * bridge as every other operation.
   */
  async planScaffold(_request, _options) {
    notYetAvailable("planScaffold");
  }
  /**
   * Apply a still-valid `ScaffoldPlan` with matching `ApplyApproval`
   * (ADR-0026a §D2). No `force`, no plan-and-apply convenience — the ADR
   * explicitly forbids eroding the plan/apply review boundary. Blocked
   * pending ADR-0026b's commit/cancel/recovery gates in addition to the
   * bridge itself.
   */
  async scaffold(_plan, _approval, _options) {
    notYetAvailable("scaffold");
  }
  /** Inspect an existing harness manifest (ADR-0026a §D2, §D3). */
  async inspectManifest(_target, _options) {
    notYetAvailable("inspectManifest");
  }
  /** Validate an existing harness against its manifest (ADR-0026a §D2). */
  async validateHarness(_target, _options) {
    notYetAvailable("validateHarness");
  }
  /** Compare two harnesses (ADR-0026a §D2). */
  async compareHarnesses(_a, _b, _options) {
    notYetAvailable("compareHarnesses");
  }
  /**
   * Verify a witness at the requested level (ADR-0026a §D2, §D6). Blocked
   * for every level — even `shape`, the weakest, requires the bridge/kernel
   * this pass does not have (§D7 blocker #5).
   */
  async verifyWitness(_workspaceOrWitness, _options) {
    notYetAvailable("verifyWitness");
  }
  /**
   * Cancel only processes owned by this client (ADR-0026a §D2: "Closing a
   * client cancels only processes owned by that client. It does not cancel
   * a HarnessaaS job, stop Meta Proxy, or kill a separately launched
   * MetaHarness CLI."). A real no-op this pass: no bridge process is ever
   * spawned by any method above, so there is nothing to release.
   */
  async close() {
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  MetaHarnessClient,
  SCAFFOLD_PLAN_SCHEMA_V1,
  SCAFFOLD_REQUEST_SCHEMA_V1,
  SCAFFOLD_RESULT_SCHEMA_V1,
  assertNodeRuntime,
  isBrowserLikeRuntime,
  parseHarnessManifest,
  parseWitnessVerification,
  resolveMetaHarnessClientConfig
});
//# sourceMappingURL=index.cjs.map