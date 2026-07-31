/**
 * Credential-provider contract and secret redaction (ADR-0022 §D1, §D10).
 * Type-only scaffolding — issue #52 / M1. No HTTP implementation ships in
 * this pass. Concrete providers land in issue #53; redaction logic in #54.
 */

/** Parameters describing the credential a caller is about to request. */
export interface CredentialRequest {
  product: string;
  normalizedOrigin: string;
  audience: string;
  requiredScopes: string[];
  operation: string;
  interactiveAllowed: boolean;
}

/** Non-secret authority descriptor used to partition capability/cache state. */
export interface CredentialAuthority {
  providerFingerprint: string;
  product: string;
  normalizedOrigin: string;
  audience: string;
  principal?: string;
  tenant?: string;
  delegatedSubtenant?: string;
  effectiveScopes?: string[];
  plan?: string;
}

const REDACT_INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * Redacting wrapper around a secret value (ADR-0022 §D1/§D10).
 *
 * Node inspection, `JSON.stringify`, error formatting, and template-literal
 * coercion MUST NOT reveal the wrapped value — only {@link reveal} does.
 */
export class RedactedSecret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** Explicit, auditable access to the underlying secret. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[REDACTED]";
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  [REDACT_INSPECT](): string {
    return "RedactedSecret([REDACTED])";
  }
}

/** A credential acquired from a {@link CredentialProvider}. */
export interface Credential {
  scheme: string;
  secret: RedactedSecret;
  expiresAt?: string;
  grantedScopes?: string[];
  audience: string;
  source: string;
  authority: CredentialAuthority;
}

/**
 * Product clients accept a credential provider, not an untyped reusable
 * header map (ADR-0022 §D1). No HTTP implementation ships in this pass —
 * concrete providers land in issue #53.
 */
export interface CredentialProvider {
  describeAuthority(request: CredentialRequest): Promise<CredentialAuthority>;
  acquire(request: CredentialRequest): Promise<Credential>;
  /** Non-secret stable provider identity, safe to log. */
  identity(): string;
  invalidate(reason: string): Promise<void>;
}

/** Coarse secret-classification tiers used to drive redaction (ADR-0022 §D10). */
export type SecretClassification = "secret" | "sensitive" | "public";

/**
 * Applies recursive, schema- and key-name-based redaction to a value before
 * it is formatted or handed to a caller telemetry hook (ADR-0022 §D10). No
 * concrete implementation ships in this pass — lands in issue #54.
 */
export interface SecretRedactor {
  classify(fieldName: string, value: unknown): SecretClassification;
  redact<T>(value: T): T;
}
