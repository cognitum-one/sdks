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
export {
  AgenticError,
  DEFAULT_API_KEY_ENV_VAR,
  DEFAULT_RETRY_POLICY,
  RedactedSecret,
  SentinelSecretRedactor,
  StaticApiKeyCredentialProvider,
  UnsupportedCapabilityError,
  equalJitterDelayMs
};
//# sourceMappingURL=index.js.map