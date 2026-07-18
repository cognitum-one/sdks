/**
 * Concrete `CredentialProvider` for a static Cognitum-cloud API key
 * (ADR-0022 §D1, §D2, §D3). Issue #53 / M1 follow-up — the frozen
 * `CredentialProvider` contract from issue #52 (`./credentials.js`) gets its
 * first real implementation here.
 *
 * This wraps a caller-supplied API key (or `COGNITUM_API_KEY`, matching the
 * resolution order already used by `HttpClient.resolveApiKey` in
 * `../client.js` and codified in ADR-0003 §"Credential provisioning") and
 * hands it out only for the exact `product` / `normalizedOrigin` /
 * `audience` the provider was constructed for (ADR-0022 §D1/§D3: "The
 * provider MUST refuse an audience or origin mismatch" / "Credential
 * providers are bound to the normalized origin selected during client
 * construction. A redirect to another origin is not followed with
 * credentials."). There is no wildcard origin or suffix matching — every
 * check below is exact string equality.
 *
 * No HTTP request is made or shaped here — this type produces credentials,
 * it does not send them.
 */

import { createHash } from "node:crypto";

import {
  RedactedSecret,
  type Credential,
  type CredentialAuthority,
  type CredentialProvider,
  type CredentialRequest,
} from "./credentials.js";
import { AgenticError } from "./errors.js";

/** Canonical env var per ADR-0003 §"Credential provisioning" / `../client.js`. */
export const DEFAULT_API_KEY_ENV_VAR = "COGNITUM_API_KEY";

/** Construction-time options for {@link StaticApiKeyCredentialProvider}. */
export interface StaticApiKeyCredentialProviderOptions {
  /** Product this provider is authoritative for (e.g. "cognitum-cloud"). */
  product: string;
  /** Exact normalized origin this provider is bound to (ADR-0022 §D3). */
  normalizedOrigin: string;
  /** Exact audience this provider is bound to (ADR-0022 §D1). */
  audience: string;
  /**
   * Explicit API key. When omitted, resolved from `envVar`
   * (default {@link DEFAULT_API_KEY_ENV_VAR}) per ADR-0003's resolution
   * order: explicit arg, then environment variable, then fail at
   * construction time.
   */
  apiKey?: string;
  /** Override the environment variable name checked when `apiKey` is omitted. */
  envVar?: string;
  /**
   * Wire scheme label surfaced on the acquired {@link Credential}.
   * Defaults to `"X-API-Key"`, the canonical cloud header per ADR-0003.
   */
  scheme?: string;
  /** Injectable environment map, for testing. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

function resolveKey(
  options: StaticApiKeyCredentialProviderOptions,
): string {
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
    `apiKey is required — pass apiKey or set ${envVar}`,
    { product: options.product },
  );
}

/** Non-secret, non-reversible-in-practice fingerprint of a key value. */
function fingerprintOf(product: string, key: string): string {
  return createHash("sha256").update(`${product}:${key}`).digest("hex").slice(0, 16);
}

/**
 * Concrete `CredentialProvider` wrapping one static Cognitum-cloud API key
 * (ADR-0022 §D1/§D2/§D3). Fails closed on any product, origin, or audience
 * mismatch — see {@link StaticApiKeyCredentialProvider#assertMatch}.
 */
export class StaticApiKeyCredentialProvider implements CredentialProvider {
  readonly #secret: RedactedSecret;
  readonly #product: string;
  readonly #normalizedOrigin: string;
  readonly #audience: string;
  readonly #scheme: string;
  readonly #fingerprint: string;
  #invalidated = false;

  constructor(options: StaticApiKeyCredentialProviderOptions) {
    const key = resolveKey(options);
    this.#secret = new RedactedSecret(key);
    this.#product = options.product;
    this.#normalizedOrigin = options.normalizedOrigin;
    this.#audience = options.audience;
    this.#scheme = options.scheme ?? "X-API-Key";
    this.#fingerprint = fingerprintOf(options.product, key);
  }

  /** Non-secret stable provider identity, safe to log. */
  identity(): string {
    return `static-api-key:${this.#product}:${this.#fingerprint}`;
  }

  async describeAuthority(
    request: CredentialRequest,
  ): Promise<CredentialAuthority> {
    this.assertMatch(request);
    return this.authority();
  }

  async acquire(request: CredentialRequest): Promise<Credential> {
    this.assertMatch(request);
    if (this.#invalidated) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} has been invalidated`,
        { product: this.#product },
      );
    }
    return {
      scheme: this.#scheme,
      secret: this.#secret,
      audience: this.#audience,
      source: this.identity(),
      authority: this.authority(),
    };
  }

  async invalidate(_reason: string): Promise<void> {
    this.#invalidated = true;
  }

  private authority(): CredentialAuthority {
    return {
      providerFingerprint: this.#fingerprint,
      product: this.#product,
      normalizedOrigin: this.#normalizedOrigin,
      audience: this.#audience,
    };
  }

  /**
   * Fail-closed match check (ADR-0022 §D1/§D3). Exact string equality only
   * — no wildcard origin, suffix matching, or DNS-parent trust.
   */
  private assertMatch(request: CredentialRequest): void {
    if (request.product !== this.#product) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} is bound to product ` +
          `"${this.#product}", refusing request for product ` +
          `"${request.product}"`,
        { product: this.#product, operation: request.operation },
      );
    }
    if (request.normalizedOrigin !== this.#normalizedOrigin) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} is bound to origin ` +
          `"${this.#normalizedOrigin}", refusing request for origin ` +
          `"${request.normalizedOrigin}" (ADR-0022 §D3: a redirect to ` +
          "another origin is not followed with credentials)",
        { product: this.#product, operation: request.operation },
      );
    }
    if (request.audience !== this.#audience) {
      throw new AgenticError(
        "authentication",
        `credential provider ${this.identity()} is bound to audience ` +
          `"${this.#audience}", refusing request for audience ` +
          `"${request.audience}"`,
        { product: this.#product, operation: request.operation },
      );
    }
  }
}
