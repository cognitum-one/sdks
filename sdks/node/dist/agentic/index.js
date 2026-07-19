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
var ConsentRequiredError = class extends AgenticError {
  requiredKind;
  constructor(product, operation, requiredKind, message) {
    super(
      "consent_required",
      message ?? `operation "${operation}" on ${product} requires an unexpired ADR-0022 consent grant of kind "${requiredKind}" \u2014 credential presence alone is not consent`,
      { product, operation, retryable: false }
    );
    this.name = "ConsentRequiredError";
    this.requiredKind = requiredKind;
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
var DEFAULT_RETRY_POLICY = {
  baseMs: 500,
  capMs: 3e4,
  maxAttempts: 4,
  retrySleepBudgetMs: 6e4
};
function equalJitterDelayMs(attempt, policy = DEFAULT_RETRY_POLICY, serverHintMs = 0, jitterMs = 0) {
  const expo = policy.baseMs * 2 ** attempt;
  const clampedJitter = Math.min(Math.max(jitterMs, 0), policy.baseMs);
  const computed = expo + clampedJitter;
  const floor = Math.max(serverHintMs, computed);
  return Math.min(policy.capMs, floor);
}

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
import { createHash } from "crypto";
var DEFAULT_API_KEY_ENV_VAR = "COGNITUM_API_KEY";
function resolveKey(options) {
  if (options.apiKey && options.apiKey.length > 0) {
    return options.apiKey;
  }
  const envVar = options.envVar ?? DEFAULT_API_KEY_ENV_VAR;
  const env = options.env ?? (typeof process !== "undefined" ? process.env : {});
  const fromEnv = env[envVar];
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  throw new AgenticError(
    "configuration",
    `apiKey is required \u2014 pass apiKey or set ${envVar}`,
    { product: options.product }
  );
}
function fingerprintOf(product, key) {
  return createHash("sha256").update(`${product}:${key}`).digest("hex").slice(0, 16);
}
var StaticApiKeyCredentialProvider = class {
  #secret;
  #product;
  #normalizedOrigin;
  #audience;
  #scheme;
  #fingerprint;
  #invalidated = false;
  constructor(options) {
    const key = resolveKey(options);
    this.#secret = new RedactedSecret(key);
    this.#product = options.product;
    this.#normalizedOrigin = options.normalizedOrigin;
    this.#audience = options.audience;
    this.#scheme = options.scheme ?? "X-API-Key";
    this.#fingerprint = fingerprintOf(options.product, key);
  }
  /** Non-secret stable provider identity, safe to log. */
  identity() {
    return `static-api-key:${this.#product}:${this.#fingerprint}`;
  }
  async describeAuthority(request) {
    this.assertMatch(request);
    return this.authority();
  }
  async acquire(request) {
    this.assertMatch(request);
    if (this.#invalidated) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} has been invalidated`,
        { product: this.#product }
      );
    }
    return {
      scheme: this.#scheme,
      secret: this.#secret,
      audience: this.#audience,
      source: this.identity(),
      authority: this.authority()
    };
  }
  async invalidate(_reason) {
    this.#invalidated = true;
  }
  authority() {
    return {
      providerFingerprint: this.#fingerprint,
      product: this.#product,
      normalizedOrigin: this.#normalizedOrigin,
      audience: this.#audience
    };
  }
  /**
   * Fail-closed match check (ADR-0022 §D1/§D3). Exact string equality only
   * — no wildcard origin, suffix matching, or DNS-parent trust.
   */
  assertMatch(request) {
    if (request.product !== this.#product) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} is bound to product "${this.#product}", refusing request for product "${request.product}"`,
        { product: this.#product, operation: request.operation }
      );
    }
    if (request.normalizedOrigin !== this.#normalizedOrigin) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} is bound to origin "${this.#normalizedOrigin}", refusing request for origin "${request.normalizedOrigin}" (ADR-0022 \xA7D3: a redirect to another origin is not followed with credentials)`,
        { product: this.#product, operation: request.operation }
      );
    }
    if (request.audience !== this.#audience) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} is bound to audience "${this.#audience}", refusing request for audience "${request.audience}"`,
        { product: this.#product, operation: request.operation }
      );
    }
  }
};

// src/agentic/sentinel.ts
var MAX_DEPTH = 8;
var ENTROPY_THRESHOLD_BITS_PER_CHAR = 4;
var ENTROPY_THRESHOLD_HEX_BITS_PER_CHAR = 3;
var ENTROPY_MIN_TOKEN_LEN = 20;
var MAX_DEPTH_MARKER = "[max-depth-exceeded]";
var CYCLIC_MARKER = "[cyclic-reference]";
var KEY_NAME_RULES = [
  {
    category: "credentials",
    classification: "secret",
    keys: /^(credential|credentials|apikey|clientsecret|secret|token|password|accesskey|authorization)$/
  },
  {
    category: "environment-values",
    classification: "secret",
    keys: /^(env|environment|envvars|environmentvalues|environmentvariables)$/
  },
  {
    category: "signed-urls",
    classification: "secret",
    keys: /^(signedurl|presignedurl|signedurls)$/
  },
  {
    category: "webhook-bodies",
    classification: "sensitive",
    keys: /^(webhookbody|webhookpayload|webhookbodies)$/
  },
  {
    category: "raw-tenant-user-identifiers",
    classification: "sensitive",
    keys: /^(userid|tenantid|rawuserid|rawtenantid|accountid)$/
  },
  {
    category: "prompts",
    classification: "sensitive",
    keys: /^(prompt|prompts|systemprompt)$/
  },
  {
    category: "messages",
    classification: "sensitive",
    keys: /^(message|messages|chatmessages)$/
  },
  {
    category: "tool-arguments-results",
    classification: "sensitive",
    keys: /^(toolarguments|toolresults|toolargs|tooloutput)$/
  },
  {
    category: "source",
    classification: "sensitive",
    keys: /^(source|sourcecode|sourcefiles)$/
  },
  {
    category: "repository-urls",
    classification: "sensitive",
    keys: /^(repositoryurl|repourl|repositoryurls)$/
  },
  {
    category: "patches",
    classification: "sensitive",
    keys: /^(patch|patches|diff)$/
  }
];
function normalizeFieldName(fieldName) {
  return fieldName.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function keyNameRule(fieldName) {
  if (!fieldName) return void 0;
  const normalized = normalizeFieldName(fieldName);
  return KEY_NAME_RULES.find((rule) => rule.keys.test(normalized));
}
var BEARER_TOKEN_RE = /^bearer\s+[a-z0-9._~+/-]{16,}=*$/i;
var JWT_RE = /^[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}$/i;
var PEM_PRIVATE_KEY_RE = /-----BEGIN[ A-Z0-9]*PRIVATE KEY-----/;
var CLOUD_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b/;
var PRESIGNED_URL_PARAM_RE = /[?&](?:X-Amz-Signature|X-Amz-Credential|Signature)=/i;
var AZURE_SAS_SE_RE = /[?&]se=/i;
var AZURE_SAS_SIG_RE = /[?&]sig=/i;
function matchesFixedFormat(value) {
  return BEARER_TOKEN_RE.test(value) || JWT_RE.test(value) || PEM_PRIVATE_KEY_RE.test(value) || CLOUD_ACCESS_KEY_RE.test(value) || PRESIGNED_URL_PARAM_RE.test(value) || AZURE_SAS_SE_RE.test(value) && AZURE_SAS_SIG_RE.test(value);
}
function shannonEntropy(token) {
  const counts = /* @__PURE__ */ new Map();
  for (const ch of token) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  const n = token.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / n;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
var TOKEN_RE = /[A-Za-z0-9+/=_.~-]+/g;
var HEX_CHARSET_RE = /^[0-9a-fA-F]+$/;
function entropyThresholdFor(token) {
  return HEX_CHARSET_RE.test(token) ? ENTROPY_THRESHOLD_HEX_BITS_PER_CHAR : ENTROPY_THRESHOLD_BITS_PER_CHAR;
}
function matchesEntropyFallback(value) {
  const tokens = value.match(TOKEN_RE) ?? [];
  for (const token of tokens) {
    if (token.length >= ENTROPY_MIN_TOKEN_LEN && shannonEntropy(token) >= entropyThresholdFor(token)) {
      return true;
    }
  }
  return false;
}
function classifyLeaf(fieldName, value) {
  const rule = keyNameRule(fieldName);
  if (rule) return rule.category;
  if (matchesFixedFormat(value)) return "secret-pattern";
  if (matchesEntropyFallback(value)) return "high-entropy";
  return void 0;
}
var SentinelSecretRedactor = class {
  classify(fieldName, value) {
    const rule = keyNameRule(fieldName);
    if (rule) return rule.classification;
    if (typeof value === "string") {
      if (matchesFixedFormat(value)) return "secret";
      if (matchesEntropyFallback(value)) return "secret";
    }
    return "public";
  }
  redact(value) {
    return this.#walk(value, void 0, 0, /* @__PURE__ */ new Set());
  }
  #walk(value, fieldName, depth, ancestors) {
    if (depth > MAX_DEPTH) {
      return MAX_DEPTH_MARKER;
    }
    if (value === null || value === void 0) {
      return value;
    }
    if (typeof value === "string") {
      const category = classifyLeaf(fieldName, value);
      return category ? `[redacted:${category}]` : value;
    }
    if (typeof value !== "object") {
      return value;
    }
    const obj = value;
    if (ancestors.has(obj)) {
      return CYCLIC_MARKER;
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(obj);
    if (Array.isArray(value)) {
      return value.map((item) => this.#walk(item, fieldName, depth + 1, nextAncestors));
    }
    if (value instanceof Map) {
      const result2 = /* @__PURE__ */ new Map();
      for (const [key, val] of value.entries()) {
        const keyName = typeof key === "string" ? key : void 0;
        result2.set(key, this.#walk(val, keyName, depth + 1, nextAncestors));
      }
      return result2;
    }
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = this.#walk(val, key, depth + 1, nextAncestors);
    }
    return result;
  }
};

// src/agentic/receipt-verification.ts
import { createHash as createHash2, createHmac, timingSafeEqual } from "crypto";
var CANONICALIZATION_VERSION = "cognitum-canonical-json-v1";
var LEVEL_ORDER = [
  "none",
  "shape",
  "digest",
  "cryptographic",
  "anchored"
];
var COST_FINALITIES = /* @__PURE__ */ new Set([
  "estimate",
  "reserved",
  "committed",
  "provider_reported",
  "invoiced"
]);
function levelIndex(level) {
  return LEVEL_ORDER.indexOf(level);
}
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}
function canonicalJson(value) {
  return JSON.stringify(sortKeysDeep(value));
}
function sha256Hex(bytes) {
  return createHash2("sha256").update(bytes, "utf8").digest("hex");
}
function hmacSha256Hex(key, bytes) {
  return createHmac("sha256", Buffer.from(key)).update(bytes, "utf8").digest("hex");
}
function constantTimeHexEqual(a, b) {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
function receiptSignablePayload(r) {
  const { signature: _signature, verification: _verification, ...rest } = r;
  return rest;
}
function lineageSignablePayload(l) {
  const { signature: _signature, verification: _verification, ...rest } = l;
  return rest;
}
function buildExecutionReceipt(input) {
  const checkedAt = input.now ? input.now() : (/* @__PURE__ */ new Date()).toISOString();
  const base = {
    schema: "cognitum.execution-receipt.v1",
    receiptId: input.receiptId,
    product: input.product,
    contractVersion: input.contractVersion,
    subject: {
      requestId: input.requestId,
      operationId: input.operationId,
      tenantHash: input.tenantHash
    },
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    usage: input.usage,
    costs: input.costs ?? [],
    outcome: input.outcome,
    artifactDigests: input.artifactDigests,
    lineageRoot: input.lineageRoot,
    canonicalization: CANONICALIZATION_VERSION,
    issuer: input.issuer,
    keyId: input.keyId
  };
  const signature = input.sign ? input.sign(canonicalJson(base)) : void 0;
  const receipt = {
    ...base,
    signature,
    verification: { level: "none", valid: false, checkedAt }
  };
  const shapeFailure = shapeCheckExecutionReceipt(receipt);
  receipt.verification = shapeFailure ? { level: "none", valid: false, checkedAt, failure: shapeFailure } : { level: "shape", valid: true, checkedAt };
  return receipt;
}
function shapeCheckExecutionReceipt(r) {
  if (r.schema !== "cognitum.execution-receipt.v1") return "unexpected schema tag";
  if (!r.receiptId) return "receiptId is required";
  if (!r.product) return "product is required";
  if (!r.contractVersion) return "contractVersion is required";
  if (!r.subject?.requestId) return "subject.requestId is required";
  if (!r.startedAt || Number.isNaN(Date.parse(r.startedAt))) {
    return "startedAt must be a parseable timestamp";
  }
  if (r.completedAt) {
    const completed = Date.parse(r.completedAt);
    if (Number.isNaN(completed)) return "completedAt must be a parseable timestamp";
    if (completed < Date.parse(r.startedAt)) return "completedAt precedes startedAt";
  }
  if (!r.outcome) return "outcome is required";
  for (const cost of r.costs ?? []) {
    if (!cost.source) return "cost.source is required";
    if (!Number.isFinite(cost.amount)) return "cost.amount must be a finite number";
    if (!cost.currency) return "cost.currency is required";
    if (!COST_FINALITIES.has(cost.finality)) return `unknown cost.finality: ${cost.finality}`;
  }
  return void 0;
}
function shapeCheckLineageReference(l) {
  if (l.schema !== "cognitum.lineage-reference.v1") return "unexpected schema tag";
  if (!l.subject?.requestId) return "subject.requestId is required";
  if (l.sequence !== void 0 && (!Number.isInteger(l.sequence) || l.sequence < 0)) {
    return "sequence must be a non-negative integer";
  }
  return void 0;
}
function verifyExecutionReceipt(receipt, opts) {
  const checkedAt = opts.now ? opts.now() : (/* @__PURE__ */ new Date()).toISOString();
  const warnings = [];
  const shapeFailure = shapeCheckExecutionReceipt(receipt);
  if (shapeFailure) {
    return { level: "none", valid: false, checkedAt, failure: shapeFailure };
  }
  let achieved = "shape";
  const canonicalBytes = canonicalJson(receiptSignablePayload(receipt));
  const subjectDigest = sha256Hex(canonicalBytes);
  let algorithm;
  if (opts.expectedDigest) {
    if (opts.expectedDigest === subjectDigest) {
      achieved = "digest";
    } else {
      warnings.push("expected digest mismatch");
    }
  }
  if (receipt.signature && receipt.issuer && receipt.keyId) {
    if (!opts.resolveKey) {
      warnings.push("no key resolver supplied; cannot verify signature");
    } else {
      const key = opts.resolveKey(receipt.issuer, receipt.keyId);
      if (!key) {
        warnings.push(`unknown key '${receipt.keyId}' for issuer '${receipt.issuer}'`);
      } else {
        const expectedSig = hmacSha256Hex(key, canonicalBytes);
        if (constantTimeHexEqual(expectedSig, receipt.signature)) {
          achieved = "cryptographic";
          algorithm = "hmac-sha256";
        } else {
          const failure = "signature does not match canonical bytes";
          return { level: "none", valid: false, checkedAt, subjectDigest, failure };
        }
      }
    }
  } else if (levelIndex(opts.minLevel) >= levelIndex("cryptographic")) {
    warnings.push("receipt carries no signature/issuer/keyId claim");
  }
  if (achieved === "cryptographic" && receipt.lineageRoot && opts.checkAnchor) {
    if (opts.checkAnchor(receipt.lineageRoot)) {
      achieved = "anchored";
    } else {
      warnings.push("anchor check did not confirm durable checkpoint");
    }
  }
  const valid = levelIndex(achieved) >= levelIndex(opts.minLevel);
  return {
    level: achieved,
    valid,
    algorithm,
    keyId: receipt.keyId,
    checkedAt,
    subjectDigest,
    warnings: warnings.length ? warnings : void 0,
    failure: valid ? void 0 : `minimum level '${opts.minLevel}' not reached (achieved '${achieved}')`
  };
}
function verifyLineageChain(chain, opts) {
  const checkedAt = opts.now ? opts.now() : (/* @__PURE__ */ new Date()).toISOString();
  const results = [];
  if (chain.length === 0) {
    return { valid: false, level: "none", results, failure: "lineage chain is empty" };
  }
  const seenRoots = /* @__PURE__ */ new Set();
  let minAchieved = "anchored";
  let genesisAchieved;
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    const shapeFailure = shapeCheckLineageReference(entry);
    if (shapeFailure) {
      results.push({ level: "none", valid: false, checkedAt, failure: shapeFailure });
      return { valid: false, level: "none", brokenAtIndex: i, results, failure: shapeFailure };
    }
    if (entry.root) {
      if (seenRoots.has(entry.root)) {
        const failure = `cycle detected at index ${i} (root already seen)`;
        results.push({ level: "none", valid: false, checkedAt, failure });
        return { valid: false, level: "none", brokenAtIndex: i, results, failure };
      }
      seenRoots.add(entry.root);
    }
    let achieved = "shape";
    const warnings = [];
    if (i > 0) {
      const prev = chain[i - 1];
      if (!entry.previousCheckpoint || entry.previousCheckpoint !== prev.root) {
        const failure = `entry ${i} previousCheckpoint does not resolve to entry ${i - 1} root`;
        results.push({ level: "none", valid: false, checkedAt, failure });
        return { valid: false, level: "none", brokenAtIndex: i, results, failure };
      }
      if (entry.sequence !== void 0 && prev.sequence !== void 0 && entry.sequence <= prev.sequence) {
        const failure = `entry ${i} sequence (${entry.sequence}) is not strictly increasing`;
        results.push({ level: "none", valid: false, checkedAt, failure });
        return { valid: false, level: "none", brokenAtIndex: i, results, failure };
      }
      achieved = "digest";
    }
    if (entry.checkpointTime) {
      const ts = Date.parse(entry.checkpointTime);
      if (Number.isNaN(ts)) {
        warnings.push("checkpointTime not parseable");
      } else if (opts.maxCheckpointAgeMs !== void 0 && Date.now() - ts > opts.maxCheckpointAgeMs) {
        warnings.push("checkpoint is stale");
      }
    }
    if (entry.signature && entry.issuer && entry.keyId) {
      if (!opts.resolveKey) {
        warnings.push("no key resolver supplied; cannot verify signature");
      } else {
        const key = opts.resolveKey(entry.issuer, entry.keyId);
        if (!key) {
          warnings.push(`unknown key '${entry.keyId}'`);
        } else {
          const payload = canonicalJson(lineageSignablePayload(entry));
          const expected = hmacSha256Hex(key, payload);
          if (constantTimeHexEqual(expected, entry.signature)) {
            achieved = "cryptographic";
          } else {
            const failure = `entry ${i} signature does not match canonical bytes`;
            results.push({ level: "none", valid: false, checkedAt, failure });
            return { valid: false, level: "none", brokenAtIndex: i, results, failure };
          }
        }
      }
    }
    results.push({
      level: achieved,
      valid: true,
      checkedAt,
      keyId: entry.keyId,
      warnings: warnings.length ? warnings : void 0
    });
    if (i === 0) {
      genesisAchieved = achieved;
    } else if (levelIndex(achieved) < levelIndex(minAchieved)) {
      minAchieved = achieved;
    }
  }
  if (chain.length === 1) {
    minAchieved = genesisAchieved ?? "shape";
  }
  const valid = levelIndex(minAchieved) >= levelIndex(opts.minLevel);
  return {
    valid,
    level: minAchieved,
    results,
    failure: valid ? void 0 : `minimum level '${opts.minLevel}' not reached across chain (achieved '${minAchieved}')`
  };
}
export {
  AgenticError,
  ConsentRequiredError,
  DEFAULT_API_KEY_ENV_VAR,
  DEFAULT_RETRY_POLICY,
  RedactedSecret,
  SentinelSecretRedactor,
  StaticApiKeyCredentialProvider,
  UnsupportedCapabilityError,
  UnsupportedRuntimeError,
  buildExecutionReceipt,
  canonicalJson,
  equalJitterDelayMs,
  sha256Hex,
  shapeCheckExecutionReceipt,
  shapeCheckLineageReference,
  verifyExecutionReceipt,
  verifyLineageChain
};
//# sourceMappingURL=index.js.map