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
export {
  AgenticError,
  DEFAULT_API_KEY_ENV_VAR,
  DEFAULT_RETRY_POLICY,
  RedactedSecret,
  StaticApiKeyCredentialProvider,
  UnsupportedCapabilityError,
  equalJitterDelayMs
};
//# sourceMappingURL=index.js.map